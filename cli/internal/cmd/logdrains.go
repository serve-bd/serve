package cmd

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Log drains: where the containers' logs are sent.

var drainKinds = []string{"http", "loki", "elasticsearch", "splunk", "syslog"}

const drainNeed = "the Manage integrations permission (integrations.manage)"

func (a *App) logDrains(ctx context.Context) ([]api.LogDrain, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var r struct{ Drains []api.LogDrain }
	if err := c.Get(ctx, "/log-drains", nil, &r); err != nil {
		return nil, needs(err, drainNeed)
	}
	return r.Drains, nil
}

func (a *App) findLogDrain(ctx context.Context, ref string) (*api.LogDrain, error) {
	list, err := a.logDrains(ctx)
	if err != nil {
		return nil, err
	}
	return pickOne(list, ref, "log drain", "serve log-drains", func(d api.LogDrain) string { return d.ID }, func(d api.LogDrain) []string { return []string{d.Name} })
}

// drainSends says whose logs a drain sends.
func drainSends(d *api.LogDrain) string {
	var parts []string
	if n := len(d.ProjectIDs); n > 0 {
		parts = append(parts, plural(n, "project"))
	}
	if n := len(d.ServiceIDs); n > 0 {
		parts = append(parts, plural(n, "service"))
	}
	if len(parts) == 0 {
		return "nothing"
	}
	return strings.Join(parts, ", ")
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func (a *App) logDrainsCmd() *cobra.Command {
	cmd := lsCmd("log-drains", "List log drains", []string{"log-drain", "drains"}, func(cmd *cobra.Command, asJSON bool) error {
		list, err := a.logDrains(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			ui.Info("No log drains yet. Add one with `serve log-drains add`.")
			return nil
		}
		var rows [][]string
		for i := range list {
			d := &list[i]
			state := "on"
			if !d.Enabled {
				state = "off"
			}
			rows = append(rows, []string{txt(d.Name), d.Kind, txt(d.URL), drainSends(d), state, d.ID})
		}
		ui.Table([]string{"NAME", "KIND", "URL", "SENDS", "", "ID"}, rows)
		return nil
	})
	cmd.Short = "Log drains: list, add, test, delete"
	cmd.Long = `List the log drains: destinations the containers' logs are sent to (an HTTP endpoint,
Grafana Loki, Elasticsearch or OpenSearch, Splunk, or syslog). Header values and passwords
are never shown.`
	cmd.AddCommand(a.logDrainAddCmd(), a.logDrainTestCmd(), a.logDrainRmCmd())
	return cmd
}

func (a *App) logDrainAddCmd() *cobra.Command {
	var kind, endpoint, header, username, index, sourcetype string
	var projects, services []string
	var allProjects, insecure bool
	var secret secretSource
	cmd := &cobra.Command{
		Use:   "add <name>",
		Short: "Add a log drain",
		Long: `Add a log drain: Serve sends the logs of the projects and services you pick to it, from
every server, within a minute.

--kind is http (JSON batches; --header names a header such as Authorization, the secret is
its value), loki or elasticsearch (--username, the secret is the password), splunk (the
secret is the HEC token; --index, --sourcetype) or syslog (--url tcp://, tls:// or udp://
with a port). Give the secret with --secret-file or --secret-stdin, or type it when asked.

Pick whose logs are sent with --projects and --services (comma separated), or
--all-projects. --insecure accepts a self-signed certificate.`,
		Example: `  serve log-drains add axiom --kind http --url https://api.axiom.co/v1/datasets/logs/ingest \
    --header Authorization --secret-stdin --all-projects < token.txt
  serve log-drains add loki --kind loki --url https://loki.example.com --username serve --projects shop
  serve log-drains add papertrail --kind syslog --url tls://logs.papertrailapp.com:12345 --services web,api`,
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !slices.Contains(drainKinds, kind) {
				return usagef("--kind is one of %s", strings.Join(drainKinds, ", "))
			}
			if endpoint == "" {
				return usagef("--url is where the logs go")
			}
			u, err := url.Parse(endpoint)
			if err != nil || u.Host == "" {
				return usagef("--url is a full address, like https://logs.example.com/ingest or tls://host:6514")
			}
			if kind == "syslog" && u.Scheme != "tcp" && u.Scheme != "tls" && u.Scheme != "udp" {
				return usagef("a syslog --url starts with tcp://, tls:// or udp:// and has a port")
			}
			if kind != "syslog" && u.Scheme != "http" && u.Scheme != "https" {
				return usagef("a %s --url starts with http:// or https://", kind)
			}
			if !allProjects && len(projects) == 0 && len(services) == 0 {
				return usagef("pick whose logs to send: --projects, --services or --all-projects")
			}
			if allProjects && len(projects) > 0 {
				return usagef("use --all-projects or --projects, not both")
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			var projectIDs []string
			if allProjects {
				ps, err := c.Projects(ctx)
				if err != nil {
					return err
				}
				for _, p := range ps {
					projectIDs = append(projectIDs, p.ID)
				}
			} else if projectIDs, err = a.projectIDs(ctx, projects); err != nil {
				return err
			}
			serviceIDs := []string{}
			for _, ref := range services {
				s, err := a.findService(ctx, ref, "", "")
				if err != nil {
					return err
				}
				serviceIDs = append(serviceIDs, s.ID)
			}
			body := map[string]any{"name": args[0], "kind": kind, "url": endpoint, "projectIds": projectIDs, "serviceIds": serviceIDs, "insecure": insecure}
			given := secret.value != "" || secret.file != "" || secret.stdin
			needSecret := kind == "splunk" || (kind == "http" && header != "")
			if given || needSecret {
				what := map[string]string{"http": "header value", "loki": "password", "elasticsearch": "password", "splunk": "HEC token", "syslog": "secret"}[kind]
				if kind == "syslog" {
					return usagef("syslog drains take no secret")
				}
				v, err := secret.read(what, "secret")
				if err != nil {
					return err
				}
				if kind == "http" {
					if header == "" {
						return usagef("an http drain's secret is a header value: name the header with --header")
					}
					body["headerValue"] = v
				} else {
					body["password"] = v
				}
			}
			if header != "" {
				if kind != "http" {
					return usagef("--header is for http drains")
				}
				body["headerName"] = header
			}
			if username != "" {
				body["username"] = username
			}
			if index != "" {
				body["index"] = index
			}
			if sourcetype != "" {
				body["sourcetype"] = sourcetype
			}
			var r struct {
				ID string `json:"id"`
			}
			if err := c.Post(ctx, "/log-drains", body, &r); err != nil {
				return needs(err, drainNeed)
			}
			ui.Success("Added the log drain %s. Logs start arriving within a minute.", args[0])
			ui.Line(ui.Dim(fmt.Sprintf("Send a test line with `serve log-drains test %s`.", args[0])))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&kind, "kind", "", "http, loki, elasticsearch, splunk or syslog")
	f.StringVar(&endpoint, "url", "", "where the logs go")
	f.StringVar(&header, "header", "", "http: the `name` of the header the secret goes in (like Authorization)")
	f.StringVar(&username, "username", "", "loki, elasticsearch: the user name")
	f.StringVar(&index, "index", "", "elasticsearch, splunk: the index")
	f.StringVar(&sourcetype, "sourcetype", "", "splunk: the source type")
	f.StringSliceVar(&projects, "projects", nil, "send these projects' logs (`names` or ids, comma separated)")
	f.StringSliceVar(&services, "services", nil, "send these services' logs (`names` or ids, comma separated)")
	f.BoolVar(&allProjects, "all-projects", false, "send the logs of every project there is now")
	f.BoolVar(&insecure, "insecure", false, "accept a self-signed certificate")
	secret.flags(cmd, "secret", "header value, password or token")
	return cmd
}

func (a *App) logDrainTestCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "test <drain>",
		Short:   "Send a test line to a log drain",
		Long:    "Send one sample line to a log drain, the way the log collector sends them. When it fails, the error says what the destination answered.",
		Example: "  serve log-drains test axiom",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			d, err := a.findLogDrain(ctx, args[0])
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/log-drains/"+api.P(d.ID)+"/test", nil, nil); err != nil {
				return needs(err, drainNeed)
			}
			ui.Success("The test line reached %s.", d.Name)
			return nil
		},
	}
}

func (a *App) logDrainRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <drain>",
		Aliases: []string{"remove", "delete"},
		Short:   "Delete a log drain",
		Long:    "Delete a log drain: its logs stop being sent within a minute. Asks for its name unless --yes.",
		Example: "  serve log-drains rm axiom",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			d, err := a.findLogDrain(ctx, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("the log drain "+d.Name, d.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/log-drains/"+api.P(d.ID), nil, nil); err != nil {
				return needs(err, drainNeed)
			}
			ui.Success("Deleted the log drain %s.", d.Name)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}
