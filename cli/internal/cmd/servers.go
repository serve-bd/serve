package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

var proxyKinds = []string{"nginx", "caddy", "traefik"}

// findServer takes a server's id or name.
func (a *App) findServer(ctx context.Context, ref string) (*api.Server, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	list, err := c.Servers(ctx)
	if err != nil {
		return nil, needs(err, "the View projects permission (projects.view)")
	}
	var found []api.Server
	for _, s := range list {
		if s.ID == ref {
			return &s, nil
		}
		if strings.EqualFold(s.Name, ref) {
			found = append(found, s)
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("no server named %q. See `serve servers`", ref)
	case 1:
		return &found[0], nil
	}
	ids := make([]string, len(found))
	for i, s := range found {
		ids[i] = s.ID
	}
	return nil, fmt.Errorf("%d servers are named %q: use the id (%s)", len(found), ref, strings.Join(ids, ", "))
}

func (a *App) serverDetails(ctx context.Context, id string) (*api.ServerDetails, json.RawMessage, error) {
	var s api.ServerDetails
	raw, err := a.client.GetRaw(ctx, "/servers/"+api.P(id), "server", &s)
	if err != nil {
		return nil, nil, needs(err, "the View projects permission (projects.view)")
	}
	return &s, raw, nil
}

// serverRef resolves the server argument and loads its details.
func (a *App) serverRef(ctx context.Context, ref string) (*api.ServerDetails, json.RawMessage, error) {
	s, err := a.findServer(ctx, ref)
	if err != nil {
		return nil, nil, err
	}
	return a.serverDetails(ctx, s.ID)
}

// serverSubcommands are added to `serve servers` (lists.go).
func (a *App) serverSubcommands() []*cobra.Command {
	return []*cobra.Command{
		a.serverShowCmd(), a.serverAddCmd(), a.serverValidateCmd(), a.serverRmCmd(), a.serverCleanupCmd(),
		a.serverAlertsCmd(), a.serverProxyCmd(), a.serverProxyLogsCmd(), a.serverResetHostKeyCmd(),
	}
}

func (a *App) serverShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:         "show <server>",
		Annotations: printsJSON,
		Aliases:     []string{"info"},
		Short:       "Show a server: its connection, status, proxy and services",
		Long:        "Show a server by name or id: how Serve reaches it, its status, its proxy, its resource alerts and the services that run on it.",
		Example:     "  serve servers show eu-1\n  serve servers show eu-1 --json",
		Args:        exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, raw, err := a.serverRef(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			if jsonFlag(cmd) {
				return printJSON(raw)
			}
			status := ui.StatusColor(s.Status)
			if m := deref(s.StatusMessage); m != "" {
				status += "  " + ui.OutDim(m)
			}
			host := "this machine"
			if !s.IsLocal {
				host = deref(s.Host)
				if u := deref(s.Username); u != "" {
					host = u + "@" + host
				}
				if s.Port != nil && *s.Port != 22 {
					host += ":" + strconv.Itoa(*s.Port)
				}
			}
			proxy := deref(s.ProxyKind)
			if proxy != "" && proxy != "none" {
				var ports []string
				if s.ProxyHTTPPort != nil {
					ports = append(ports, "HTTP "+portText(*s.ProxyHTTPPort))
				}
				if s.ProxyHTTPSPort != nil {
					ports = append(ports, "HTTPS "+portText(*s.ProxyHTTPSPort))
				}
				if len(ports) > 0 {
					proxy += " (" + strings.Join(ports, ", ") + ")"
				}
				if s.ProxyStopped {
					proxy += ", stopped"
				}
			}
			metrics := "off"
			if s.MetricsEnabled {
				metrics = "on"
			}
			lastSeen := ""
			if s.LastSeenAt != nil {
				lastSeen = ui.Ago(*s.LastSeenAt)
			}
			alerts := ""
			if al := s.Alerts; al != nil {
				if al.Enabled {
					alerts = fmt.Sprintf("CPU %d%% for %dm, memory %d%%, disk %d%% (critical %d%%)", al.CPU, al.CPUMinutes, al.Memory, al.DiskWarn, al.DiskCritical)
				} else {
					alerts = "off"
				}
			}
			ui.KV([][2]string{
				{"Name", ui.OutBold(s.Name)},
				{"ID", s.ID},
				{"Description", deref(s.Description)},
				{"Status", status},
				{"Host", host},
				{"Public IP", deref(s.PublicIP)},
				{"Wildcard", deref(s.WildcardDomain)},
				{"Proxy", proxy},
				{"Metrics", metrics},
				{"Alerts", alerts},
				{"Last seen", lastSeen},
				{"Added", ui.Ago(s.CreatedAt)},
			})
			if len(s.Services) > 0 {
				fmt.Fprintln(ui.Out)
				var rows [][]string
				for _, svc := range s.Services {
					rows = append(rows, []string{svc.Name, svc.Type, ui.StatusColor(svc.Status), svc.ID})
				}
				ui.Table([]string{"SERVICE", "TYPE", "STATUS", "ID"}, rows)
			}
			return nil
		},
	}
}

func portText(p int) string {
	if p == 0 {
		return "no port"
	}
	return strconv.Itoa(p)
}

// waitServerSetup follows a server's setup until it is ready or failed.
func (a *App) waitServerSetup(ctx context.Context, id, name string) error {
	sp := ui.StartSpinner("Setting up " + name + "...")
	defer sp.Stop()
	shown := 0
	lastMsg := ""
	for {
		if err := sleepCtx(ctx, adminPoll); err != nil {
			return err
		}
		s, _, err := a.serverDetails(ctx, id)
		if err != nil {
			return err
		}
		// Newer dashboards send the setup log: print its new lines. Older ones only the message.
		if s.SetupLog != nil {
			if log := *s.SetupLog; len(log) >= shown {
				if lines := strings.TrimRight(log[shown:], "\n"); strings.Contains(log[shown:], "\n") {
					sp.Stop()
					for _, l := range strings.Split(lines, "\n") {
						ui.Line(ui.Dim(ui.SanitizeLine(l, false)))
					}
					shown += strings.LastIndex(log[shown:], "\n") + 1
					sp = ui.StartSpinner("Setting up " + name + "...")
				}
			} else {
				shown = 0
			}
		}
		msg := deref(s.StatusMessage)
		if s.Status == "validating" || s.Status == "pending" {
			if msg != "" && msg != lastMsg {
				lastMsg = msg
				sp.Update(name + ": " + msg)
				if !ui.Animated() {
					ui.Line(ui.Dim(name + ": " + msg))
				}
			}
			continue
		}
		sp.Stop()
		if s.Status == "ready" {
			if msg != "" {
				ui.Warn("%s is ready, with a note: %s", name, msg)
			} else {
				ui.Success("%s is ready.", ui.Bold(name))
			}
			return nil
		}
		if msg == "" {
			msg = "the setup failed"
		}
		hint := ""
		switch {
		case strings.Contains(strings.ToLower(msg), "docker is not installed"):
			hint = fmt.Sprintf(". Run `serve servers validate %s --install-docker` to install it", name)
		case strings.Contains(strings.ToLower(msg), "host key"):
			hint = fmt.Sprintf(". If the server was reinstalled, run `serve servers reset-host-key %s`", name)
		case strings.Contains(strings.ToLower(msg), "auth"):
			hint = ". Is the SSH key's public key in ~/.ssh/authorized_keys of that user? See `serve ssh-keys`"
		}
		return fmt.Errorf("%s is %s: %s%s", name, s.Status, strings.TrimRight(msg, "."), hint)
	}
}

func (a *App) startValidate(ctx context.Context, id string, installDocker bool) error {
	body := map[string]any{}
	if installDocker {
		body["installDocker"] = true
	}
	return needs(a.client.Post(ctx, "/servers/"+api.P(id)+"/validate", body, nil), needServerAdmin)
}

func (a *App) serverAddCmd() *cobra.Command {
	var host, user, key, name, description string
	var port int
	var wait, installDocker bool
	cmd := &cobra.Command{
		Use:         "add --host <address>",
		Annotations: printsJSON,
		Short:       "Add a server over SSH and set it up",
		Long: `Add a server Serve reaches over SSH, then set it up: Serve connects, checks Docker and
starts its proxy there. Put the SSH key's public key in ~/.ssh/authorized_keys of --user on
the server first (` + "`serve ssh-keys add <name>`" + ` prints it).

--key is the SSH key's name; with a single key it can be left out. --wait follows the setup
until the server is ready. --install-docker installs Docker when it is missing.`,
		Example: "  serve servers add --host 203.0.113.10 --key deploy --wait\n  serve servers add --host eu1.example.com --user ubuntu --port 2222 --name eu-1 --key deploy",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if host == "" {
				return usagef("pass the server's address with --host")
			}
			if port < 1 || port > 65535 {
				return usagef("--port must be between 1 and 65535")
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			keyID, err := a.pickSSHKey(ctx, key)
			if err != nil {
				return err
			}
			if name == "" {
				name = host
			}
			body := map[string]any{"name": name, "host": host, "port": port, "username": user, "privateKeyId": keyID}
			if description != "" {
				body["description"] = description
			}
			var r struct{ ID string }
			if err := c.Post(ctx, "/servers", body, &r); err != nil {
				return needs(err, needServerAdmin)
			}
			ui.Success("Added %s.", ui.Bold(name))
			if err := a.startValidate(ctx, r.ID, installDocker); err != nil {
				return fmt.Errorf("the server was added, but its setup did not start: %w. Run `serve servers validate %s`", err, name)
			}
			if !wait {
				if jsonFlag(cmd) {
					return printJSON(r)
				}
				ui.Info("Setting it up. Follow it with `serve servers show %s`, or run `serve servers validate %s --wait`.", name, name)
				return nil
			}
			if err := a.waitServerSetup(ctx, r.ID, name); err != nil {
				return err
			}
			if jsonFlag(cmd) {
				return printJSON(r)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&host, "host", "", "the server's IP address or host name")
	f.StringVarP(&user, "user", "u", "root", "the SSH user")
	f.IntVar(&port, "port", 22, "the SSH port")
	f.StringVarP(&key, "key", "k", "", "the SSH key (`name` or id) Serve connects with")
	f.StringVar(&name, "name", "", "the server's name in Serve (the host by default)")
	f.StringVar(&description, "description", "", "a note about the server")
	f.BoolVarP(&wait, "wait", "w", false, "wait until the setup ends")
	f.BoolVar(&installDocker, "install-docker", false, "install Docker if it is missing")
	return cmd
}

// pickSSHKey answers the key to add a server with: the named one, the only one, or a choice.
func (a *App) pickSSHKey(ctx context.Context, ref string) (string, error) {
	if ref != "" {
		k, err := a.findSSHKey(ctx, ref)
		if err != nil {
			return "", err
		}
		return k.ID, nil
	}
	var keys []api.SSHKey
	if _, err := a.client.GetRaw(ctx, "/ssh-keys", "keys", &keys); err != nil {
		return "", needs(err, needServerAdmin)
	}
	switch len(keys) {
	case 0:
		return "", errors.New("there is no SSH key yet. Add one with `serve ssh-keys add <name>`, put its public key on the server, then pass --key <name>")
	case 1:
		return keys[0].ID, nil
	}
	opts := make([]ui.Option, len(keys))
	for i, k := range keys {
		opts[i] = ui.Option{Label: k.Name + "  " + k.Fingerprint, Value: k.ID}
	}
	id, err := ui.Select("Which SSH key?", opts)
	return id, needChoice(err, "there are several SSH keys: pass --key <name>")
}

func (a *App) serverValidateCmd() *cobra.Command {
	var wait, installDocker bool
	cmd := &cobra.Command{
		Use:     "validate <server>",
		Aliases: []string{"setup"},
		Short:   "Check a server and set it up again",
		Long: `Connect to a server, check Docker and set it up again (its proxy and helpers). Use it
after fixing what made the setup fail. --install-docker installs Docker when it is missing.
--wait follows the setup until it ends.`,
		Example: "  serve servers validate eu-1 --wait\n  serve servers validate eu-1 --install-docker --wait",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			if s.IsLocal {
				return fmt.Errorf("%s is the machine the dashboard runs on: it is always connected", s.Name)
			}
			if err := a.startValidate(ctx, s.ID, installDocker); err != nil {
				return err
			}
			if !wait {
				ui.Info("Setting up %s. Follow it with `serve servers show %s`.", s.Name, s.Name)
				return nil
			}
			return a.waitServerSetup(ctx, s.ID, s.Name)
		},
	}
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the setup ends")
	cmd.Flags().BoolVar(&installDocker, "install-docker", false, "install Docker if it is missing")
	return cmd
}

func (a *App) serverRmCmd() *cobra.Command {
	var yes, stop, keep, deleteData, keepProxy, keepTunnels, removeDevice bool
	cmd := &cobra.Command{
		Use:     "rm <server>",
		Aliases: []string{"delete", "remove"},
		Short:   "Remove a server from Serve",
		Long: `Remove a server. Serve forgets it and removes its own containers there (the proxy, the
private network and the log collector). Your files and other containers stay.

When services run on it, say what happens to them (or choose when asked):
  --stop-services   stop and delete them (their containers, domains and DNS records);
                    --delete-data also deletes their data volumes
  --keep-services   keep them running; Serve only forgets them. Serve's proxy and the
                    server's Cloudflare tunnels go too, unless --keep-proxy / --keep-tunnels

Asks for the server's name unless you pass --yes.`,
		Example: "  serve servers rm old-box\n  serve servers rm old-box --stop-services --delete-data --yes\n  serve servers rm old-box --keep-services --keep-proxy",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if stop && keep {
				return usagef("choose one: --stop-services or --keep-services")
			}
			if deleteData && keep {
				return usagef("--delete-data goes with --stop-services: kept services keep their data")
			}
			if (keepProxy || keepTunnels) && stop {
				return usagef("--keep-proxy and --keep-tunnels go with --keep-services")
			}
			found, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			if found.IsLocal {
				return fmt.Errorf("%s is the machine the dashboard runs on: it cannot be removed", found.Name)
			}
			s, _, err := a.serverDetails(ctx, found.ID)
			if err != nil {
				return err
			}
			q := url.Values{}
			if n := len(s.Services); n > 0 {
				names := make([]string, n)
				for i, svc := range s.Services {
					names[i] = svc.Name
				}
				ui.Warn("%d service(s) run on %s: %s.", n, s.Name, strings.Join(names, ", "))
				choice := ""
				switch {
				case stop:
					choice = "stop"
				case keep:
					choice = "keep"
				default:
					if deleteData {
						choice = "stop"
					} else if keepProxy || keepTunnels {
						choice = "keep"
					} else {
						choice, err = ui.Select("What happens to them?", []ui.Option{
							{Label: "Stop and delete them (containers, domains, DNS records; data stays)", Value: "stop"},
							{Label: "Stop and delete them, with their data", Value: "stop-data"},
							{Label: "Keep them running (Serve forgets them; its proxy goes too)", Value: "keep"},
							{Label: "Keep them running, with Serve's proxy", Value: "keep-proxy"},
						})
						if err != nil {
							return needChoice(err, "services run on this server: pass --stop-services or --keep-services")
						}
						switch choice {
						case "stop-data":
							choice, deleteData = "stop", true
						case "keep-proxy":
							choice, keepProxy = "keep", true
						}
					}
				}
				q.Set("services", choice)
				if choice == "stop" {
					q.Set("removeData", strconv.FormatBool(deleteData))
				} else {
					q.Set("removeProxy", strconv.FormatBool(!keepProxy))
					q.Set("removeTunnels", strconv.FormatBool(!keepTunnels))
				}
			} else if stop || keep || deleteData || keepProxy || keepTunnels {
				ui.Info("No services run on %s.", s.Name)
			}
			if removeDevice {
				q.Set("removeTailnetDevice", "true")
			}
			if err := confirmName("a server", s.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/servers/"+api.P(s.ID), q, nil); err != nil {
				// A dashboard from before the API took the choice refuses whatever was chosen.
				if q.Get("services") != "" && strings.Contains(err.Error(), "Choose whether to stop them") {
					return fmt.Errorf("this dashboard cannot remove a server with services through the API yet. Update Serve, or remove %s in the dashboard", s.Name)
				}
				return needs(err, needServerAdmin)
			}
			ui.Success("Removed %s.", ui.Bold(s.Name))
			return nil
		},
	}
	f := cmd.Flags()
	f.BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	f.BoolVar(&stop, "stop-services", false, "stop and delete the services that run there")
	f.BoolVar(&keep, "keep-services", false, "keep the services running; Serve only forgets them")
	f.BoolVar(&deleteData, "delete-data", false, "with --stop-services: also delete their data volumes")
	f.BoolVar(&keepProxy, "keep-proxy", false, "with --keep-services: leave Serve's proxy running so their domains keep answering")
	f.BoolVar(&keepTunnels, "keep-tunnels", false, "with --keep-services: leave the server's Cloudflare tunnels in place")
	f.BoolVar(&removeDevice, "remove-tailnet-device", false, "also remove the machine from the tailnet it joined through Serve")
	return cmd
}

func (a *App) serverCleanupCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "cleanup <server>",
		Short:   "Free disk space: remove unused images, build cache and stopped containers",
		Long:    "Clean up Docker on a server: remove unused images, build cache and the stopped containers Serve no longer needs. It runs in the background.",
		Example: "  serve servers cleanup eu-1",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/servers/"+api.P(s.ID)+"/cleanup", nil, nil); err != nil {
				return needs(err, needServerAdmin)
			}
			ui.Success("Started cleaning up Docker on %s.", ui.Bold(s.Name))
			return nil
		},
	}
}

var defaultAlerts = api.ServerAlerts{Enabled: true, DiskWarn: 85, DiskCritical: 95, Memory: 90, CPU: 90, CPUMinutes: 10}

func (a *App) serverAlertsCmd() *cobra.Command {
	var cpu, cpuMinutes, memory, disk, diskCritical int
	var on, off bool
	cmd := &cobra.Command{
		Use:         "alerts <server>",
		Annotations: printsJSON,
		Short:       "Show or set when a server's CPU, memory or disk use sends an alert",
		Long: `Show or set a server's resource alerts. The values are percentages (50 to 100): an alert
goes out when CPU stays above --cpu for --cpu-minutes, memory is above --memory, or the disk is
above --disk (a warning) or --disk-critical. Values you leave out keep what they are.
--off turns the alerts off, --on back on.`,
		Example: "  serve servers alerts eu-1\n  serve servers alerts eu-1 --cpu 85 --memory 90 --disk 80\n  serve servers alerts eu-1 --off",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if on && off {
				return usagef("choose one: --on or --off")
			}
			s, _, err := a.serverRef(ctx, args[0])
			if err != nil {
				return err
			}
			f := cmd.Flags()
			changed := map[string]bool{}
			for _, n := range []string{"cpu", "cpu-minutes", "memory", "disk", "disk-critical"} {
				changed[n] = f.Changed(n)
			}
			anyChange := on || off
			for _, v := range changed {
				anyChange = anyChange || v
			}
			if !anyChange {
				if s.Alerts == nil {
					return errors.New("this dashboard does not tell the current alerts. Update Serve, or set every value: --cpu, --cpu-minutes, --memory, --disk and --disk-critical")
				}
				if jsonFlag(cmd) {
					return printJSON(s.Alerts)
				}
				printAlerts(*s.Alerts)
				return nil
			}
			al := defaultAlerts
			if s.Alerts != nil {
				al = *s.Alerts
			} else {
				// Without the current values a partial change would reset the others.
				var missing []string
				for _, n := range []string{"cpu", "cpu-minutes", "memory", "disk", "disk-critical"} {
					if !changed[n] {
						missing = append(missing, "--"+n)
					}
				}
				if len(missing) > 0 && !off {
					return usagef("this dashboard does not tell the current alerts, so pass every value (missing %s), or update Serve", strings.Join(missing, ", "))
				}
			}
			if changed["cpu"] {
				al.CPU = cpu
			}
			if changed["cpu-minutes"] {
				al.CPUMinutes = cpuMinutes
			}
			if changed["memory"] {
				al.Memory = memory
			}
			if changed["disk"] {
				al.DiskWarn = disk
			}
			if changed["disk-critical"] {
				al.DiskCritical = diskCritical
			}
			switch {
			case off:
				al.Enabled = false
			case on || s.Alerts == nil:
				al.Enabled = true
			}
			for _, v := range []struct {
				name string
				n    int
			}{{"--cpu", al.CPU}, {"--memory", al.Memory}, {"--disk", al.DiskWarn}, {"--disk-critical", al.DiskCritical}} {
				if v.n < 50 || v.n > 100 {
					return usagef("%s must be a percentage from 50 to 100", v.name)
				}
			}
			if al.CPUMinutes < 1 || al.CPUMinutes > 60 {
				return usagef("--cpu-minutes must be from 1 to 60")
			}
			if al.DiskCritical < al.DiskWarn {
				return usagef("--disk-critical (%d%%) must be at or above --disk (%d%%)", al.DiskCritical, al.DiskWarn)
			}
			if err := a.client.Do(ctx, api.Request{Method: "PUT", Path: "/servers/" + api.P(s.ID) + "/alerts", JSON: al}, nil); err != nil {
				return needs(err, needServerAdmin)
			}
			if !al.Enabled {
				ui.Success("Resource alerts of %s are off.", ui.Bold(s.Name))
				return nil
			}
			ui.Success("Saved the resource alerts of %s.", ui.Bold(s.Name))
			printAlerts(al)
			return nil
		},
	}
	f := cmd.Flags()
	f.IntVar(&cpu, "cpu", 0, "alert when CPU use stays above this `percent`")
	f.IntVar(&cpuMinutes, "cpu-minutes", 0, "for this many `minutes`")
	f.IntVar(&memory, "memory", 0, "alert when memory use is above this `percent`")
	f.IntVar(&disk, "disk", 0, "warn when the disk is fuller than this `percent`")
	f.IntVar(&diskCritical, "disk-critical", 0, "a critical alert when the disk is fuller than this `percent`")
	f.BoolVar(&on, "on", false, "turn the alerts on")
	f.BoolVar(&off, "off", false, "turn the alerts off")
	return cmd
}

func printAlerts(al api.ServerAlerts) {
	if !al.Enabled {
		ui.KV([][2]string{{"Alerts", "off"}})
		return
	}
	ui.KV([][2]string{
		{"CPU", fmt.Sprintf("above %d%% for %d minutes", al.CPU, al.CPUMinutes)},
		{"Memory", fmt.Sprintf("above %d%%", al.Memory)},
		{"Disk", fmt.Sprintf("above %d%% (critical above %d%%)", al.DiskWarn, al.DiskCritical)},
	})
}

func (a *App) serverProxyCmd() *cobra.Command {
	var yes, wait bool
	cmd := &cobra.Command{
		Use:         "proxy <server> [nginx|caddy|traefik]",
		Annotations: printsJSON,
		Short:       "Show a server's proxy, or switch it to another one",
		Long: `Without a kind, show which proxy a server runs. With one, switch to it: Serve moves the
domains and certificates over, and the sites on the server may answer with errors for a
moment. Asks first unless --yes. --wait follows the switch until it ends.`,
		Example:   "  serve servers proxy eu-1\n  serve servers proxy eu-1 caddy --wait",
		Args:      rangeArgs(1, 2),
		ValidArgs: proxyKinds,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, _, err := a.serverRef(ctx, args[0])
			if err != nil {
				return err
			}
			current := deref(s.ProxyKind)
			if len(args) == 1 {
				if jsonFlag(cmd) {
					return printJSON(map[string]any{"kind": current, "stopped": s.ProxyStopped, "switch": s.ProxySwitch})
				}
				pairs := [][2]string{{"Proxy", orName(current, "none")}}
				if s.ProxyStopped {
					pairs = append(pairs, [2]string{"State", "stopped"})
				}
				if sw := s.ProxySwitch; sw != nil && sw.State == "running" {
					pairs = append(pairs, [2]string{"Switching", sw.From + " to " + sw.To})
				}
				ui.KV(pairs)
				return nil
			}
			kind := strings.ToLower(args[1])
			valid := false
			for _, k := range proxyKinds {
				valid = valid || k == kind
			}
			if !valid {
				return usagef("the proxy must be one of %s", strings.Join(proxyKinds, ", "))
			}
			if kind == current {
				ui.Info("%s already runs %s.", s.Name, kind)
				return nil
			}
			if err := confirmAction(fmt.Sprintf("Switch %s from %s to %s? Its sites may answer with errors for a moment.", s.Name, orName(current, "no proxy"), kind), yes); err != nil {
				return err
			}
			if err := a.client.Do(ctx, api.Request{Method: "PUT", Path: "/servers/" + api.P(s.ID) + "/proxy/kind", JSON: map[string]any{"kind": kind}}, nil); err != nil {
				return needs(err, needServerAdmin)
			}
			ui.Info("Switching %s to %s.", s.Name, kind)
			if !wait {
				ui.Info("Check it with `serve servers proxy %s`.", s.Name)
				return nil
			}
			return a.waitProxySwitch(ctx, s.ID, s.Name, kind)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the switch ends")
	return cmd
}

func (a *App) waitProxySwitch(ctx context.Context, id, name, kind string) error {
	sp := ui.StartSpinner("Switching the proxy of " + name + "...")
	defer sp.Stop()
	shown := 0
	for {
		if err := sleepCtx(ctx, adminPoll); err != nil {
			return err
		}
		s, _, err := a.serverDetails(ctx, id)
		if err != nil {
			return err
		}
		sw := s.ProxySwitch
		if sw == nil {
			// An older dashboard: only the kind tells that the switch is done.
			if deref(s.ProxyKind) == kind {
				sp.Stop()
				ui.Success("%s runs %s.", ui.Bold(name), kind)
				return nil
			}
			continue
		}
		if len(sw.Log) > shown && strings.Contains(sw.Log[shown:], "\n") {
			sp.Stop()
			end := shown + strings.LastIndex(sw.Log[shown:], "\n")
			for _, l := range strings.Split(sw.Log[shown:end], "\n") {
				ui.Line(ui.Dim(ui.SanitizeLine(l, false)))
			}
			shown = end + 1
			sp = ui.StartSpinner("Switching the proxy of " + name + "...")
		}
		switch sw.State {
		case "running":
			continue
		case "success", "done":
			sp.Stop()
			ui.Success("%s runs %s.", ui.Bold(name), kind)
			return nil
		}
		sp.Stop()
		return fmt.Errorf("the switch to %s did not finish (%s). %s still runs %s", kind, sw.State, name, orName(deref(s.ProxyKind), "no proxy"))
	}
}

func (a *App) serverProxyLogsCmd() *cobra.Command {
	return &cobra.Command{
		Use:         "proxy-logs <server>",
		Annotations: printsJSON,
		Short:       "Show the recent logs of a server's proxy",
		Long:        "Show the last 300 lines of a server's proxy logs.",
		Example:     "  serve servers proxy-logs eu-1\n  serve servers proxy-logs eu-1 | grep 502",
		Args:        exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			var lines []struct {
				Time string `json:"time"`
				Text string `json:"text"`
			}
			raw, err := a.client.GetRaw(ctx, "/servers/"+api.P(s.ID)+"/proxy/logs", "logs", &lines)
			if err != nil {
				return needs(err, needServerAdmin)
			}
			if jsonFlag(cmd) {
				return printJSON(raw)
			}
			if len(lines) == 0 {
				ui.Info("The proxy of %s has no logs yet.", s.Name)
				return nil
			}
			color := ui.ColorOut()
			for _, l := range lines {
				text := ui.SanitizeLine(l.Text, color)
				if l.Time != "" {
					text = ui.OutDim(l.Time) + " " + text
				}
				fmt.Fprintln(ui.Out, text)
			}
			return nil
		},
	}
}

func (a *App) serverResetHostKeyCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "reset-host-key <server>",
		Short: "Forget a server's SSH host key (after reinstalling it)",
		Long: `Forget the SSH host key Serve saved for a server. Do this only after the server was
reinstalled or its SSH keys changed: Serve sets the server up again and saves the new key.
Asks first unless --yes.`,
		Example: "  serve servers reset-host-key eu-1",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			if err := confirmAction(fmt.Sprintf("Forget the SSH host key of %s? Only do this if you reinstalled it.", s.Name), yes); err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/servers/"+api.P(s.ID)+"/reset-host-key", nil, nil); err != nil {
				return needs(err, needServerAdmin)
			}
			ui.Success("Forgot the host key of %s. Serve is setting it up again and saves the new key.", ui.Bold(s.Name))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	return cmd
}

func rangeArgs(lo, hi int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < lo || len(args) > hi {
			return usagef("%s needs %d to %d argument(s), got %d", cmd.CommandPath(), lo, hi, len(args))
		}
		return nil
	}
}
