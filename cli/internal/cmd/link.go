package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) linkCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "link [path]",
		Short: "Link this folder to a service",
		Long: `Link a project folder to a service, so deploy, logs, env and the other commands know
which one to use. Pick the project, environment and service, or pass --project,
--env and --service. The link is saved in .serve/project.json.`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) > 0 {
				dir = args[0]
			}
			_, err := a.link(cmd.Context(), dir, anyService)
			return err
		},
	}
	cmd.Flags().StringVarP(&a.project, "project", "p", "", "project name or id")
	return cmd
}

// link picks a service (from flags or prompts) and saves the link of dir.
func (a *App) link(ctx context.Context, dir string, kind serviceKind) (*config.Link, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var s *api.Service
	if a.service != "" {
		projectID, envID := "", ""
		if a.project != "" {
			p, err := a.findProject(ctx, a.project)
			if err != nil {
				return nil, err
			}
			projectID = p.ID
			if a.environment != "" {
				env, err := a.findEnvironment(ctx, p.ID, a.environment)
				if err != nil {
					return nil, err
				}
				envID = env.ID
			}
		}
		if s, err = a.findService(ctx, a.service, projectID, envID); err != nil {
			return nil, err
		}
	} else {
		p, err := a.pickProject(ctx)
		if err != nil {
			return nil, err
		}
		env, err := a.pickEnvironment(ctx, p.ID)
		if err != nil {
			return nil, err
		}
		if s, err = a.pickService(ctx, p.ID, env.ID, kind); err != nil {
			return nil, err
		}
	}
	return a.saveLink(ctx, c, dir, s)
}

func (a *App) saveLink(ctx context.Context, c *api.Client, dir string, s *api.Service) (*config.Link, error) {
	envName := ""
	if envs, err := c.Environments(ctx, s.ProjectID); err == nil {
		for _, e := range envs {
			if e.ID == s.EnvironmentID {
				envName = e.Name
			}
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	orgID, orgName := a.login.OrgID, a.login.OrgName
	if orgID == "" {
		if me, err := c.Me(ctx); err == nil {
			orgID, orgName = me.Organization.ID, me.Organization.Name
		}
	}
	l := &config.Link{
		OrgID: orgID, OrgName: orgName,
		URL:       a.login.URL,
		ProjectID: s.ProjectID, ProjectName: s.Project,
		EnvironmentID: s.EnvironmentID, EnvironmentName: envName,
		ServiceID: s.ID, ServiceName: s.Name,
	}
	changed, err := config.WriteLink(abs, l)
	if err != nil {
		return nil, fmt.Errorf("cannot save the link: %w", err)
	}
	ui.Success("Linked %s to %s.", ui.Bold(filepath.Base(abs)), ui.Bold(s.Project+" / "+envName+" / "+s.Name))
	if changed {
		ui.Line(ui.Dim("Added .serve/ to .gitignore."))
	}
	return l, nil
}

func (a *App) unlinkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unlink [path]",
		Short: "Remove the link of this folder",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) > 0 {
				dir = args[0]
			}
			l := config.FindLink(dir)
			if l == nil {
				return errors.New("this folder is not linked")
			}
			if err := config.RemoveLink(l.Dir); err != nil {
				return err
			}
			ui.Success("Removed the link to %s.", orName(l.ServiceName, l.ServiceID))
			return nil
		},
	}
}

func (a *App) initCmd() *cobra.Command {
	var name, server, newProject string
	var port int
	cmd := &cobra.Command{
		Use:   "init [path]",
		Short: "Create an app for this folder and link it",
		Long: `Create a new app that is deployed from this folder with serve deploy (no git
repository needed), then link the folder to it. The name defaults to the folder's name.`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if port < 0 || port > 65535 {
				return usagef("--port must be from 1 to 65535")
			}
			dir := "."
			if len(args) > 0 {
				dir = args[0]
			}
			_, err := a.create(cmd.Context(), dir, createOptions{name: name, server: server, newProject: newProject, port: port})
			return err
		},
	}
	cmd.Flags().StringVarP(&a.project, "project", "p", "", "project name or id")
	cmd.Flags().StringVar(&newProject, "new-project", "", "create a new project with this name")
	cmd.Flags().StringVarP(&name, "name", "n", "", "app name (default: the folder name)")
	cmd.Flags().StringVar(&server, "server", "", "server name or id")
	cmd.Flags().IntVar(&port, "port", 0, "port the app listens on (optional)")
	return cmd
}

type createOptions struct {
	name, server, newProject string
	port                     int
}

var nameChars = regexp.MustCompile(`[^a-zA-Z0-9-]+`)

// defaultName turns a folder name into a service name.
func defaultName(dir string) string {
	abs, _ := filepath.Abs(dir)
	n := strings.Trim(nameChars.ReplaceAllString(strings.ToLower(filepath.Base(abs)), "-"), "-")
	if n == "" {
		return "app"
	}
	return n
}

// create makes an upload app and links dir to it.
func (a *App) create(ctx context.Context, dir string, o createOptions) (*config.Link, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", dir)
	}
	name := o.name
	if name == "" {
		name = defaultName(dir)
		if ui.Interactive {
			if name, err = ui.Input("App name", name, name); err != nil {
				return nil, err
			}
			if name == "" {
				name = defaultName(dir)
			}
		}
	}

	var projectID, projectName string
	if o.newProject != "" {
		var r map[string]any
		if err := c.Post(ctx, "/projects", map[string]any{"name": o.newProject}, &r); err != nil {
			return nil, err
		}
		projectID, projectName = idOf(r), o.newProject
	} else if a.project != "" {
		p, err := a.findProject(ctx, a.project)
		if err != nil {
			return nil, err
		}
		projectID, projectName = p.ID, p.Name
	} else {
		ps, err := c.Projects(ctx)
		if err != nil {
			return nil, err
		}
		opts := []ui.Option{{Label: "+ New project", Value: ""}}
		for _, p := range ps {
			opts = append(opts, ui.Option{Label: p.Name, Value: p.ID})
		}
		id, err := ui.Select("Project", opts)
		if err != nil {
			return nil, needChoice(err, "pass --project or --new-project")
		}
		if id == "" {
			pn, err := ui.Input("Project name", name, name)
			if err != nil {
				return nil, err
			}
			if pn == "" {
				pn = name
			}
			var r map[string]any
			if err := c.Post(ctx, "/projects", map[string]any{"name": pn}, &r); err != nil {
				return nil, err
			}
			projectID, projectName = idOf(r), pn
			ui.Success("Created the project %s.", ui.Bold(pn))
		} else {
			projectID = id
			for _, p := range ps {
				if p.ID == id {
					projectName = p.Name
				}
			}
		}
	}
	if projectID == "" {
		return nil, errors.New("the new project's id was not in the server's answer")
	}

	env, err := a.pickEnvironment(ctx, projectID)
	if err != nil {
		return nil, err
	}
	serverID, err := a.pickServer(ctx, o.server)
	if err != nil {
		return nil, err
	}
	port := o.port
	if port == 0 && ui.Interactive && o.name == "" {
		p, err := ui.Input("Port the app listens on (leave empty to detect it)", "3000", "")
		if err != nil {
			return nil, err
		}
		if p != "" {
			if port, err = strconv.Atoi(p); err != nil || port < 1 || port > 65535 {
				return nil, fmt.Errorf("%q is not a port number", p)
			}
		}
	}

	body := map[string]any{
		"type": "app", "projectId": projectID, "environmentId": env.ID, "name": name,
		"source": map[string]any{"type": "upload"},
	}
	if serverID != "" {
		body["serverId"] = serverID
	}
	if port > 0 {
		body["port"] = port
	}
	var r map[string]any
	if err := c.Post(ctx, "/services", body, &r); err != nil {
		return nil, err
	}
	id := idOf(r)
	if id == "" {
		return nil, errors.New("the new app's id was not in the server's answer")
	}
	s, err := c.Service(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.Project == "" {
		s.Project = projectName
	}
	ui.Success("Created the app %s in %s / %s.", ui.Bold(s.Name), projectName, env.Name)
	return a.saveLink(ctx, c, dir, s)
}

func idOf(m map[string]any) string {
	if s, ok := m["id"].(string); ok {
		return s
	}
	for _, k := range []string{"project", "service"} {
		if o, ok := m[k].(map[string]any); ok {
			if s, ok := o["id"].(string); ok {
				return s
			}
		}
	}
	return ""
}

// pickServer answers a server id: the named one, the only one, or a pick.
func (a *App) pickServer(ctx context.Context, ref string) (string, error) {
	c, err := a.Client()
	if err != nil {
		return "", err
	}
	servers, err := c.Servers(ctx)
	if err != nil {
		return "", err
	}
	if ref != "" {
		for _, s := range servers {
			if s.ID == ref || strings.EqualFold(s.Name, ref) {
				return s.ID, nil
			}
		}
		return "", fmt.Errorf("there is no server %q. See `serve servers ls`", ref)
	}
	if len(servers) <= 1 {
		// None listed: let the dashboard pick its default.
		if len(servers) == 1 {
			return servers[0].ID, nil
		}
		return "", nil
	}
	opts := make([]ui.Option, len(servers))
	for i, s := range servers {
		label := s.Name
		if s.Status != "" && s.Status != "ready" {
			label += "  " + ui.Dim(s.Status)
		}
		opts[i] = ui.Option{Label: label, Value: s.ID}
	}
	id, err := ui.Select("Server", opts)
	if err != nil {
		return "", needChoice(err, "pass --server")
	}
	return id, nil
}
