package cmd

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// scopeProject is the project a project-scoped command works on: --project, the linked one, or
// a pick (the only project, or a choice when someone can be asked). The link, when it was used,
// comes back too: its environment is the default one.
func (a *App) scopeProject(ctx context.Context) (*api.Project, *config.Link, error) {
	if _, err := a.Client(); err != nil {
		return nil, nil, err
	}
	if a.project != "" {
		p, err := a.findProject(ctx, a.project)
		return p, nil, err
	}
	if l := a.linkFor(a.workDir()); l != nil {
		p, err := a.findProject(ctx, l.ProjectID)
		if err != nil {
			return nil, nil, fmt.Errorf("the linked project %s no longer exists (or this login cannot see it). Pass --project, or run `serve link` again", orName(l.ProjectName, l.ProjectID))
		}
		return p, l, nil
	}
	p, err := a.pickProject(ctx)
	return p, nil, err
}

// defaultEnvironment is --env, the linked environment when the project is the linked one, or
// else the project's production environment (its first one when it has none of that name).
func (a *App) defaultEnvironment(ctx context.Context, projectID string, link *config.Link) (*api.Environment, error) {
	if a.environment != "" {
		return a.findEnvironment(ctx, projectID, a.environment)
	}
	envs, err := a.client.Environments(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if len(envs) == 0 {
		return nil, errors.New("this project has no environments. Create one with `serve environments create <name>`")
	}
	if link != nil && link.ProjectID == projectID {
		for i := range envs {
			if envs[i].ID == link.EnvironmentID {
				return &envs[i], nil
			}
		}
	}
	for i := range envs {
		if strings.EqualFold(envs[i].Name, "production") {
			return &envs[i], nil
		}
	}
	return &envs[0], nil
}

func (a *App) projectCreateCmd() *cobra.Command {
	var description string
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "create <name>",
		Aliases: []string{"new"},
		Short:   "Create a project",
		Long:    "Create a project. It starts with one environment, production.",
		Example: "  serve projects create shop\n  serve projects create shop --description \"The web shop\"",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			name := strings.TrimSpace(args[0])
			if name == "" {
				return usagef("the project name is empty")
			}
			body := map[string]any{"name": name}
			if cmd.Flags().Changed("description") {
				body["description"] = description
			}
			var r struct {
				Project      api.Project       `json:"project"`
				Environments []api.Environment `json:"environments"`
			}
			if err := c.Post(ctx, "/projects", body, &r); err != nil {
				return err
			}
			if asJSON {
				return printJSON(r)
			}
			envs := make([]string, len(r.Environments))
			for i, e := range r.Environments {
				envs[i] = e.Name
			}
			ui.Success("Created the project %s (environment %s).", ui.Bold(r.Project.Name), strings.Join(envs, ", "))
			ui.Line(ui.Dim(fmt.Sprintf("Add an app with `serve services create --project %s`, or link a folder with `serve init --project %s`.", quoteArg(r.Project.Name), quoteArg(r.Project.Name))))
			return nil
		},
	}
	cmd.Flags().StringVarP(&description, "description", "d", "", "a short description")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) projectRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "rename <project> <new name>",
		Aliases: []string{"mv"},
		Short:   "Rename a project",
		Long:    "Give a project a new name. Its services, environments and links keep working.",
		Example: "  serve projects rename shop store",
		Args:    exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, err := a.findProject(ctx, args[0])
			if err != nil {
				return err
			}
			name := strings.TrimSpace(args[1])
			if name == "" {
				return usagef("the new name is empty")
			}
			if name == p.Name {
				ui.Info("The project is already called %s.", name)
				return nil
			}
			if err := a.client.Patch(ctx, "/projects/"+api.P(p.ID), map[string]any{"name": name}, nil); err != nil {
				return err
			}
			ui.Success("Renamed the project %s to %s.", p.Name, ui.Bold(name))
			return nil
		},
	}
}

func (a *App) projectShowCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "show [project]",
		Aliases: []string{"info"},
		Short:   "Show a project: its environments and how many services each has",
		Long:    "Show a project (the one named, else the linked one): its environments and how many services each has.",
		Example: "  serve projects show\n  serve projects show shop --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 1 {
				a.project = args[0]
			}
			ref, _, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			p, err := a.client.Project(ctx, ref.ID)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(p)
			}
			count := map[string]int{}
			total := 0
			for _, s := range p.Services {
				if s.ParentServiceID == nil {
					count[s.EnvironmentID]++
					total++
				}
			}
			fmt.Fprintln(ui.Out, ui.OutBold(p.Name))
			ui.KV([][2]string{
				{"ID", p.ID},
				{"Description", deref(p.Description)},
				{"Created", ui.Ago(p.CreatedAt)},
				{"Services", fmt.Sprint(total)},
			})
			fmt.Fprintln(ui.Out)
			var rows [][]string
			for _, e := range p.Environments {
				rows = append(rows, []string{e.Name, fmt.Sprint(count[e.ID]), e.ID})
			}
			ui.Table([]string{"ENVIRONMENT", "SERVICES", "ID"}, rows)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

// quoteArg quotes a name with spaces for a command to copy.
func quoteArg(s string) string {
	if strings.ContainsAny(s, " \t'\"") {
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}
