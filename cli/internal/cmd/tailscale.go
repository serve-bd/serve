package cmd

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Tailscale: servers the instance reaches through a tailnet. Root admins only, like the dashboard.

func (a *App) tailnets(ctx context.Context) ([]api.Tailnet, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var r struct{ Tailnets []api.Tailnet }
	if err := c.Get(ctx, "/tailscale/tailnets", nil, &r); err != nil {
		return nil, rootOnly(err, "Tailscale")
	}
	return r.Tailnets, nil
}

// rootOnly explains a 403 of a Root admin route.
func rootOnly(err error, what string) error {
	if api.IsStatus(err, 403) {
		return fmt.Errorf("only admins of the Root organization manage %s, with a token that has the admin permission (%v)", what, err)
	}
	return err
}

// tailnetID resolves --tailnet (a name or id); empty leaves the choice to the server (the only tailnet).
func (a *App) tailnetID(ctx context.Context, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	list, err := a.tailnets(ctx)
	if err != nil {
		return "", err
	}
	for _, t := range list {
		if t.ID == ref || strings.EqualFold(t.Name, ref) || strings.EqualFold(t.Tailnet, ref) {
			return t.ID, nil
		}
	}
	return "", fmt.Errorf("there is no tailnet %q. See `serve tailscale ls`", ref)
}

func (a *App) tailscaleCmd() *cobra.Command {
	cmd := lsCmd("tailscale", "List tailnets and the servers in them", []string{"ts"}, func(cmd *cobra.Command, asJSON bool) error {
		list, err := a.tailnets(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			ui.Info("No tailnet is connected. Connect one in the dashboard: Integrations, Tailscale.")
			return nil
		}
		var rows [][]string
		for _, t := range list {
			state := ui.StatusColor("ready")
			if t.Error != nil && *t.Error != "" {
				state = ui.StatusColor("error")
			}
			if len(t.Servers) == 0 {
				rows = append(rows, []string{t.Name, state, "", "", ""})
			}
			for i, s := range t.Servers {
				name := ""
				if i == 0 {
					name = t.Name
				}
				online := "offline"
				if s.Online == nil {
					online = "not joined"
				} else if *s.Online {
					online = "online"
				}
				rows = append(rows, []string{name, state, s.Name, deref(s.Address), online})
			}
		}
		ui.Table([]string{"TAILNET", "STATE", "SERVER", "ADDRESS", ""}, rows)
		for _, t := range list {
			if t.Error != nil && *t.Error != "" {
				ui.Warn("%s: %s", t.Name, *t.Error)
			}
		}
		return nil
	})
	cmd.Short = "Tailscale: list tailnets, put servers in them or take them out"
	cmd.Long = `List the connected tailnets and the servers in each. Servers join the instance's
tailnet, so this is for admins of the Root organization (a token with the admin permission).`
	cmd.AddCommand(a.tailscaleStatusCmd(), a.tailscaleJoinCmd(), a.tailscaleLeaveCmd())
	return cmd
}

func (a *App) tailscaleStatusCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "status <server>",
		Short:   "Show a server's place in the tailnet",
		Long:    "Show whether a server is in a tailnet: its address there, whether it is online, and a join command that has not run yet.",
		Example: "  serve tailscale status web-1",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			srv, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			var r struct {
				CanJoin   bool                `json:"canJoin"`
				Tailscale *api.TailscaleState `json:"tailscale"`
			}
			if err := a.client.Get(ctx, "/servers/"+api.P(srv.ID)+"/tailscale", nil, &r); err != nil {
				return rootOnly(err, "Tailscale")
			}
			if asJSON {
				return printJSON(r)
			}
			ts := r.Tailscale
			if ts == nil {
				if !r.CanJoin {
					ui.Info("%s belongs to an organization: it is reached at its public address, not through the instance's tailnet.", srv.Name)
				} else {
					ui.Info("%s is not in a tailnet. Add it with `serve tailscale join %s`.", srv.Name, args[0])
				}
				return nil
			}
			state := "joined"
			switch {
			case !ts.Joined && ts.WaitingForJoin:
				state = "waiting for its join command to run (until " + deref(ts.JoinCommandExpiresAt) + ")"
			case !ts.Joined:
				state = "not joined"
			case ts.Online != nil && !*ts.Online:
				state = "offline"
			case ts.Online != nil:
				state = "online"
			}
			pairs := [][2]string{{"Server", srv.Name}, {"Tailnet", deref(ts.Tailnet)}, {"State", state}}
			if ts.Address != nil {
				pairs = append(pairs, [2]string{"Address", *ts.Address})
			}
			if ts.DNSName != nil {
				pairs = append(pairs, [2]string{"Name", *ts.DNSName})
			}
			if ts.Only {
				pairs = append(pairs, [2]string{"Reached", "only through the tailnet"})
			}
			ui.KV(pairs)
			if ts.Error != nil && *ts.Error != "" {
				ui.Warn("%s", *ts.Error)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) tailscaleJoinCmd() *cobra.Command {
	var tailnet, origin string
	var command, force bool
	cmd := &cobra.Command{
		Use:   "join <server>",
		Short: "Put a server in the tailnet",
		Long: `Put a server in the tailnet. Serve installs Tailscale on it and joins it by itself (over
SSH, or through the host for the dashboard's own machine), so the server must be reachable now.

--command prints a join command to run on the server as root instead, for a server Serve
cannot reach (or after it was reinstalled). Until it ran, Serve reaches the server as before.

--tailnet picks the tailnet when several are connected. A server in another tailnet already
is moved only with --force. Root admins only.`,
		Example: "  serve tailscale join web-1\n  serve tailscale join web-1 --command\n  serve tailscale join web-1 --tailnet corp --force",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			srv, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			id, err := a.tailnetID(ctx, tailnet)
			if err != nil {
				return err
			}
			body := map[string]any{}
			if id != "" {
				body["tailnetId"] = id
			}
			if command {
				if origin != "" {
					if u, err := url.Parse(origin); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
						return usagef("--origin is the dashboard address, like https://serve.example.com")
					}
					body["origin"] = strings.TrimRight(origin, "/")
				}
				var r struct {
					Command   string `json:"command"`
					ExpiresAt string `json:"expiresAt"`
				}
				if err := a.client.Post(ctx, "/servers/"+api.P(srv.ID)+"/tailscale/join-command", body, &r); err != nil {
					return rootOnly(err, "Tailscale")
				}
				ui.Info("Run this on %s as root%s. Until it ran, Serve reaches the server as before.", ui.Bold(srv.Name), untilText(r.ExpiresAt))
				fmt.Fprintln(ui.Out, r.Command)
				return nil
			}
			if force {
				body["force"] = true
			}
			sp := ui.StartSpinner(fmt.Sprintf("Putting %s in the tailnet (this installs Tailscale there)", srv.Name))
			var r struct {
				Address    *string `json:"address"`
				MoveNeeded bool    `json:"moveNeeded"`
				Message    string  `json:"message"`
			}
			err = a.client.Post(ctx, "/servers/"+api.P(srv.ID)+"/tailscale/connect", body, &r)
			sp.Stop()
			if err != nil {
				err = rootOnly(err, "Tailscale")
				if strings.Contains(err.Error(), "not reachable") {
					return fmt.Errorf("%v\nPrint a command to run on it instead: serve tailscale join %s --command", err, args[0])
				}
				return err
			}
			if r.MoveNeeded {
				return fmt.Errorf("%s. Pass --force to move it to this tailnet", strings.TrimRight(r.Message, "."))
			}
			ui.Success("%s is in the tailnet at %s.", srv.Name, deref(r.Address))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&tailnet, "tailnet", "", "the tailnet (`name` or id) when several are connected")
	f.BoolVar(&command, "command", false, "print a join command to run on the server instead")
	f.StringVar(&origin, "origin", "", "with --command: the dashboard `address` the server calls (this instance's address by default)")
	f.BoolVar(&force, "force", false, "move a server that is in another tailnet")
	return cmd
}

func untilText(expires string) string {
	if expires == "" {
		return ""
	}
	return " (it works until " + expires + ")"
}

func (a *App) tailscaleLeaveCmd() *cobra.Command {
	var removeDevice, yes bool
	cmd := &cobra.Command{
		Use:   "leave <server>",
		Short: "Stop reaching a server through the tailnet",
		Long: `Serve stops using the tailnet for a server and reaches it as before (its address or its
tunnel). --remove-device also takes the machine out of the tailnet. A server that was added
through Tailscale has no other address: remove the server instead. Root admins only.`,
		Example: "  serve tailscale leave web-1\n  serve tailscale leave web-1 --remove-device --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			srv, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			if !yes {
				if !ui.Interactive {
					return usagef("this changes how Serve reaches %s: pass --yes when there is no terminal to ask", srv.Name)
				}
				ok, err := ui.Confirm(fmt.Sprintf("Stop reaching %s through the tailnet?", srv.Name), false)
				if err != nil {
					return err
				}
				if !ok {
					return silentExit(ExitError)
				}
			}
			q := url.Values{}
			if removeDevice {
				q.Set("removeDevice", "true")
			}
			if err := a.client.Delete(ctx, "/servers/"+api.P(srv.ID)+"/tailscale", q, nil); err != nil {
				return rootOnly(err, "Tailscale")
			}
			ui.Success("Serve reaches %s as before now, not through the tailnet.", srv.Name)
			return nil
		},
	}
	cmd.Flags().BoolVar(&removeDevice, "remove-device", false, "also take the machine out of the tailnet")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask")
	return cmd
}
