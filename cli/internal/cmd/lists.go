package cmd

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// lsCmd makes "<name>" and "<name> ls" print the same list.
func lsCmd(use, short string, aliases []string, run func(cmd *cobra.Command, asJSON bool) error) *cobra.Command {
	var asJSON bool
	runE := func(cmd *cobra.Command, args []string) error { return run(cmd, asJSON) }
	cmd := &cobra.Command{Use: use, Aliases: aliases, Short: short, Args: noArgs, RunE: runE}
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(&cobra.Command{Use: "ls", Aliases: []string{"list"}, Short: short, Args: noArgs, RunE: runE})
	return cmd
}

func (a *App) projectsCmd() *cobra.Command {
	cmd := a.projectsList()
	cmd.AddCommand(a.projectRmCmd())
	return cmd
}

func (a *App) projectsList() *cobra.Command {
	return lsCmd("projects", "List projects", []string{"project"}, func(cmd *cobra.Command, asJSON bool) error {
		c, err := a.Client()
		if err != nil {
			return err
		}
		ps, err := c.Projects(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(ps)
		}
		if len(ps) == 0 {
			ui.Info("No projects yet. Create one with `serve init`.")
			return nil
		}
		var rows [][]string
		for _, p := range ps {
			rows = append(rows, []string{p.Name, p.ID, ui.Ago(p.CreatedAt)})
		}
		ui.Table([]string{"NAME", "ID", "CREATED"}, rows)
		return nil
	})
}

func (a *App) servicesCmd() *cobra.Command {
	var all bool
	cmd := lsCmd("services", "List services (of the linked project, or --all)", []string{"service", "svc"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		c, err := a.Client()
		if err != nil {
			return err
		}
		projectID := ""
		// Which project the list is of, and why, said above it: a link from a parent folder is easy to miss.
		scope := ""
		if a.project != "" {
			p, err := a.findProject(ctx, a.project)
			if err != nil {
				return err
			}
			projectID = p.ID
		} else if l := a.linkFor("."); l != nil && !all {
			projectID = l.ProjectID
			scope = fmt.Sprintf("Project %s (this folder is linked in %s). Use --all for every project.", l.ProjectName, displayPath(l.Dir))
		}
		list, err := c.Services(ctx, projectID, "")
		if err != nil {
			return err
		}
		var kept []api.Service
		for _, s := range list {
			if s.ParentServiceID == nil {
				kept = append(kept, s)
			}
		}
		if asJSON {
			return printJSON(kept)
		}
		if scope != "" {
			ui.Line(ui.Dim(scope))
		}
		if len(kept) == 0 {
			ui.Info("No services.")
			return nil
		}
		envNames := map[string]string{}
		projects := map[string]bool{}
		for _, s := range kept {
			projects[s.ProjectID] = true
		}
		for pid := range projects {
			if envs, err := c.Environments(ctx, pid); err == nil {
				for _, e := range envs {
					envNames[e.ID] = e.Name
				}
			}
		}
		sort.SliceStable(kept, func(i, j int) bool {
			if kept[i].Project != kept[j].Project {
				return kept[i].Project < kept[j].Project
			}
			if envNames[kept[i].EnvironmentID] != envNames[kept[j].EnvironmentID] {
				return envNames[kept[i].EnvironmentID] < envNames[kept[j].EnvironmentID]
			}
			return kept[i].Name < kept[j].Name
		})
		var rows [][]string
		for _, s := range kept {
			rows = append(rows, []string{s.Name, s.Kind(), ui.StatusColor(s.Status), s.Project + " / " + envNames[s.EnvironmentID], s.ID})
		}
		ui.Table([]string{"NAME", "TYPE", "STATUS", "PROJECT", "ID"}, rows)
		return nil
	})
	cmd.PersistentFlags().StringVarP(&a.project, "project", "p", "", "project name or id")
	cmd.PersistentFlags().BoolVarP(&all, "all", "a", false, "every project, not only the linked one")
	cmd.AddCommand(a.serviceRmCmd())
	return cmd
}

func (a *App) serversCmd() *cobra.Command {
	return lsCmd("servers", "List the servers you can deploy to", []string{"server"}, func(cmd *cobra.Command, asJSON bool) error {
		c, err := a.Client()
		if err != nil {
			return err
		}
		list, err := c.Servers(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		var rows [][]string
		for _, s := range list {
			host := deref(s.Host)
			if s.IsLocal {
				host = "this machine"
			}
			rows = append(rows, []string{s.Name, ui.StatusColor(s.Status), host, s.ID})
		}
		ui.Table([]string{"NAME", "STATUS", "HOST", "ID"}, rows)
		return nil
	})
}

func (a *App) domainsCmd() *cobra.Command {
	cmd := lsCmd("domains", "List, add and remove the service's domains", []string{"domain"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return err
		}
		list, err := a.client.Domains(ctx, s.ID)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			ui.Info("%s has no domains. Add one with `serve domains add <host>`.", s.Name)
			return nil
		}
		var rows [][]string
		for _, d := range list {
			var notes []string
			if d.Primary {
				notes = append(notes, "main")
			}
			if d.Generated {
				notes = append(notes, "generated")
			}
			rows = append(rows, []string{d.URL, ui.OutDim(strings.Join(notes, ", "))})
		}
		ui.Table([]string{"URL", ""}, rows)
		return nil
	})
	var noHTTPS bool
	add := &cobra.Command{
		Use:   "add <host>",
		Short: "Add a domain (HTTPS with a free certificate)",
		Long:  "Add a domain to the service. Point its DNS at the server first; HTTPS uses a free certificate unless --no-https.",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			host := hostOnly(args[0])
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/domains", map[string]any{"hostname": host, "https": !noHTTPS}, nil); err != nil {
				return err
			}
			ui.Success("Added %s to %s.", ui.Bold(host), s.Name)
			return nil
		},
	}
	add.Flags().BoolVar(&noHTTPS, "no-https", false, "serve plain HTTP only")
	rm := &cobra.Command{
		Use:     "rm <host>",
		Aliases: []string{"remove"},
		Short:   "Remove a domain",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			list, err := a.client.Domains(ctx, s.ID)
			if err != nil {
				return err
			}
			host := hostOnly(args[0])
			for _, d := range list {
				if strings.EqualFold(d.Hostname, host) || d.ID == args[0] {
					if err := a.client.Delete(ctx, "/domains/"+api.P(d.ID), nil, nil); err != nil {
						return err
					}
					ui.Success("Removed %s from %s.", ui.Bold(d.Hostname), s.Name)
					return nil
				}
			}
			return fmt.Errorf("%s has no domain %s", s.Name, host)
		},
	}
	cmd.AddCommand(add, rm)
	return cmd
}

// hostOnly turns "https://example.com/" into "example.com".
func hostOnly(s string) string {
	if u, err := url.Parse(s); err == nil && u.Host != "" {
		return u.Host
	}
	return strings.TrimRight(s, "/")
}

// displayPath shows a folder with the home folder as ~.
func displayPath(dir string) string {
	if home, err := os.UserHomeDir(); err == nil {
		if dir == home {
			return "~"
		}
		if rel, err := filepath.Rel(home, dir); err == nil && !strings.HasPrefix(rel, "..") {
			return filepath.Join("~", rel)
		}
	}
	return dir
}
