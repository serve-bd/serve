package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) templatesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "templates [search]",
		Aliases: []string{"template"},
		Short:   "Browse one-click templates and deploy one",
		Long: `List the one-click templates: ready-made Docker Compose stacks. A search word keeps the
templates whose name, id, category or description has it.`,
		Example: "  serve templates\n  serve templates analytics\n  serve templates show plausible\n  serve templates deploy plausible --env staging",
		Args:    maxArgs(1),
	}
	var asJSON bool
	list := func(cmd *cobra.Command, args []string) error {
		ctx := cmd.Context()
		c, err := a.Client()
		if err != nil {
			return err
		}
		all, err := c.Templates(ctx)
		if err != nil {
			return err
		}
		var kept []api.Template
		q := ""
		if len(args) == 1 {
			q = strings.ToLower(strings.TrimSpace(args[0]))
		}
		for _, t := range all {
			hay := strings.ToLower(t.ID + " " + t.Name + " " + t.Category + " " + t.Description)
			if q == "" || strings.Contains(hay, q) {
				kept = append(kept, t)
			}
		}
		if asJSON {
			if kept == nil {
				kept = []api.Template{}
			}
			return printJSON(kept)
		}
		if len(kept) == 0 {
			if q != "" {
				ui.Info("No template matches %q.", q)
			} else {
				ui.Info("No templates.")
			}
			return nil
		}
		sort.SliceStable(kept, func(i, j int) bool { return strings.ToLower(kept[i].Name) < strings.ToLower(kept[j].Name) })
		var rows [][]string
		for _, t := range kept {
			rows = append(rows, []string{t.ID, t.Name, t.Category, ellipsis(t.Description, 60)})
		}
		ui.Table([]string{"ID", "NAME", "CATEGORY", "DESCRIPTION"}, rows)
		ui.Line(ui.Dim("Deploy one with `serve templates deploy <id>`."))
		return nil
	}
	cmd.RunE = list
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(&cobra.Command{Use: "ls [search]", Aliases: []string{"list"}, Short: "List the templates", Args: maxArgs(1), RunE: list})
	cmd.AddCommand(a.templateShowCmd(&asJSON), a.templateDeployCmd())
	return cmd
}

func ellipsis(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

// varSource says how Serve fills a template value.
func varSource(v api.TemplateVar) string {
	switch {
	case v.PublicURL:
		return "the service's URL"
	case v.PublicHost:
		return "the service's domain"
	case v.ServiceURL != "":
		return "the URL of " + v.ServiceURL
	case v.ServiceHost != "":
		return "the domain of " + v.ServiceHost
	case v.Generate != "":
		return "generated"
	case v.Value != "":
		return v.Value
	}
	return "(empty)"
}

func (a *App) templateShowCmd(asJSON *bool) *cobra.Command {
	var compose bool
	cmd := &cobra.Command{
		Use:     "show <id>",
		Aliases: []string{"info"},
		Short:   "Show a template: its values and, with --compose, its compose file",
		Example: "  serve templates show plausible\n  serve templates show plausible --compose",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			t, err := c.Template(ctx, args[0])
			if api.IsStatus(err, http.StatusNotFound) {
				return fmt.Errorf("there is no template %q. See `serve templates`", args[0])
			}
			if err != nil {
				return err
			}
			if *asJSON {
				return printJSON(t)
			}
			if compose {
				fmt.Fprint(ui.Out, t.Compose)
				if !strings.HasSuffix(t.Compose, "\n") {
					fmt.Fprintln(ui.Out)
				}
				return nil
			}
			fmt.Fprintf(ui.Out, "%s  %s\n", ui.OutBold(t.Name), ui.OutDim(t.ID))
			fmt.Fprintln(ui.Out, t.Description)
			pairs := [][2]string{{"Category", t.Category}, {"Website", t.Website}}
			if t.HostAccess {
				pairs = append(pairs, [2]string{"Server access", "uses the Docker socket or host paths: only admins of the Root organization can create it"})
			}
			pairs = append(pairs, [2]string{"Note", t.Note})
			ui.KV(pairs)
			if len(t.Vars) > 0 {
				fmt.Fprintln(ui.Out)
				var rows [][]string
				for _, v := range t.Vars {
					rows = append(rows, []string{v.Key, varSource(v), v.Label})
				}
				ui.Table([]string{"VALUE", "DEFAULT", "ABOUT"}, rows)
			}
			ui.Line(ui.Dim(fmt.Sprintf("Deploy it with `serve templates deploy %s` (--set KEY=value changes a value).", t.ID)))
			return nil
		},
	}
	cmd.Flags().BoolVar(&compose, "compose", false, "print only the compose file")
	return cmd
}

func (a *App) templateDeployCmd() *cobra.Command {
	var name, server string
	var set []string
	var noWait bool
	cmd := &cobra.Command{
		Use:   "deploy <id>",
		Short: "Create a stack from a template and deploy it",
		Long: `Create a Docker Compose stack from a template in the linked project (or --project) and
its environment (the linked one, --env, or production), then deploy it and follow the log.

Passwords and secrets are generated, and addresses follow the stack's generated domain.
--set KEY=value sets a value yourself; values the template leaves empty are asked for when
there is a terminal.`,
		Example: "  serve templates deploy plausible\n  serve templates deploy n8n --name automations --env staging\n  serve templates deploy umami --set APP_SECRET=... --no-wait",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			values := map[string]string{}
			for _, kv := range set {
				k, v, ok := strings.Cut(kv, "=")
				if !ok || strings.TrimSpace(k) == "" {
					return usagef("--set takes KEY=value, got %q", kv)
				}
				values[strings.TrimSpace(k)] = v
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			t, err := c.Template(ctx, args[0])
			if api.IsStatus(err, http.StatusNotFound) {
				return fmt.Errorf("there is no template %q. See `serve templates`", args[0])
			}
			if err != nil {
				return err
			}
			known := map[string]bool{}
			for _, v := range t.Vars {
				known[v.Key] = true
			}
			for k := range values {
				if !known[k] {
					return usagef("%s has no value %s. It has: %s", t.Name, k, strings.Join(varKeys(t.Vars), ", "))
				}
			}
			// Values the template leaves empty for the user, like the dashboard's configure step.
			for _, v := range t.Vars {
				if _, ok := values[v.Key]; ok || v.Automatic() || v.Value != "" || !ui.Interactive {
					continue
				}
				label := v.Key
				if v.Label != "" {
					label = v.Label + " (" + v.Key + ")"
				}
				got, err := ui.Input(label, "", "")
				if err != nil {
					return err
				}
				values[v.Key] = got
			}
			p, link, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			env, err := a.defaultEnvironment(ctx, p.ID, link)
			if err != nil {
				return err
			}
			if name == "" {
				name = t.Name
			}
			body := map[string]any{
				"type": "compose", "projectId": p.ID, "environmentId": env.ID, "name": name,
				"mode": "inline", "template": t.ID, "vars": values, "deploy": true,
			}
			if server != "" || ui.Interactive {
				id, err := a.pickServer(ctx, server)
				if err != nil {
					return err
				}
				if id != "" {
					body["serverId"] = id
				}
			}
			if t.Note != "" {
				ui.Info("%s", t.Note)
			}
			var r map[string]any
			if err := c.Post(ctx, "/services", body, &r); err != nil {
				return err
			}
			id := idOf(r)
			if id == "" {
				return errors.New("the new stack's id was not in the server's answer")
			}
			s, err := c.Service(ctx, id)
			if err != nil {
				return err
			}
			ui.Success("Created %s from the %s template in %s / %s.", ui.Bold(s.Name), t.Name, p.Name, env.Name)
			if err := a.startedAfterCreate(ctx, s, noWait); err != nil {
				return err
			}
			if !noWait {
				if u := a.serviceURL(ctx, s); u != "" {
					ui.Info("Open it at %s", u)
				}
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&a.project, "project", "p", "", "project name or id (default: the linked one)")
	f.StringVarP(&name, "name", "n", "", "the stack's name (default: the template's)")
	f.StringVar(&server, "server", "", "the server (name or id) to run it on (default: the one Serve runs on)")
	f.StringArrayVar(&set, "set", nil, "set a value: KEY=value (repeat it for more)")
	f.BoolVar(&noWait, "no-wait", false, "do not wait for the deployment to end")
	_ = cmd.RegisterFlagCompletionFunc("server", a.completeServers)
	return cmd
}

func varKeys(vars []api.TemplateVar) []string {
	out := make([]string, len(vars))
	for i, v := range vars {
		out[i] = v.Key
	}
	return out
}
