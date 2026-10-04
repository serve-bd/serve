package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// serve environments: the environments of a project (serve env is the service's variables).
func (a *App) environmentsCmd() *cobra.Command {
	cmd := lsCmd("environments", "List, create, clone, deploy and delete a project's environments", []string{"environment", "envs"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		p, link, err := a.scopeProject(ctx)
		if err != nil {
			return err
		}
		envs, err := a.client.Environments(ctx, p.ID)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(envs)
		}
		counts, err := a.serviceCounts(ctx, p.ID)
		if err != nil {
			return err
		}
		ui.Line(ui.Dim("Project " + p.Name))
		var rows [][]string
		for _, e := range envs {
			name := e.Name
			if link != nil && link.EnvironmentID == e.ID {
				name += ui.OutDim(" (linked)")
			}
			rows = append(rows, []string{name, fmt.Sprint(counts[e.ID]), e.ID})
		}
		ui.Table([]string{"NAME", "SERVICES", "ID"}, rows)
		return nil
	})
	cmd.Long = `List the environments of a project: the linked one, or --project. Each environment
has its own copy of the services, variables and domains.

Variables of a service are under serve env; this command is about the environments themselves.`
	cmd.Example = "  serve environments\n  serve envs create staging\n  serve envs clone production staging\n  serve envs deploy staging\n  serve envs rm staging"
	cmd.PersistentFlags().StringVarP(&a.project, "project", "p", "", "project name or id (default: the linked one)")
	cmd.AddCommand(a.envCreateCmd(), a.envRmCmd(), a.envCloneCmd(), a.envDeployCmd())
	return cmd
}

// serviceCounts answers how many services (previews left out) each environment of a project has.
func (a *App) serviceCounts(ctx context.Context, projectID string) (map[string]int, error) {
	list, err := a.client.Services(ctx, projectID, "")
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, s := range list {
		if s.ParentServiceID == nil {
			counts[s.EnvironmentID]++
		}
	}
	return counts, nil
}

func (a *App) envCreateCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "create <name>",
		Aliases: []string{"new", "add"},
		Short:   "Create an empty environment",
		Long:    "Create an empty environment in the project. To start from a copy of another one, use `serve environments clone`.",
		Example: "  serve environments create staging\n  serve envs create qa --project shop",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, _, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			var r struct {
				Environment api.Environment `json:"environment"`
			}
			if err := a.client.Post(ctx, "/projects/"+api.P(p.ID)+"/environments", map[string]any{"name": args[0]}, &r); err != nil {
				return err
			}
			if asJSON {
				return printJSON(r.Environment)
			}
			ui.Success("Created the environment %s in %s.", ui.Bold(r.Environment.Name), p.Name)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) envRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <name>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete an environment with its services and their data",
		Long: `Delete an environment. Its services go with it, data volumes included. A project
keeps at least one environment. Asks for the environment's name unless you pass --yes.`,
		Example: "  serve environments rm staging\n  serve envs rm pr-12 --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, _, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			env, err := a.findEnvironment(ctx, p.ID, args[0])
			if err != nil {
				return err
			}
			list, err := a.client.Services(ctx, p.ID, env.ID)
			if err != nil {
				return err
			}
			var names, ids []string
			for _, s := range list {
				ids = append(ids, s.ID)
				if s.ParentServiceID == nil {
					names = append(names, s.Name)
				}
			}
			if len(names) > 0 {
				ui.Warn("This also deletes %d service(s) and their data: %s.", len(names), strings.Join(names, ", "))
			}
			if err := confirmName("an environment", env.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/environments/"+api.P(env.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the environment %s of %s.", ui.Bold(env.Name), p.Name)
			forgetLinksTo(ids...)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}

func (a *App) envCloneCmd() *cobra.Command {
	var noDomains, copyData, asJSON bool
	cmd := &cobra.Command{
		Use:     "clone <from> <new name>",
		Aliases: []string{"copy"},
		Short:   "Copy an environment and all its services into a new one",
		Long: `Make a new environment with a copy of every service of another one: settings, variables
and shared variables. The copies get generated addresses of their own (unless --no-domains);
custom domains stay with the original. Databases start empty unless --copy-data. Nothing is
deployed: run serve environments deploy <new name> when you are ready.`,
		Example: "  serve environments clone production staging\n  serve envs clone production qa --copy-data",
		Args:    exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, _, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			from, err := a.findEnvironment(ctx, p.ID, args[0])
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[1], "generatedDomains": !noDomains, "copyData": copyData}
			var r struct {
				EnvironmentID string `json:"environmentId"`
				Services      []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"services"`
				Variables       int      `json:"variables"`
				SharedVariables int      `json:"sharedVariables"`
				Domains         int      `json:"domains"`
				Notes           []string `json:"notes"`
				CopyingData     bool     `json:"copyingData"`
			}
			var raw json.RawMessage
			if err := a.client.Post(ctx, "/environments/"+api.P(from.ID)+"/clone", body, &raw); err != nil {
				return err
			}
			if asJSON {
				return printJSON(raw)
			}
			if err := json.Unmarshal(raw, &r); err != nil {
				return err
			}
			ui.Success("Cloned %s into %s: %d service(s), %d variable(s), %d shared variable(s), %d domain(s).",
				from.Name, ui.Bold(args[1]), len(r.Services), r.Variables, r.SharedVariables, r.Domains)
			for _, n := range r.Notes {
				ui.Info("  %s", n)
			}
			if r.CopyingData {
				ui.Info("The databases are copying their data now.")
			}
			ui.Line(ui.Dim(fmt.Sprintf("Nothing is deployed yet. Deploy it with `serve environments deploy %s`.", quoteArg(args[1]))))
			return nil
		},
	}
	cmd.Flags().BoolVar(&noDomains, "no-domains", false, "do not give the copies generated addresses")
	cmd.Flags().BoolVar(&copyData, "copy-data", false, "copy the data of databases too")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) envDeployCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "deploy <name>",
		Short: "Deploy every service of an environment",
		Long: `Queue a deployment of every service of an environment (after a clone, for example).
Preview deployments are left alone. The deployments run on the server; follow one with
serve logs --build -f --service <id>.`,
		Example: "  serve environments deploy staging",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, _, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			env, err := a.findEnvironment(ctx, p.ID, args[0])
			if err != nil {
				return err
			}
			var r struct {
				Count int `json:"count"`
			}
			if err := a.client.Post(ctx, "/environments/"+api.P(env.ID)+"/deploy", nil, &r); err != nil {
				return err
			}
			if r.Count == 0 {
				ui.Info("%s has no services to deploy.", env.Name)
				return nil
			}
			ui.Success("Queued %d deployment(s) in %s.", r.Count, ui.Bold(env.Name))
			ui.Line(ui.Dim(fmt.Sprintf("See them with `serve services --project %s`, and follow one with `serve logs --build -f --service <id>`.", quoteArg(p.Name))))
			return nil
		},
	}
	return cmd
}
