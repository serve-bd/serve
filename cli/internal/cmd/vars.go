package cmd

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/dotenv"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// sharedScope is one place shared variables live.
type sharedScope struct {
	kind string // organization, project or environment
	name string // the project or environment name, for messages
	path string // the API path of its variables
	ref  string // how services use a variable: ${{<ref>.KEY}}
}

func (sc sharedScope) label() string {
	if sc.kind == "organization" {
		return "the organization"
	}
	return fmt.Sprintf("the %s %s", sc.kind, sc.name)
}

var scopeNames = map[string]string{
	"organization": "organization", "org": "organization",
	"project": "project", "proj": "project",
	"environment": "environment", "env": "environment",
}

// sharedScope finds the organization, or the project or environment of --service, --project,
// --env or the link. ask says whether a missing project may be picked from a list.
func (a *App) sharedScope(ctx context.Context, kind string, ask bool) (*sharedScope, error) {
	if kind == "organization" {
		if _, err := a.Client(); err != nil {
			return nil, err
		}
		return &sharedScope{kind: kind, name: "", path: "/variables", ref: "org"}, nil
	}
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var projectID, projectName, envID, envName string
	switch {
	case a.service != "":
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return nil, err
		}
		projectID, projectName, envID = s.ProjectID, s.Project, s.EnvironmentID
	case a.project != "":
		p, err := a.findProject(ctx, a.project)
		if err != nil {
			return nil, err
		}
		projectID, projectName = p.ID, p.Name
	default:
		if l := a.linkFor("."); l != nil {
			projectID, projectName, envID, envName = l.ProjectID, l.ProjectName, l.EnvironmentID, l.EnvironmentName
		} else if !ask || !ui.Interactive {
			return nil, usagef("this folder is not linked to a project. Pass --project (and --env), or run `serve link`")
		} else {
			p, err := a.pickProject(ctx)
			if err != nil {
				return nil, err
			}
			projectID, projectName = p.ID, p.Name
		}
	}
	if kind == "project" {
		if projectName == "" {
			if p, err := a.findProject(ctx, projectID); err == nil {
				projectName = p.Name
			}
		}
		return &sharedScope{kind: kind, name: orName(projectName, projectID), path: "/projects/" + api.P(projectID) + "/variables", ref: "project"}, nil
	}
	if a.environment != "" || envID == "" {
		if envID == "" && !ask && a.environment == "" {
			return nil, usagef("pass --env to name the environment")
		}
		e, err := a.pickEnvironment(ctx, projectID)
		if err != nil {
			return nil, err
		}
		envID, envName = e.ID, e.Name
	} else if envName == "" || a.service != "" {
		if envs, err := c.Environments(ctx, projectID); err == nil {
			for _, e := range envs {
				if e.ID == envID {
					envName = e.Name
				}
			}
		}
	}
	return &sharedScope{kind: kind, name: orName(envName, envID), path: "/environments/" + api.P(envID) + "/variables", ref: "shared"}, nil
}

func (a *App) varsCmd() *cobra.Command {
	var scope string
	var reveal, asJSON, redeploy bool
	cmd := &cobra.Command{
		Use:     "vars",
		Aliases: []string{"shared"},
		Short:   "Read and change shared variables (organization, project, environment)",
		Long: `Read and change shared variables: ones every service of the organization, a project or
an environment can use, as ${{org.KEY}}, ${{project.KEY}} or ${{shared.KEY}}. The service's own
variables are under ` + "`serve env`" + `.

--scope picks where: organization, project or environment (of the linked folder, or --project
and --env). Without --scope, ls shows all three. Values are hidden unless --reveal.`,
		Example: "  serve vars\n  serve vars set API_URL=https://api.example.com --scope project\n  serve vars unset OLD_KEY --scope environment --env staging\n  serve vars ls --scope organization --reveal",
	}
	list := func(cmd *cobra.Command, args []string) error {
		ctx := cmd.Context()
		var list []*sharedScope
		if scope != "" {
			kind, ok := scopeNames[strings.ToLower(scope)]
			if !ok {
				return usagef("--scope must be organization, project or environment")
			}
			sc, err := a.sharedScope(ctx, kind, true)
			if err != nil {
				return err
			}
			list = append(list, sc)
		} else {
			org, err := a.sharedScope(ctx, "organization", false)
			if err != nil {
				return err
			}
			list = append(list, org)
			// The project and environment only when they are known without asking.
			if a.service != "" || a.project != "" || a.linkFor(".") != nil {
				for _, kind := range []string{"project", "environment"} {
					sc, err := a.sharedScope(ctx, kind, false)
					if err != nil {
						var ue *usageError
						if errors.As(err, &ue) {
							continue
						}
						return err
					}
					list = append(list, sc)
				}
			}
		}
		type scoped struct {
			Scope     string          `json:"scope"`
			Name      string          `json:"name,omitempty"`
			Variables []api.SharedVar `json:"variables"`
		}
		var all []scoped
		for _, sc := range list {
			vars, err := a.client.SharedVars(ctx, sc.path)
			if err != nil {
				return fmt.Errorf("%s: %w", sc.label(), err)
			}
			if vars == nil {
				vars = []api.SharedVar{}
			}
			all = append(all, scoped{sc.kind, sc.name, vars})
		}
		if asJSON {
			if !reveal {
				for _, s := range all {
					for i := range s.Variables {
						s.Variables[i].Value = nil
					}
				}
			}
			if scope != "" {
				return printJSON(all[0].Variables)
			}
			return printJSON(all)
		}
		var rows [][]string
		hidden := false
		for i, s := range all {
			for _, v := range s.Variables {
				val := ui.OutDim("(hidden)")
				if v.Value != nil {
					val = mask(*v.Value)
					if reveal {
						val = strings.ReplaceAll(*v.Value, "\n", `\n`)
					}
				} else {
					hidden = true
				}
				where := s.Scope
				if s.Name != "" {
					where += " " + s.Name
				}
				rows = append(rows, []string{v.Key, val, where, ui.OutDim("${{" + list[i].ref + "." + v.Key + "}}")})
			}
		}
		if len(rows) == 0 {
			names := make([]string, len(list))
			for i, sc := range list {
				names[i] = sc.label()
			}
			hint := "project"
			if scope != "" {
				hint = list[0].kind
			}
			ui.Info("No shared variables in %s. Add one with `serve vars set KEY=value --scope %s`.", strings.Join(names, ", "), hint)
			return nil
		}
		ui.Table([]string{"KEY", "VALUE", "SCOPE", "USE AS"}, rows)
		if hidden {
			ui.Line(ui.Dim("Values are hidden: " + noSecrets + "."))
		} else if !reveal {
			ui.Line(ui.Dim("Pass --reveal to show the values."))
		}
		return nil
	}
	cmd.RunE = list
	cmd.Args = noArgs
	pf := cmd.PersistentFlags()
	pf.StringVar(&scope, "scope", "", "organization, project or environment")
	pf.StringVarP(&a.project, "project", "p", "", "the project (`name` or id) instead of the linked one")
	pf.BoolVar(&asJSON, "json", false, "print JSON (ls)")
	pf.BoolVar(&reveal, "reveal", false, "show the values (ls)")
	ls := &cobra.Command{Use: "ls", Aliases: []string{"list"}, Short: "List shared variables (values masked unless --reveal)", Args: noArgs, RunE: list}

	// change reads the scope's variables, applies the changes and writes them all back (the API
	// replaces the whole list).
	change := func(cmd *cobra.Command, apply func(map[string]string) (string, error)) error {
		if scope == "" {
			return usagef("pass --scope organization, project or environment")
		}
		kind, ok := scopeNames[strings.ToLower(scope)]
		if !ok {
			return usagef("--scope must be organization, project or environment")
		}
		if redeploy && kind != "environment" {
			return usagef("--redeploy works with --scope environment only; redeploy the services with `serve redeploy`")
		}
		ctx := cmd.Context()
		sc, err := a.sharedScope(ctx, kind, true)
		if err != nil {
			return err
		}
		vars, err := a.client.SharedVars(ctx, sc.path)
		if err != nil {
			return err
		}
		m := map[string]string{}
		for _, v := range vars {
			if v.Value == nil {
				return errors.New("this login cannot read the values of shared variables (it needs the variables.view-secrets permission), so it cannot change them without losing the others")
			}
			m[v.Key] = *v.Value
		}
		done, err := apply(m)
		if err != nil {
			return err
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make([]map[string]string, len(keys))
		for i, k := range keys {
			out[i] = map[string]string{"key": k, "value": m[k]}
		}
		body := map[string]any{"variables": out}
		if kind == "environment" {
			body["redeploy"] = redeploy
		}
		var r struct {
			Redeployed int `json:"redeployed"`
		}
		if err := a.client.PutJSON(ctx, sc.path, body, &r); err != nil {
			return err
		}
		ui.Success("%s in %s.", done, sc.label())
		switch {
		case redeploy:
			ui.Line(ui.Dim(fmt.Sprintf("Redeploying %d service(s) that use them.", r.Redeployed)))
		default:
			ui.Line(ui.Dim("Services pick this up on their next deploy."))
		}
		return nil
	}

	set := &cobra.Command{
		Use:     "set KEY=value...",
		Short:   "Set one or more shared variables",
		Long:    "Set one or more shared variables in the --scope. The others stay.",
		Example: "  serve vars set API_URL=https://api.example.com --scope project\n  serve vars set LOG_LEVEL=debug --scope environment --env staging --redeploy",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			changes := map[string]any{}
			for _, arg := range args {
				k, v, ok := strings.Cut(arg, "=")
				if !ok || !dotenv.ValidKey(k) {
					return usagef("%q is not KEY=value", arg)
				}
				changes[k] = v
			}
			return change(cmd, func(m map[string]string) (string, error) {
				for k, v := range changes {
					m[k] = v.(string)
				}
				return "Set " + keyList(changes), nil
			})
		},
	}
	unset := &cobra.Command{
		Use:     "unset KEY...",
		Aliases: []string{"rm"},
		Short:   "Remove one or more shared variables",
		Long:    "Remove shared variables from the --scope. Services that still use them get an empty value on their next deploy.",
		Example: "  serve vars unset OLD_KEY --scope project",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return change(cmd, func(m map[string]string) (string, error) {
				removed := map[string]any{}
				var missing []string
				for _, k := range args {
					if _, ok := m[k]; ok {
						delete(m, k)
						removed[k] = nil
					} else {
						missing = append(missing, k)
					}
				}
				if len(removed) == 0 {
					return "", fmt.Errorf("there is no shared variable %s there", strings.Join(missing, ", "))
				}
				if len(missing) > 0 {
					ui.Warn("Not there, so skipped: %s", strings.Join(missing, ", "))
				}
				return "Removed " + keyList(removed), nil
			})
		},
	}
	for _, c := range []*cobra.Command{set, unset} {
		c.Flags().BoolVar(&redeploy, "redeploy", false, "with --scope environment: deploy its services again so the change applies now")
	}
	cmd.AddCommand(ls, set, unset)
	return cmd
}
