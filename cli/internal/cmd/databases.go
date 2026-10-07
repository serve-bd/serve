package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Engines a database can be created with, and the words people use for them.
var (
	dbEngines      = []string{"postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "clickhouse"}
	dbEngineLabels = map[string]string{"postgres": "PostgreSQL", "mysql": "MySQL", "mariadb": "MariaDB", "mongodb": "MongoDB", "redis": "Redis", "valkey": "Valkey", "clickhouse": "ClickHouse"}
	dbEngineWords  = map[string]string{"postgresql": "postgres", "pg": "postgres", "mongo": "mongodb", "maria": "mariadb"}
)

func engineLabel(e string) string {
	if l, ok := dbEngineLabels[e]; ok {
		return l
	}
	return e
}

// dbPoll is how often --wait asks how an action is going (tests shorten it).
var dbPoll = 2 * time.Second

// database finds the database a command works on: the one named as its argument (like
// `serve db url postgres`), --service, the linked one, or one picked next to the linked app.
func (a *App) database(ctx context.Context, args []string) (*api.Service, error) {
	if len(args) == 1 {
		if a.service != "" && a.service != args[0] {
			return nil, usagef("name the database once: %q or --service %q", args[0], a.service)
		}
		a.service = args[0]
	}
	s, err := a.target(ctx, ".", databaseService)
	if err != nil {
		return nil, err
	}
	if s.Type != "database" {
		return nil, fmt.Errorf("%s is not a database (it is a %s)", s.Name, s.Kind())
	}
	return s, nil
}

// dbListCmd is like lsCmd, for lists of one database: "<name> [database]" and "<name> ls [database]".
func dbListCmd(use, short, long, example string, run func(cmd *cobra.Command, args []string, asJSON bool) error) *cobra.Command {
	var asJSON bool
	runE := func(cmd *cobra.Command, args []string) error { return run(cmd, args, asJSON) }
	cmd := &cobra.Command{Use: use + " [database]", Short: short, Long: long, Example: example, Args: maxArgs(1), RunE: runE}
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(&cobra.Command{Use: "ls [database]", Aliases: []string{"list"}, Short: "Print the list (the same as " + use + " alone)", Args: maxArgs(1), RunE: runE})
	return cmd
}

// confirmTyped asks for a name before an action that replaces data. --yes skips it; without a
// terminal the flag is required.
func confirmTyped(action, name string, yes bool) error {
	if yes {
		return nil
	}
	if !ui.Interactive {
		return usagef("to %s, pass --yes (there is no terminal to ask)", action)
	}
	typed, err := ui.Input(fmt.Sprintf("Type %s to %s", name, action), name, "")
	if err != nil {
		return err
	}
	if typed != name {
		return errors.New("the name did not match: nothing was changed")
	}
	return nil
}

// confirmYes asks a yes or no question before an action. --yes skips it; without a terminal the
// flag is required.
func confirmYes(question, action string, yes bool) error {
	if yes {
		return nil
	}
	if !ui.Interactive {
		return usagef("to %s, pass --yes (there is no terminal to ask)", action)
	}
	ok, err := ui.Confirm(question, false)
	if err != nil {
		return err
	}
	if !ok {
		return ui.ErrAborted
	}
	return nil
}

// waitFor asks check every dbPoll until it says done. A few failed checks in a row (a network
// blip) are borne. Ctrl+C stops waiting, not the action: hint says how to check on it later.
func waitFor(ctx context.Context, msg, hint string, check func(ctx context.Context) (bool, error)) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	sp := ui.StartSpinner(msg)
	defer sp.Stop()
	failures := 0
	for {
		done, err := check(ctx)
		if ctx.Err() != nil {
			sp.Stop()
			ui.Info("Stopped waiting. It goes on on the server: %s", hint)
			return nil
		}
		if err == nil && done {
			return nil
		}
		if err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status != 429 && ae.Status < 500 {
				return err
			}
			if failures++; failures >= 5 {
				return fmt.Errorf("%w (stopped waiting; %s)", err, hint)
			}
		} else {
			failures = 0
		}
		select {
		case <-ctx.Done():
			sp.Stop()
			ui.Info("Stopped waiting. It goes on on the server: %s", hint)
			return nil
		case <-time.After(dbPoll):
		}
	}
}

// readArg answers the argument, or standard input when it is "-".
func readArg(arg, what string) (string, error) {
	if arg != "-" {
		return arg, nil
	}
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", fmt.Errorf("could not read the %s from standard input: %w", what, err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", usagef("standard input held no %s", what)
	}
	return s, nil
}

func (a *App) dbCreateCmd() *cobra.Command {
	var name, version, server string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "create <engine>",
		Short: "Create a database",
		Long: `Create a database and start it. The engine is one of: ` + strings.Join(dbEngines, ", ") + `.

It goes in the linked project and environment, or --project and --env (asked when there is a
terminal and no link). --name defaults to the engine's name; Serve adds a number when the name
is taken. --version picks the image version (like 17-alpine for PostgreSQL); a version Serve does
not offer is refused before anything starts. --server picks the server when there are several.

Its connection string is then printed by serve db url <name>.`,
		Example: "  serve db create postgres\n  serve db create redis --name cache\n  serve db create mysql --project shop --env staging --version 8.4",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			engine := strings.ToLower(args[0])
			if w, ok := dbEngineWords[engine]; ok {
				engine = w
			}
			if _, ok := dbEngineLabels[engine]; !ok {
				return usagef("there is no engine %q. Use one of: %s", args[0], strings.Join(dbEngines, ", "))
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			var projectID, projectName string
			if a.project != "" {
				p, err := a.findProject(ctx, a.project)
				if err != nil {
					return err
				}
				projectID, projectName = p.ID, p.Name
				if l := a.linkFor("."); l != nil && l.ProjectID == p.ID && a.environment == "" {
					a.environment = l.EnvironmentID
				}
			} else if l := a.linkFor("."); l != nil {
				projectID, projectName = l.ProjectID, l.ProjectName
				if a.environment == "" {
					// The linked environment, unless --env names another one.
					a.environment = l.EnvironmentID
				}
			} else {
				if !ui.Interactive {
					return usagef("this folder is not linked to a project. Pass --project (and --env)")
				}
				p, err := a.pickProject(ctx)
				if err != nil {
					return err
				}
				projectID, projectName = p.ID, p.Name
			}
			env, err := a.pickEnvironment(ctx, projectID)
			if err != nil {
				return err
			}
			serverID, err := a.pickServer(ctx, server)
			if err != nil {
				return err
			}
			if name == "" {
				name = engine
			}
			body := map[string]any{"type": "database", "projectId": projectID, "environmentId": env.ID, "name": name, "engine": engine}
			if serverID != "" {
				body["serverId"] = serverID
			}
			// Serve falls back to the default version when it does not offer the one asked for:
			// with --version, it starts only after the version is checked.
			if version != "" {
				body["version"] = version
			} else {
				body["deploy"] = true
			}
			var r map[string]any
			if err := c.Post(ctx, "/services", body, &r); err != nil {
				return err
			}
			id := idOf(r)
			if id == "" {
				return errors.New("the new database's id was not in the server's answer")
			}
			s, err := c.Service(ctx, id)
			if err != nil {
				return err
			}
			info := s.DatabaseInfo()
			if version != "" {
				if info.Version != version {
					if derr := c.Delete(ctx, "/services/"+api.P(id), nil, nil); derr != nil {
						return fmt.Errorf("%s has no version %q here, and the database made for it could not be removed (%v). Delete %s in the dashboard", engineLabel(engine), version, derr, s.Name)
					}
					return fmt.Errorf("%s has no version %q here (the default is %s). Nothing was created", engineLabel(engine), version, info.Version)
				}
				if err := c.Post(ctx, "/services/"+api.P(id)+"/deploy", map[string]any{}, nil); err != nil {
					return fmt.Errorf("created %s, but it could not start: %w. Start it with `serve start -s %s`", s.Name, err, s.Name)
				}
			}
			if asJSON {
				return printJSON(s)
			}
			label := engineLabel(engine)
			if info.Version != "" {
				label += " " + info.Version
			}
			ui.Success("Created the %s database %s in %s / %s. It is starting.", label, ui.Bold(s.Name), orName(projectName, s.Project), env.Name)
			ui.Line(ui.Dim(fmt.Sprintf("Print its connection string with `serve db url %s`.", s.Name)))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&name, "name", "", "the database's name (default: the engine)")
	f.StringVar(&version, "version", "", "the image version, like 17-alpine (default: Serve's choice)")
	f.StringVarP(&a.project, "project", "p", "", "project name or id (default: the linked one)")
	f.StringVar(&server, "server", "", "the server (`name` or id) to run it on")
	f.BoolVar(&asJSON, "json", false, "print the new service as JSON")
	return cmd
}

func (a *App) dbDependentsCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "dependents [database]",
		Short:   "List the services that use a database",
		Long:    "List the services in the database's environment whose variables point at it (like ${{postgres.DATABASE_URL}}).",
		Example: "  serve db dependents\n  serve db dependents postgres --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			list, err := a.client.Dependents(ctx, s.ID)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(orEmpty(list))
			}
			if len(list) == 0 {
				ui.Info("No service uses %s.", s.Name)
				return nil
			}
			var rows [][]string
			for _, d := range list {
				rows = append(rows, []string{d.Name, ui.StatusColor(d.Status), d.ID})
			}
			ui.Table([]string{"NAME", "STATUS", "ID"}, rows)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

// orEmpty makes a nil list print as [] in JSON.
func orEmpty[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

func (a *App) dbPasswordCmd() *cobra.Command {
	var yes, show bool
	cmd := &cobra.Command{
		Use:   "password [database]",
		Short: "Change the main password of a database",
		Long: `Change the password of the database's main login to a new random one. The password is
changed inside the running database, which then restarts. Services that use it get the new
value on their next deploy: redeploy them (see serve db dependents).

Asks first unless --yes. --show prints the new connection string.`,
		Example: "  serve db password postgres\n  serve db password --yes --show",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			if err := confirmYes(fmt.Sprintf("Change the password of %s? Services that use it need a redeploy afterwards.", s.Name), "change the password", yes); err != nil {
				return err
			}
			var r struct {
				Dependents []api.Dependent `json:"dependents"`
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/database/password", map[string]any{}, &r); err != nil {
				return err
			}
			ui.Success("Changed the password of %s. It restarts with the new one.", ui.Bold(s.Name))
			if len(r.Dependents) > 0 {
				names := make([]string, len(r.Dependents))
				for i, d := range r.Dependents {
					names[i] = d.Name
				}
				ui.Warn("These services get the new password on their next deploy: %s. Redeploy them, like `serve redeploy -s %s`.", strings.Join(names, ", "), names[0])
			}
			if !show {
				return nil
			}
			var conn struct{ Connection api.Connection }
			if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/connection", nil, &conn); err != nil {
				return err
			}
			u := conn.Connection.Variables["DATABASE_URL"]
			if u == "" {
				return errors.New(noSecrets)
			}
			fmt.Fprintln(ui.Out, u)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	cmd.Flags().BoolVar(&show, "show", false, "print the new connection string")
	return cmd
}

func (a *App) dbImportCmd() *cobra.Command {
	var yes, wait, noBackup, users bool
	var passphrase string
	cmd := &cobra.Command{
		Use:   "import <file | url | s3://storage/key>",
		Short: "Replace a database's data with a dump from a file, a URL or S3",
		Long: `Restore a dump into the database, replacing its data. The source is a file on this
computer (uploaded), an http(s) URL, or s3://<storage>/<key> where <storage> is the name, id or
bucket of one of the organization's S3 storages (Settings) and <key> the object's path in the
bucket. An encrypted dump (.enc) takes --passphrase or SERVE_BACKUP_PASSPHRASE.

The current data is backed up first unless --no-backup. --users also restores the database's
users and roles. Asks for the database's name unless --yes. --wait waits until the restore ends.
The database is the linked one, or --service.`,
		Example: "  serve db import ./dump.sql.gz --wait\n  serve db import https://example.com/dump.sql.gz --wait\n  serve db import s3://backups/old/app.dump -s postgres --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			src := args[0]
			var source map[string]any
			lower := strings.ToLower(src)
			switch {
			case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"):
				source = map[string]any{"kind": "url", "url": src}
			case strings.HasPrefix(lower, "s3://"):
				storage, key, _ := strings.Cut(src[len("s3://"):], "/")
				key = strings.TrimLeft(key, "/")
				if storage == "" || key == "" {
					return usagef("write an S3 source as s3://<storage>/<key>")
				}
				c, err := a.Client()
				if err != nil {
					return err
				}
				id, err := findStorage(ctx, c, storage)
				if err != nil {
					return err
				}
				source = map[string]any{"kind": "s3", "destinationId": id, "key": key}
			default:
				if _, err := os.Stat(src); err != nil {
					return usagef("the source is a file, an http(s) URL or s3://<storage>/<key> (%s was not found)", src)
				}
			}
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			if !yes {
				ui.Warn("This replaces the data of %s with the dump%s.", s.Name, map[bool]string{true: "", false: " (it is backed up first)"}[noBackup])
			}
			if err := confirmTyped("replace its data", s.Name, yes); err != nil {
				return err
			}
			var r struct {
				ID string `json:"id"`
			}
			pass := firstNonEmpty(passphrase, os.Getenv("SERVE_BACKUP_PASSPHRASE"))
			if source == nil {
				// A file here: streamed up as it is read, never loaded into memory.
				file, err := os.Open(src)
				if err != nil {
					return err
				}
				defer file.Close()
				info, err := file.Stat()
				if err != nil {
					return err
				}
				q := url.Values{"filename": {filepath.Base(src)}}
				if !noBackup {
					q.Set("backupFirst", "1")
				}
				if users {
					q.Set("users", "1")
				}
				header := http.Header{}
				if pass != "" {
					header.Set("X-Backup-Passphrase", pass)
				}
				ui.Info("Uploading %s (%s)", filepath.Base(src), ui.Bytes(info.Size()))
				err = a.client.Do(ctx, api.Request{Method: http.MethodPost, Path: "/services/" + api.P(s.ID) + "/backups/import", Query: q, Body: file, Length: info.Size(), ContentType: "application/octet-stream", Header: header}, &r)
				if err != nil {
					return err
				}
			} else {
				body := map[string]any{"source": source, "backupFirst": !noBackup, "users": users}
				if pass != "" {
					body["passphrase"] = pass
				}
				if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/database/import", body, &r); err != nil {
					return err
				}
			}
			hint := fmt.Sprintf("see `serve db backups -s %s`", s.Name)
			if !wait || r.ID == "" {
				ui.Success("Started importing into %s. %s.", ui.Bold(s.Name), upper(hint))
				return nil
			}
			var failed error
			err = waitFor(ctx, "Importing into "+s.Name, hint, func(ctx context.Context) (bool, error) {
				b, err := a.backup(ctx, s, r.ID)
				if err != nil {
					return false, err
				}
				switch {
				case b.Status == "failed":
					failed = fmt.Errorf("the import failed: %s", firstNonEmpty(deref(b.Error), "see the backup's log in the dashboard"))
					return true, nil
				case deref(b.RestoreStatus) == "failed":
					failed = fmt.Errorf("the dump was downloaded but restoring it failed. See the backup's log in the dashboard: %s", a.dashboardURL(s))
					return true, nil
				}
				return deref(b.RestoreStatus) == "success", nil
			})
			if err != nil {
				return err
			}
			if failed != nil {
				return failed
			}
			ui.Success("Imported the dump into %s.", ui.Bold(s.Name))
			return nil
		},
	}
	f := cmd.Flags()
	f.BoolVarP(&yes, "yes", "y", false, "do not ask for the database's name")
	f.BoolVar(&wait, "wait", false, "wait until the restore ends")
	f.BoolVar(&noBackup, "no-backup", false, "do not back up the current data first")
	f.BoolVar(&users, "users", false, "also restore the dump's users and passwords")
	f.StringVar(&passphrase, "passphrase", "", "passphrase of an encrypted dump (.enc)")
	return cmd
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// findStorage finds an S3 storage by name, id or bucket.
func findStorage(ctx context.Context, c *api.Client, ref string) (string, error) {
	var r struct {
		Destinations []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Bucket string `json:"bucket"`
		} `json:"destinations"`
	}
	if err := c.Get(ctx, "/s3-destinations", nil, &r); err != nil {
		return "", err
	}
	var found []string
	for _, d := range r.Destinations {
		if d.ID == ref {
			return d.ID, nil
		}
		if strings.EqualFold(d.Name, ref) || d.Bucket == ref {
			found = append(found, d.ID)
		}
	}
	switch len(found) {
	case 0:
		return "", fmt.Errorf("there is no S3 storage named %q. Add it in Settings first", ref)
	case 1:
		return found[0], nil
	}
	return "", fmt.Errorf("%d S3 storages match %q. Use the storage's id instead", len(found), ref)
}

func (a *App) dbReplicasCmd() *cobra.Command {
	cmd := dbListCmd("replicas", "List, add, remove and promote read replicas of a database",
		"List the read replicas of the database: their server, state (copying, following, stopped, failed) and how far behind they are.",
		"  serve db replicas\n  serve db replicas postgres --json\n  serve db replicas add eu-2 -s postgres\n  serve db replicas rm 2 -s postgres",
		func(cmd *cobra.Command, args []string, asJSON bool) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			list, err := a.client.Replicas(ctx, s.ID)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(orEmpty(list))
			}
			if len(list) == 0 {
				ui.Info("%s has no read replicas. Add one with `serve db replicas add <server> -s %s`.", s.Name, s.Name)
				return nil
			}
			servers := a.serverNames(ctx)
			var rows [][]string
			for _, r := range list {
				lag := ""
				if r.LagSeconds != nil {
					lag = ui.Duration(time.Duration(*r.LagSeconds * float64(time.Second)))
				}
				rows = append(rows, []string{r.ID, orName(servers[r.ServerID], r.ServerID), ui.StatusColor(r.State), lag, firstLine(deref(r.Error))})
			}
			ui.Table([]string{"ID", "SERVER", "STATE", "BEHIND", "ERROR"}, rows)
			return nil
		})
	var yes bool
	promote := &cobra.Command{
		Use:   "promote <replica>",
		Short: "Make a read replica the database",
		Long: `Make a read replica the database, for when the database's server is lost. The database
stops (if its server answers) and runs on the replica's server with the replica's data. Changes
the replica had not received are lost; the other replicas copy the new database again.

The replica is its id, or its server's name. Asks for the database's name unless --yes. The
database is the linked one, or --service.`,
		Example: "  serve db replicas promote r1 -s postgres",
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
			if !yes {
				ui.Warn("%s moves to %s with the replica's data. Changes the replica had not received are lost.", s.Name, orName(servers[r.ServerID], r.ServerID))
			}
			if err := confirmTyped("promote the replica", s.Name, yes); err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/database/replicas/"+api.P(r.ID)+"/promote", map[string]any{}, nil); err != nil {
				return err
			}
			ui.Success("Promoted the replica on %s. %s is deploying there; see `serve status -s %s`.", orName(servers[r.ServerID], r.ServerID), ui.Bold(s.Name), s.Name)
			return nil
		},
	}
	promote.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the database's name")
	cmd.AddCommand(promote, a.dbReplicaAddCmd(), a.dbReplicaRmCmd())
	return cmd
}

// serverNames maps server ids to names; empty when they cannot be read.
func (a *App) serverNames(ctx context.Context) map[string]string {
	out := map[string]string{}
	if list, err := a.client.Servers(ctx); err == nil {
		for _, s := range list {
			out[s.ID] = s.Name
		}
	}
	return out
}
