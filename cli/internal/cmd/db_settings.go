package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// findReplica finds a replica of the database by its id, or its server's name or id.
func (a *App) findReplica(ctx context.Context, s *api.Service, ref string) (*api.Replica, map[string]string, error) {
	list, err := a.client.Replicas(ctx, s.ID)
	if err != nil {
		return nil, nil, err
	}
	servers := a.serverNames(ctx)
	var match []api.Replica
	for _, r := range list {
		if r.ID == ref {
			match = []api.Replica{r}
			break
		}
		if strings.EqualFold(servers[r.ServerID], ref) || r.ServerID == ref {
			match = append(match, r)
		}
	}
	switch len(match) {
	case 0:
		return nil, nil, fmt.Errorf("%s has no replica %q. See `serve db replicas -s %s`", s.Name, ref, s.Name)
	case 1:
		return &match[0], servers, nil
	}
	return nil, nil, fmt.Errorf("%s has %d replicas on %s. Name the replica by its id", s.Name, len(match), ref)
}

// setReplicas sends the whole list of replicas (the API replaces it): the ones to keep by id and
// server, new ones by server only. keep reads the current list just before, so a replica added
// meanwhile elsewhere is kept.
func (a *App) setReplicas(ctx context.Context, s *api.Service, keep func(api.Replica) bool, add []string) error {
	list, err := a.client.Replicas(ctx, s.ID)
	if err != nil {
		return err
	}
	body := []map[string]any{}
	for _, r := range list {
		if keep(r) {
			body = append(body, map[string]any{"id": r.ID, "serverId": r.ServerID})
		}
	}
	for _, id := range add {
		body = append(body, map[string]any{"serverId": id})
	}
	return a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+"/database/replicas", map[string]any{"replicas": body}, nil)
}

func (a *App) dbReplicaAddCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "add <server>...",
		Short: "Add read replicas to a database",
		Long: `Add a read replica on each server named (a name or id; a server named twice gets two).
A server must be the database's own, or share a private network with it. A replica copies the
database, then follows it; apps read from READ_DATABASE_URL. MariaDB and MongoDB restart once,
the first time, to be ready for replicas. The database is the linked one, or --service.`,
		Example: "  serve db replicas add eu-2 -s postgres\n  serve db replicas add eu-2 us-1",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			var ids []string
			for _, ref := range args {
				srv, err := a.findServer(ctx, ref)
				if err != nil {
					return err
				}
				ids = append(ids, srv.ID)
			}
			if err := a.setReplicas(ctx, s, func(api.Replica) bool { return true }, ids); err != nil {
				return err
			}
			ui.Success("Added %d read replica(s) to %s. They copy the database first: see `serve db replicas -s %s`.", len(ids), ui.Bold(s.Name), s.Name)
			return nil
		},
	}
}

func (a *App) dbReplicaRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <replica>",
		Aliases: []string{"delete", "remove"},
		Short:   "Remove a read replica and its copy",
		Long: `Remove a read replica and its copy of the data. The replica is its id, or its server's
name. Asks first unless --yes. The database is the linked one, or --service.`,
		Example: "  serve db replicas rm 2 -s postgres\n  serve db replicas rm eu-2 --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			r, servers, err := a.findReplica(ctx, s, args[0])
			if err != nil {
				return err
			}
			where := orName(servers[r.ServerID], r.ServerID)
			if err := confirmYes(fmt.Sprintf("Remove replica %s of %s on %s, with its copy?", r.ID, s.Name, where), "remove the replica", yes); err != nil {
				return err
			}
			if err := a.setReplicas(ctx, s, func(x api.Replica) bool { return x.ID != r.ID }, nil); err != nil {
				return err
			}
			ui.Success("Removed replica %s of %s on %s.", r.ID, ui.Bold(s.Name), where)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	return cmd
}

var dbAuthMethods = []string{"scram-sha-256", "md5", "trust"}

func (a *App) dbConfigCmd() *cobra.Command {
	var image, initdbArgs, authMethod, charset, collation, customConfig, extraArgs, dataPath, tls string
	var apply bool
	cmd := &cobra.Command{
		Use:   "config [database]",
		Short: "Change how a database runs: image, arguments, config file, TLS",
		Long: `Change settings of the database's container. Only the flags you pass change; an empty
value ("") goes back to Serve's default.

  --image           the image to run instead of the engine's (like postgis/postgis:17-3.5)
  --initdb-args     arguments for initdb when the data is first made (PostgreSQL)
  --auth-method     scram-sha-256, md5 or trust (PostgreSQL; trust needs variables.view-secrets)
  --charset         the character set (MySQL, MariaDB)
  --collation       the collation (MySQL, MariaDB)
  --custom-config   a config file for the engine, read from a file (- for standard input)
  --extra-args      more arguments for the server process
  --data-path       where the data volume is mounted in the container
  --tls             off, prefer or require

Most changes take effect when the database restarts: --apply restarts it now, or run
serve db apply later. The database is the linked one, the one named, or --service.`,
		Example: "  serve db config --image postgis/postgis:17-3.5 --apply\n  serve db config mysql --charset utf8mb4 --collation utf8mb4_unicode_ci\n  serve db config --custom-config ./postgresql.conf --apply\n  serve db config --tls require",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			body := map[string]any{}
			fl := cmd.Flags()
			// An empty value is sent as it is: the API stores it as "the default".
			for _, t := range []struct {
				flag, key string
				v         *string
			}{{"image", "image", &image}, {"initdb-args", "initdbArgs", &initdbArgs}, {"charset", "charset", &charset}, {"collation", "collation", &collation}, {"extra-args", "extraArgs", &extraArgs}, {"data-path", "dataMountPath", &dataPath}} {
				if fl.Changed(t.flag) {
					body[t.key] = *t.v
				}
			}
			if fl.Changed("auth-method") {
				switch authMethod {
				case "":
					body["hostAuthMethod"] = nil
				case "scram-sha-256", "md5", "trust":
					body["hostAuthMethod"] = authMethod
				default:
					return usagef("--auth-method is one of %s", strings.Join(dbAuthMethods, ", "))
				}
			}
			if fl.Changed("custom-config") {
				if customConfig == "" {
					body["customConfig"] = ""
				} else {
					var b []byte
					var err error
					if customConfig == "-" {
						b, err = io.ReadAll(os.Stdin)
					} else {
						b, err = os.ReadFile(customConfig)
					}
					if err != nil {
						return fmt.Errorf("could not read the config file: %w", err)
					}
					body["customConfig"] = string(b)
				}
			}
			if fl.Changed("tls") {
				switch tls {
				case "off":
					body["tls"] = nil
				case "prefer", "require":
					body["tls"] = map[string]any{"enabled": true, "mode": tls}
				default:
					return usagef("--tls is off, prefer or require")
				}
			}
			if len(body) == 0 {
				return usagef("pass a setting to change, like --image or --tls (see --help)")
			}
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			if apply {
				body["apply"] = true
			}
			var r struct {
				Restart bool     `json:"restart"`
				Changed []string `json:"changed"`
			}
			if err := a.client.Patch(ctx, "/services/"+api.P(s.ID)+"/database", body, &r); err != nil {
				return err
			}
			switch {
			case apply:
				ui.Success("Saved the settings of %s. It restarts with them.", ui.Bold(s.Name))
			case r.Restart:
				ui.Success("Saved the settings of %s.", ui.Bold(s.Name))
				ui.Line(ui.Dim(fmt.Sprintf("They take effect when it restarts: `serve db apply -s %s`.", s.Name)))
			default:
				ui.Success("Saved the settings of %s.", ui.Bold(s.Name))
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&image, "image", "", "the image to run (\"\": the engine's)")
	f.StringVar(&initdbArgs, "initdb-args", "", "initdb arguments (PostgreSQL)")
	f.StringVar(&authMethod, "auth-method", "", "scram-sha-256, md5 or trust (PostgreSQL)")
	f.StringVar(&charset, "charset", "", "the character set (MySQL, MariaDB)")
	f.StringVar(&collation, "collation", "", "the collation (MySQL, MariaDB)")
	f.StringVar(&customConfig, "custom-config", "", "a config `file` for the engine (- for standard input, \"\" to remove)")
	f.StringVar(&extraArgs, "extra-args", "", "more arguments for the server process")
	f.StringVar(&dataPath, "data-path", "", "where the data volume is mounted")
	f.StringVar(&tls, "tls", "", "off, prefer or require")
	f.BoolVar(&apply, "apply", false, "restart the database with the new settings now")
	return cmd
}

func (a *App) dbApplyCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "apply [database]",
		Short:   "Restart a database with its saved settings",
		Long:    "Restart the database so settings saved without --apply (serve db config, serve db public) take effect. The database is the linked one, the one named, or --service.",
		Example: "  serve db apply\n  serve db apply postgres",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			var r struct {
				ID string `json:"id"`
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/database/apply", nil, &r); err != nil {
				return err
			}
			ui.Success("Restarting %s with its saved settings.", ui.Bold(s.Name))
			if r.ID != "" {
				ui.Line(ui.Dim("Follow it with: serve logs --build " + r.ID + " -f"))
			}
			return nil
		},
	}
}

// dbAccess is what GET /services/{id} tells about a database's public access.
type dbAccess struct {
	PublicPort  *int     `json:"publicPort"`
	PublicBind  *string  `json:"publicBind"`
	PublicAllow []string `json:"publicAllow"`
	Domain      *string  `json:"domain"`
}

func (a *App) dbAccess(ctx context.Context, s *api.Service) (*dbAccess, error) {
	var r struct {
		Service struct {
			Database *dbAccess `json:"database"`
		} `json:"service"`
	}
	if err := a.client.Get(ctx, "/services/"+api.P(s.ID), nil, &r); err != nil {
		return nil, err
	}
	if r.Service.Database == nil {
		return &dbAccess{}, nil
	}
	return r.Service.Database, nil
}

func (a *App) dbPublicCmd() *cobra.Command {
	var port int
	var allow []string
	cmd := &cobra.Command{
		Use:   "public [database] [on|off]",
		Short: "Show, open or close a database's public port",
		Long: `Without on or off, show whether the database can be reached from outside Serve.

on opens a public port on the database's server (--port picks it, else Serve picks a free one;
a port once opened stays until it is closed). --allow lets only these addresses or ranges
through (repeat it; --allow "" lets everyone with the password). off closes the port. The
database restarts for either. The database is the linked one, the one named, or --service.

Print the address that works from outside with serve db url --public.`,
		Example: "  serve db public\n  serve db public on\n  serve db public postgres on --port 5433 --allow 203.0.113.7\n  serve db public off",
		Args:    rangeArgs(0, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			action := ""
			if n := len(args); n > 0 && (args[n-1] == "on" || args[n-1] == "off") {
				action, args = args[n-1], args[:n-1]
			}
			if len(args) > 1 {
				return usagef("say on or off after the database, like `serve db public %s on`", args[0])
			}
			fl := cmd.Flags()
			if action != "on" && (fl.Changed("port") || fl.Changed("allow")) {
				return usagef("--port and --allow go with on")
			}
			if fl.Changed("port") && (port < 1024 || port > 65535) {
				return usagef("--port must be from 1024 to 65535")
			}
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			now, err := a.dbAccess(ctx, s)
			if err != nil {
				return err
			}
			switch action {
			case "":
				if now.PublicPort == nil {
					fmt.Fprintf(ui.Out, "%s has no public port: only services in its environment can connect.\n", s.Name)
					return nil
				}
				who := "everyone with the password"
				switch {
				case deref(now.PublicBind) == "127.0.0.1":
					who = "this server only"
				case len(now.PublicAllow) > 0:
					who = strings.Join(now.PublicAllow, ", ")
				}
				ui.KV([][2]string{{"Public port", strconv.Itoa(*now.PublicPort)}, {"Allowed", who}, {"Domain", deref(now.Domain)}})
				return nil
			case "off":
				if now.PublicPort == nil {
					ui.Info("%s has no public port.", s.Name)
					return nil
				}
				if d := deref(now.Domain); d != "" {
					return fmt.Errorf("%s is on the domain %s, which uses its public port. Take it off first: `serve db domain --remove -s %s`", s.Name, d, s.Name)
				}
			}
			database := map[string]any{"publicPort": nil}
			if action == "on" {
				database["publicPort"] = "auto"
				if fl.Changed("port") {
					database["publicPort"] = port
				}
				database["publicBind"] = "0.0.0.0"
				if fl.Changed("allow") {
					database["publicAllow"] = splitAllow(allow)
				}
			}
			var r struct {
				Service struct {
					Database *dbAccess `json:"database"`
				} `json:"service"`
			}
			if err := a.client.Patch(ctx, "/services/"+api.P(s.ID), map[string]any{"database": database}, &r); err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/database/apply", nil, nil); err != nil {
				return fmt.Errorf("saved, but %s could not restart: %w. Restart it with `serve db apply -s %s`", s.Name, err, s.Name)
			}
			if action == "off" {
				ui.Success("Closed the public port of %s. It restarts without it.", ui.Bold(s.Name))
				return nil
			}
			p := ""
			if d := r.Service.Database; d != nil && d.PublicPort != nil {
				p = " " + strconv.Itoa(*d.PublicPort)
			}
			ui.Success("Opened public port%s for %s. It restarts with it.", p, ui.Bold(s.Name))
			ui.Line(ui.Dim(fmt.Sprintf("Print the address with `serve db url %s --public`.", s.Name)))
			return nil
		},
	}
	cmd.Flags().IntVar(&port, "port", 0, "the public port (default: a free one)")
	cmd.Flags().StringArrayVar(&allow, "allow", nil, "only let this address or range through (repeat; \"\" for everyone)")
	return cmd
}

// splitAllow turns repeated or comma-separated --allow values into a list ("" alone: empty).
func splitAllow(values []string) []string {
	out := []string{}
	for _, v := range values {
		out = append(out, splitList(v)...)
	}
	return out
}

func (a *App) dbDomainCmd() *cobra.Command {
	var remove bool
	var allow []string
	cmd := &cobra.Command{
		Use:   "domain [hostname]",
		Short: "Show, set or remove a database's domain",
		Long: `Without a hostname, show the database's domain. With one, put the database on it: it
gets a public port of its own (opened when it has none) and TLS with the domain's certificate.
Serve makes the DNS record when the domain is in a connected Cloudflare account; otherwise point
an A record at the server. --allow lets only these addresses or ranges through its port (repeat
it; --allow "" for everyone with the password).

--remove takes the database off its domain, and closes the port the domain opened. The database
is the linked one, or --service.`,
		Example: "  serve db domain db.example.com -s postgres\n  serve db domain db.example.com --allow 203.0.113.0/24\n  serve db domain --remove",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if remove && len(args) > 0 {
				return usagef("pass a hostname or --remove, not both")
			}
			if cmd.Flags().Changed("allow") && len(args) == 0 {
				return usagef("--allow goes with a hostname")
			}
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			if len(args) == 0 && !remove {
				now, err := a.dbAccess(ctx, s)
				if err != nil {
					return err
				}
				if deref(now.Domain) == "" {
					fmt.Fprintf(ui.Out, "%s has no domain.\n", s.Name)
					return nil
				}
				fmt.Fprintln(ui.Out, *now.Domain)
				return nil
			}
			body := map[string]any{"hostname": nil, "via": "direct"}
			if !remove {
				body["hostname"] = args[0]
				if cmd.Flags().Changed("allow") {
					body["allow"] = splitAllow(allow)
				}
			}
			var r struct {
				Warnings []string `json:"warnings"`
				Port     *int     `json:"port"`
			}
			if err := a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+"/database/domain", body, &r); err != nil {
				return err
			}
			if remove {
				ui.Success("Took %s off its domain.", ui.Bold(s.Name))
			} else {
				port := ""
				if r.Port != nil {
					port = fmt.Sprintf(" (port %d)", *r.Port)
				}
				ui.Success("Put %s on %s%s.", ui.Bold(s.Name), args[0], port)
			}
			for _, w := range r.Warnings {
				ui.Warn("%s", w)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&remove, "remove", false, "take the database off its domain")
	cmd.Flags().StringArrayVar(&allow, "allow", nil, "only let this address or range through (repeat; \"\" for everyone)")
	return cmd
}
