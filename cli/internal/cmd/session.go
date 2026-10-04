package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// linkFor answers the link of dir (or a parent) when it belongs to the login in use.
func (a *App) linkFor(dir string) *config.Link {
	l := config.FindLink(dir)
	if l == nil || a.login == nil {
		return l
	}
	if !a.login.Matches(l.URL) {
		ui.Warn("This folder is linked to %s, but you are using %s. The link is not used.", l.URL, a.login.URL)
		return nil
	}
	return l
}

// serviceKind limits which services a command can act on.
type serviceKind int

const (
	anyService serviceKind = iota
	appService
	databaseService
)

func (k serviceKind) accepts(s *api.Service) bool {
	switch k {
	case appService:
		return s.Type == "app"
	case databaseService:
		return s.Type == "database"
	}
	return true
}

// target finds the service a command works on: --service, --env with the linked service's
// name, the link, or a pick when someone can be asked.
func (a *App) target(ctx context.Context, dir string, kind serviceKind) (*api.Service, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	link := a.linkFor(dir)

	if a.service != "" {
		projectID, envID := "", ""
		if link != nil {
			projectID, envID = link.ProjectID, link.EnvironmentID
		}
		if a.environment != "" {
			if projectID == "" {
				return nil, usagef("--env needs a linked project. Pass --service with a service id instead")
			}
			env, err := a.findEnvironment(ctx, projectID, a.environment)
			if err != nil {
				return nil, err
			}
			envID = env.ID
		}
		return a.findService(ctx, a.service, projectID, envID)
	}

	if link != nil && a.environment != "" {
		env, err := a.findEnvironment(ctx, link.ProjectID, a.environment)
		if err != nil {
			return nil, err
		}
		name := link.ServiceName
		if s, err := c.Service(ctx, link.ServiceID); err == nil {
			name = s.Name
		}
		list, err := c.Services(ctx, link.ProjectID, env.ID)
		if err != nil {
			return nil, err
		}
		for i := range list {
			if strings.EqualFold(list[i].Name, name) {
				return c.Service(ctx, list[i].ID)
			}
		}
		return nil, fmt.Errorf("there is no service named %q in the %s environment", name, env.Name)
	}

	if link != nil {
		s, err := c.Service(ctx, link.ServiceID)
		if api.IsStatus(err, http.StatusNotFound) {
			return a.linkedServiceGone(ctx, link, kind)
		}
		if err != nil {
			return nil, err
		}
		if !kind.accepts(s) && kind == databaseService {
			// The folder is linked to an app; pick one of the databases next to it.
			return a.pickService(ctx, link.ProjectID, link.EnvironmentID, kind)
		}
		return s, nil
	}

	if !ui.Interactive {
		return nil, usagef("this folder is not linked to a service. Run `serve link`, or pass --service")
	}
	p, err := a.pickProject(ctx)
	if err != nil {
		return nil, err
	}
	env, err := a.pickEnvironment(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	s, err := a.pickService(ctx, p.ID, env.ID, kind)
	if err == nil && kind != databaseService {
		ui.Line(ui.Dim("Tip: run `serve link` to remember this choice for this folder."))
	}
	return s, err
}

// linkedServiceGone explains a link whose service cannot be found: another organization's, or
// deleted. It offers to link the folder again.
func (a *App) linkedServiceGone(ctx context.Context, link *config.Link, kind serviceKind) (*api.Service, error) {
	orgID, orgName := a.login.OrgID, a.login.OrgName
	if orgID == "" {
		if me, err := a.client.Me(ctx); err == nil {
			orgID, orgName = me.Organization.ID, me.Organization.Name
		}
	}
	if link.OrgID != "" && orgID != "" && link.OrgID != orgID {
		return nil, fmt.Errorf("this folder is linked to a service of the organization %s, but you are logged in to %s. Log in to %s (serve login %s) or switch with `serve context use`",
			orName(link.OrgName, link.OrgID), orName(orgName, orgID), orName(link.OrgName, link.OrgID), link.URL)
	}
	name := orName(link.ServiceName, link.ServiceID)
	if !ui.Interactive {
		return nil, fmt.Errorf("the linked service %s no longer exists (or this login cannot see it). Run `serve link` to link the folder again", name)
	}
	ui.Warn("The linked service %s no longer exists (or this login cannot see it).", name)
	ok, err := ui.Confirm("Link this folder to another service now?", true)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("run `serve link` to link the folder again")
	}
	l, err := a.link(ctx, link.Dir, kind)
	if err != nil {
		return nil, err
	}
	return a.client.Service(ctx, l.ServiceID)
}

func orName(name, id string) string {
	if name != "" {
		return name
	}
	return id
}

// findService finds a service by id, or by name: in the given project and environment first,
// then anywhere the login can see.
func (a *App) findService(ctx context.Context, ref, projectID, envID string) (*api.Service, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	all, err := c.Services(ctx, "", "")
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == ref {
			return c.Service(ctx, ref)
		}
	}
	match := func(scope func(s *api.Service) bool) []api.Service {
		var out []api.Service
		for i := range all {
			s := &all[i]
			if s.ParentServiceID == nil && (strings.EqualFold(s.Name, ref) || s.Slug == ref) && scope(s) {
				out = append(out, *s)
			}
		}
		return out
	}
	found := match(func(s *api.Service) bool {
		return (projectID == "" || s.ProjectID == projectID) && (envID == "" || s.EnvironmentID == envID)
	})
	if len(found) == 0 && envID != "" {
		return nil, fmt.Errorf("there is no service named %q in that environment", ref)
	}
	if len(found) == 0 {
		found = match(func(*api.Service) bool { return true })
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("there is no service named %q. See `serve services ls`", ref)
	case 1:
		return c.Service(ctx, found[0].ID)
	}
	lines := []string{fmt.Sprintf("%d services are named %q. Pass the id instead:", len(found), ref)}
	for _, s := range found {
		lines = append(lines, fmt.Sprintf("  %s  (project %s)", s.ID, s.Project))
	}
	return nil, errors.New(strings.Join(lines, "\n"))
}

func (a *App) findEnvironment(ctx context.Context, projectID, ref string) (*api.Environment, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	envs, err := c.Environments(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for i := range envs {
		if envs[i].ID == ref || strings.EqualFold(envs[i].Name, ref) {
			return &envs[i], nil
		}
	}
	names := make([]string, len(envs))
	for i, e := range envs {
		names[i] = e.Name
	}
	return nil, fmt.Errorf("there is no environment %q in this project. It has: %s", ref, strings.Join(names, ", "))
}

func (a *App) findProject(ctx context.Context, ref string) (*api.Project, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	ps, err := c.Projects(ctx)
	if err != nil {
		return nil, err
	}
	for i := range ps {
		if ps[i].ID == ref || strings.EqualFold(ps[i].Name, ref) {
			return &ps[i], nil
		}
	}
	return nil, fmt.Errorf("there is no project %q. See `serve projects ls`", ref)
}

func (a *App) pickProject(ctx context.Context) (*api.Project, error) {
	if a.project != "" {
		return a.findProject(ctx, a.project)
	}
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	ps, err := c.Projects(ctx)
	if err != nil {
		return nil, err
	}
	switch len(ps) {
	case 0:
		return nil, errors.New("this organization has no projects yet. Create one with `serve init`, or in the dashboard")
	case 1:
		return &ps[0], nil
	}
	opts := make([]ui.Option, len(ps))
	for i, p := range ps {
		opts[i] = ui.Option{Label: p.Name, Value: p.ID}
	}
	id, err := ui.Select("Project", opts)
	if err != nil {
		return nil, needChoice(err, "pass --project")
	}
	for i := range ps {
		if ps[i].ID == id {
			return &ps[i], nil
		}
	}
	return nil, errors.New("no project picked")
}

func (a *App) pickEnvironment(ctx context.Context, projectID string) (*api.Environment, error) {
	if a.environment != "" {
		return a.findEnvironment(ctx, projectID, a.environment)
	}
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	envs, err := c.Environments(ctx, projectID)
	if err != nil {
		return nil, err
	}
	switch len(envs) {
	case 0:
		return nil, errors.New("this project has no environments")
	case 1:
		return &envs[0], nil
	}
	opts := make([]ui.Option, len(envs))
	for i, e := range envs {
		opts[i] = ui.Option{Label: e.Name, Value: e.ID}
	}
	id, err := ui.Select("Environment", opts)
	if err != nil {
		return nil, needChoice(err, "pass --env")
	}
	for i := range envs {
		if envs[i].ID == id {
			return &envs[i], nil
		}
	}
	return nil, errors.New("no environment picked")
}

func (a *App) pickService(ctx context.Context, projectID, envID string, kind serviceKind) (*api.Service, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	list, err := c.Services(ctx, projectID, envID)
	if err != nil {
		return nil, err
	}
	var opts []ui.Option
	for i := range list {
		s := &list[i]
		if s.ParentServiceID != nil || !kind.accepts(s) {
			continue
		}
		opts = append(opts, ui.Option{Label: fmt.Sprintf("%s  %s", s.Name, ui.Dim(s.Kind())), Value: s.ID})
	}
	what := "services"
	switch kind {
	case appService:
		what = "apps"
	case databaseService:
		what = "databases"
	}
	if len(opts) == 0 {
		return nil, fmt.Errorf("there are no %s in this environment", what)
	}
	if len(opts) == 1 && kind == databaseService {
		return c.Service(ctx, opts[0].Value)
	}
	sort.SliceStable(opts, func(i, j int) bool { return opts[i].Label < opts[j].Label })
	id, err := ui.Select("Service", opts)
	if err != nil {
		return nil, needChoice(err, "pass --service")
	}
	return c.Service(ctx, id)
}

// Shell completion.

func (a *App) completeServices(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := a.Client()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	list, err := c.Services(cmd.Context(), "", "")
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var out []string
	for _, s := range list {
		if s.ParentServiceID == nil {
			out = append(out, s.Name+"\t"+s.Project+" ("+s.Kind()+")")
		}
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func (a *App) completeContexts(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	cfg, err := a.config()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	var out []string
	if _, state := config.ReadHost(); state == config.HostReadable {
		out = append(out, config.LocalContext+"\tthis server's Serve")
	}
	for _, c := range cfg.Contexts {
		out = append(out, c.Name+"\t"+c.URL)
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

// serviceURL is the address of the main domain of a service, or "".
func (a *App) serviceURL(ctx context.Context, s *api.Service) string {
	c, err := a.Client()
	if err != nil {
		return ""
	}
	ds, err := c.Domains(ctx, s.ID)
	if err != nil || len(ds) == 0 {
		if len(s.Domains) > 0 {
			return s.Domains[0]
		}
		return ""
	}
	best := ds[0]
	for _, d := range ds {
		if d.Primary {
			return d.URL
		}
		if best.Generated && !d.Generated {
			best = d
		}
	}
	return best.URL
}

// dashboardURL is the page of a service in the dashboard.
func (a *App) dashboardURL(s *api.Service) string {
	return fmt.Sprintf("%s/projects/%s/services/%s", a.login.URL, s.ProjectID, s.ID)
}
