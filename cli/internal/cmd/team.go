package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// The organization, its members, roles, API tokens and activity log.

// secretStdin is where --secret-stdin and "-" files read from (tests replace it).
var secretStdin io.Reader = os.Stdin

// secretSource is a secret given by flag, by file (- for stdin) or on stdin.
type secretSource struct {
	value string
	file  string
	stdin bool
}

// read answers the secret, asking for it (hidden) on a terminal when no source was given.
// what names it in messages; flag is the base name of its flags (--password, --password-file).
func (s secretSource) read(what, flag string) (string, error) {
	n := 0
	for _, set := range []bool{s.value != "", s.file != "", s.stdin} {
		if set {
			n++
		}
	}
	if n > 1 {
		return "", usagef("give the %s once: --%s, --%s-file or --secret-stdin", what, flag, flag)
	}
	switch {
	case s.value != "":
		return s.value, nil
	case s.stdin || s.file == "-":
		return readSecretFrom(secretStdin, "stdin", what)
	case s.file != "":
		f, err := os.Open(s.file)
		if err != nil {
			return "", err
		}
		defer f.Close()
		return readSecretFrom(f, s.file, what)
	}
	v, err := ui.Password(capitalize(what))
	if err != nil {
		return "", needChoice(err, fmt.Sprintf("give the %s with --%s-file, --secret-stdin or --%s", what, flag, flag))
	}
	if v == "" {
		return "", fmt.Errorf("no %s given", what)
	}
	return v, nil
}

func readSecretFrom(r io.Reader, from, what string) (string, error) {
	b, err := io.ReadAll(io.LimitReader(r, 1<<20))
	if err != nil {
		return "", err
	}
	v := strings.TrimRight(string(b), "\r\n")
	if strings.TrimSpace(v) == "" {
		return "", fmt.Errorf("%s is empty: no %s given", from, what)
	}
	return v, nil
}

func (s *secretSource) flags(cmd *cobra.Command, flag, what string) {
	cmd.Flags().StringVar(&s.value, flag, "", "the "+what+" (it stays in your shell history: prefer --"+flag+"-file or --secret-stdin)")
	cmd.Flags().StringVar(&s.file, flag+"-file", "", "read the "+what+" from this `file` (- for stdin)")
	cmd.Flags().BoolVar(&s.stdin, "secret-stdin", false, "read the "+what+" from stdin")
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// pickOne finds the item an argument names: by id first, then by name (any case). Two items with
// the same name need the id.
func pickOne[T any](items []T, ref, what, listCmd string, id func(T) string, names func(T) []string) (*T, error) {
	for i := range items {
		if id(items[i]) == ref {
			return &items[i], nil
		}
	}
	var found []int
	for i := range items {
		for _, n := range names(items[i]) {
			if n != "" && strings.EqualFold(n, ref) {
				found = append(found, i)
				break
			}
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("there is no %s %q. See `%s`", what, ref, listCmd)
	case 1:
		return &items[found[0]], nil
	}
	ids := make([]string, len(found))
	for i, k := range found {
		ids[i] = id(items[k])
	}
	return nil, fmt.Errorf("%d %ss match %q: use the id (%s)", len(found), what, ref, strings.Join(ids, ", "))
}

// splitList turns "a,b, c" into [a b c].
func splitList(s string) []string {
	var out []string
	for p := range strings.SplitSeq(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// when formats a time in the past ("5m ago") or the future ("in 3d").
func when(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil || !t.After(time.Now()) {
		return ui.Ago(ts)
	}
	d := time.Until(t)
	switch {
	case d < time.Hour:
		return fmt.Sprintf("in %dm", int(d.Minutes())+1)
	case d < 24*time.Hour:
		return fmt.Sprintf("in %dh", int(d.Hours()))
	case d < 60*24*time.Hour:
		return fmt.Sprintf("in %dd", int(d.Hours()/24))
	}
	return t.Local().Format("2006-01-02")
}

// txt makes text from the server safe to print (no terminal escapes).
func txt(s string) string { return ui.SanitizeLine(s, false) }

// projectIDs turns project names or ids into ids.
func (a *App) projectIDs(ctx context.Context, refs []string) ([]string, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	ps, err := c.Projects(ctx)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, ref := range refs {
		p, err := pickOne(ps, ref, "project", "serve projects ls", func(p api.Project) string { return p.ID }, func(p api.Project) []string { return []string{p.Name} })
		if err != nil {
			return nil, err
		}
		if !slices.Contains(ids, p.ID) {
			ids = append(ids, p.ID)
		}
	}
	return ids, nil
}

// projectNames maps project ids to names, as far as the login can see them.
func (a *App) projectNames(ctx context.Context) map[string]string {
	m := map[string]string{}
	if ps, err := a.client.Projects(ctx); err == nil {
		for _, p := range ps {
			m[p.ID] = p.Name
		}
	}
	return m
}

func namesOf(ids []string, names map[string]string) string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = orName(names[id], id)
	}
	return strings.Join(out, ", ")
}

/* ------------------------------- Organization ------------------------------ */

func (a *App) organization(ctx context.Context) (*api.Organization, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var r struct{ Organization api.Organization }
	return &r.Organization, c.Get(ctx, "/organization", nil, &r)
}

func (a *App) orgCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "org",
		Aliases: []string{"organization"},
		Short:   "Show the organization, or rename it",
		Long:    "Show the organization this login works in: its name, slug and id.",
		Example: "  serve org\n  serve org rename \"Acme Inc\"",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			o, err := a.organization(cmd.Context())
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(o)
			}
			root := ""
			if o.Root {
				root = "yes (it manages this Serve instance)"
			}
			ui.KV([][2]string{{"Name", ui.OutBold(txt(o.Name))}, {"Slug", o.Slug}, {"ID", o.ID}, {"Root", root}, {"Logo", txt(deref(o.Logo))}, {"Created", ui.Ago(o.CreatedAt)}})
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	rename := &cobra.Command{
		Use:     "rename <name>",
		Short:   "Rename the organization",
		Long:    "Rename the organization. Its logo and slug stay. Needs the members.manage permission.",
		Example: "  serve org rename \"Acme Inc\"",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			name := strings.TrimSpace(args[0])
			if len(name) < 2 || len(name) > 60 {
				return usagef("the name must be 2 to 60 characters long")
			}
			o, err := a.organization(ctx)
			if err != nil {
				return err
			}
			// The logo is sent back as it is: the API clears a logo left out.
			if err := a.client.Patch(ctx, "/organization", map[string]any{"name": name, "logo": o.Logo}, nil); err != nil {
				return err
			}
			ui.Success("Renamed %s to %s.", txt(o.Name), ui.Bold(name))
			return nil
		},
	}
	cmd.AddCommand(rename)
	return cmd
}

/* --------------------------------- Members --------------------------------- */

func (a *App) members(ctx context.Context) (*api.Listed[api.Member], error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	return api.List[api.Member](ctx, c, "/members", "members", nil)
}

func (a *App) findMember(ctx context.Context, ref string) (*api.Member, error) {
	l, err := a.members(ctx)
	if err != nil {
		return nil, err
	}
	return pickOne(l.Items, ref, "member", "serve members ls", func(m api.Member) string { return m.ID }, func(m api.Member) []string { return []string{m.User.Email, m.User.Name, m.User.ID} })
}

func (a *App) roles(ctx context.Context) ([]api.Role, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	l, err := api.List[api.Role](ctx, c, "/roles", "roles", nil)
	if err != nil {
		return nil, err
	}
	return l.Items, nil
}

func (a *App) findRole(ctx context.Context, ref string) (*api.Role, error) {
	rs, err := a.roles(ctx)
	if err != nil {
		return nil, err
	}
	return pickOne(rs, ref, "role", "serve roles ls", func(r api.Role) string { return r.ID }, func(r api.Role) []string { return []string{r.Name} })
}

func (a *App) membersCmd() *cobra.Command {
	cmd := lsCmd("members", "List the organization's members", []string{"member"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		l, err := a.members(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		names := a.projectNames(ctx)
		var rows [][]string
		for _, m := range l.Items {
			projects := ui.OutDim("all")
			if m.ProjectIDs != nil {
				projects = txt(namesOf(m.ProjectIDs, names))
			}
			rows = append(rows, []string{txt(m.User.Name), m.User.Email, txt(m.Role), projects, ui.Ago(m.JoinedAt), m.ID})
		}
		ui.Table([]string{"NAME", "EMAIL", "ROLE", "PROJECTS", "JOINED", "ID"}, rows)
		return nil
	})
	cmd.Short = "List members, change their role or projects, remove them"
	cmd.Long = "List the organization's members, their role and the projects they reach. Invite someone with `serve invite`."
	cmd.Example = "  serve members\n  serve members set ada@example.com --role developer --projects shop,blog\n  serve members rm ada@example.com"

	var role, projects string
	var allProjects bool
	set := &cobra.Command{
		Use:   "set <member>",
		Short: "Change a member's role or the projects they reach",
		Long: `Change a member's role, the projects they reach, or both. The member is their email,
name or id; the role is a name or id from serve roles; projects are names or ids.
--all-projects gives back every project.`,
		Example: "  serve members set ada@example.com --role admin\n  serve members set ada@example.com --projects shop,blog\n  serve members set ada@example.com --all-projects",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if role == "" && projects == "" && !allProjects {
				return usagef("say what to change: --role, --projects or --all-projects")
			}
			if projects != "" && allProjects {
				return usagef("pass --projects or --all-projects, not both")
			}
			m, err := a.findMember(ctx, args[0])
			if err != nil {
				return err
			}
			body := map[string]any{}
			var done []string
			if role != "" {
				r, err := a.findRole(ctx, role)
				if err != nil {
					return err
				}
				body["roleId"] = r.ID
				done = append(done, "role "+txt(r.Name))
			}
			if allProjects {
				body["projectIds"] = nil
				done = append(done, "every project")
			} else if projects != "" {
				ids, err := a.projectIDs(ctx, splitList(projects))
				if err != nil {
					return err
				}
				if len(ids) == 0 {
					return usagef("--projects needs at least one project")
				}
				body["projectIds"] = ids
				done = append(done, "projects "+strings.Join(splitList(projects), ", "))
			}
			if err := a.client.Patch(ctx, "/members/"+api.P(m.ID), body, nil); err != nil {
				return err
			}
			ui.Success("%s now has %s.", ui.Bold(m.User.Email), strings.Join(done, " and "))
			return nil
		},
	}
	set.Flags().StringVar(&role, "role", "", "the new role (`name` or id)")
	set.Flags().StringVar(&projects, "projects", "", "only these projects (comma-separated names or ids)")
	set.Flags().BoolVar(&allProjects, "all-projects", false, "every project")

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <member>",
		Aliases: []string{"delete", "remove"},
		Short:   "Remove a member from the organization",
		Long:    "Remove a member (email, name or id) from the organization. Asks for their email unless you pass --yes. Their account stays; only the membership goes.",
		Example: "  serve members rm ada@example.com\n  serve members rm ada@example.com --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			m, err := a.findMember(ctx, args[0])
			if err != nil {
				return err
			}
			if me, err := a.client.Me(ctx); err == nil && me.User.ID == m.User.ID {
				ui.Warn("This is you: you leave the organization and this login stops working in it.")
			}
			if err := confirmName("a member", m.User.Email, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/members/"+api.P(m.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Removed %s from the organization.", ui.Bold(m.User.Email))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the email")
	cmd.AddCommand(set, rm)
	return cmd
}

func (a *App) inviteCmd() *cobra.Command {
	var role string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "invite <email>",
		Short: "Invite someone to the organization",
		Long: `Invite someone to the organization with a role (developer unless --role). When email is
set up on the instance, the invitation is sent by email; the invitation link is printed either
way, so you can send it yourself. The invitation lasts 7 days. Root admins add someone who
already has an account at once.`,
		Example: "  serve invite ada@example.com\n  serve invite ada@example.com --role admin",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			email := strings.ToLower(strings.TrimSpace(args[0]))
			if !strings.Contains(email, "@") {
				return usagef("%q is not an email address", args[0])
			}
			body := map[string]any{"email": email}
			roleName := "developer"
			if role != "" {
				r, err := a.findRole(ctx, role)
				if err != nil {
					return err
				}
				body["roleId"] = r.ID
				roleName = strings.ToLower(r.Name)
			}
			var r api.Invited
			if err := c.Post(ctx, "/invitations", body, &r); err != nil {
				return err
			}
			link := ""
			if r.ID != nil {
				link = c.BaseURL + "/invite/" + url.PathEscape(*r.ID)
			}
			if asJSON {
				return printJSON(map[string]any{"id": r.ID, "added": r.Added, "emailed": r.Emailed, "emailError": r.EmailError, "link": link})
			}
			switch {
			case r.Added:
				ui.Success("Added %s as %s: they already had an account.", ui.Bold(email), roleName)
				return nil
			case r.Emailed:
				ui.Success("Invited %s as %s. The invitation was sent by email.", ui.Bold(email), roleName)
			default:
				ui.Success("Invited %s as %s.", ui.Bold(email), roleName)
				if r.EmailError != nil {
					ui.Warn("The email could not be sent: %s", txt(*r.EmailError))
				} else {
					ui.Info("Email is not set up on this instance: send them the link.")
				}
			}
			if link != "" {
				fmt.Fprintln(ui.Out, link)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&role, "role", "", "their role (`name` or id; developer by default)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) invitationsCmd() *cobra.Command {
	list := func(ctx context.Context) (*api.Listed[api.Invitation], error) {
		c, err := a.Client()
		if err != nil {
			return nil, err
		}
		return api.List[api.Invitation](ctx, c, "/invitations", "invitations", nil)
	}
	cmd := lsCmd("invitations", "List open invitations", []string{"invitation", "invites"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := list(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No open invitations. Invite someone with `serve invite <email>`.")
			return nil
		}
		var rows [][]string
		for _, i := range l.Items {
			rows = append(rows, []string{i.Email, i.RoleID, when(i.ExpiresAt), i.ID})
		}
		ui.Table([]string{"EMAIL", "ROLE", "EXPIRES", "ID"}, rows)
		return nil
	})
	cmd.Short = "List and revoke open invitations"
	cmd.Long = "List the invitations that are still open. Needs the members.manage permission."
	cmd.Example = "  serve invitations\n  serve invitations rm ada@example.com"
	var yes bool
	rm := &cobra.Command{
		Use:     "rm <invitation>",
		Aliases: []string{"delete", "remove", "revoke"},
		Short:   "Revoke an invitation",
		Long:    "Revoke an open invitation (its email or id): its link stops working. Asks for the email unless you pass --yes.",
		Example: "  serve invitations rm ada@example.com --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			l, err := list(ctx)
			if err != nil {
				return err
			}
			i, err := pickOne(l.Items, args[0], "invitation", "serve invitations ls", func(i api.Invitation) string { return i.ID }, func(i api.Invitation) []string { return []string{i.Email} })
			if err != nil {
				return err
			}
			if err := confirmName("an invitation", i.Email, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/invitations/"+api.P(i.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Revoked the invitation of %s.", ui.Bold(i.Email))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the email")
	cmd.AddCommand(rm)
	return cmd
}

/* ---------------------------------- Roles ---------------------------------- */

func (a *App) rolesCmd() *cobra.Command {
	cmd := lsCmd("roles", "List the roles and what they may do", []string{"role"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		c, err := a.Client()
		if err != nil {
			return err
		}
		l, err := api.List[api.Role](ctx, c, "/roles", "roles", nil)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		var rows [][]string
		for _, r := range l.Items {
			kind := "custom"
			if r.Builtin != nil {
				kind = "built-in"
			}
			perms := strings.Join(r.Permissions, ", ")
			if r.Builtin != nil && (*r.Builtin == "owner" || *r.Builtin == "admin") {
				perms = "everything"
			}
			rows = append(rows, []string{txt(r.Name), r.ID, kind, perms})
		}
		ui.Table([]string{"NAME", "ID", "TYPE", "PERMISSIONS"}, rows)
		return nil
	})
	cmd.Short = "List, create, change and delete roles"
	cmd.Long = `List the built-in roles and the organization's custom roles, with their permissions.
Owner and Admin may do everything. Developer and Viewer can be adjusted (serve roles set);
custom roles can be created, changed and deleted. serve roles permissions lists the permissions.`
	cmd.Example = "  serve roles\n  serve roles create deployer --permissions projects.view,services.deploy,logs.view\n  serve roles set viewer --add logs.view"

	perms := lsCmd("permissions", "List every permission a role can have", nil, func(cmd *cobra.Command, asJSON bool) error {
		ps, raw, err := a.permissions(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(raw)
		}
		var rows [][]string
		for _, p := range ps {
			if p.ID != "admin" {
				rows = append(rows, []string{p.ID, txt(p.Description)})
			}
		}
		ui.Table([]string{"PERMISSION", "WHAT IT ALLOWS"}, rows)
		return nil
	})

	var permList, description, name, add, remove string
	create := &cobra.Command{
		Use:     "create <name>",
		Aliases: []string{"add"},
		Short:   "Create a custom role",
		Long:    "Create a custom role with the permissions listed by serve roles permissions. Needs an admin login.",
		Example: "  serve roles create deployer --permissions projects.view,services.deploy,logs.view --description \"Deploys, nothing else\"",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !cmd.Flags().Changed("permissions") {
				return usagef("give the role's permissions with --permissions (see serve roles permissions)")
			}
			list, err := a.checkPermissions(ctx, splitList(permList))
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "permissions": list}
			if description != "" {
				body["description"] = description
			}
			var r struct{ ID string }
			if err := a.client.Post(ctx, "/roles", body, &r); err != nil {
				return err
			}
			ui.Success("Created the role %s.", ui.Bold(args[0]))
			return nil
		},
	}
	create.Flags().StringVar(&permList, "permissions", "", "comma-separated permissions")
	create.Flags().StringVar(&description, "description", "", "what the role is for")

	set := &cobra.Command{
		Use:   "set <role>",
		Short: "Change a role's permissions, name or description",
		Long: `Change a role. --permissions replaces the list; --add and --remove change it.
Custom roles also take --name and --description. The built-in Developer and Viewer roles
only take permissions; Owner and Admin cannot be changed.`,
		Example: "  serve roles set viewer --add logs.view\n  serve roles set deployer --permissions projects.view,services.deploy --name releaser",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fl := cmd.Flags()
			if !fl.Changed("permissions") && add == "" && remove == "" && !fl.Changed("name") && !fl.Changed("description") {
				return usagef("say what to change: --permissions, --add, --remove, --name or --description")
			}
			if fl.Changed("permissions") && (add != "" || remove != "") {
				return usagef("pass --permissions, or --add and --remove, not both")
			}
			r, err := a.findRole(ctx, args[0])
			if err != nil {
				return err
			}
			if r.Builtin != nil {
				if *r.Builtin == "owner" || *r.Builtin == "admin" {
					return fmt.Errorf("the %s role may do everything and cannot be changed", r.Name)
				}
				if fl.Changed("name") || fl.Changed("description") {
					return usagef("the built-in %s role only takes permissions", r.Name)
				}
			}
			next := slices.Clone(r.Permissions)
			if fl.Changed("permissions") {
				next = splitList(permList)
			}
			for _, p := range splitList(add) {
				if !slices.Contains(next, p) {
					next = append(next, p)
				}
			}
			next = slices.DeleteFunc(next, func(p string) bool { return slices.Contains(splitList(remove), p) })
			if next, err = a.checkPermissions(ctx, next); err != nil {
				return err
			}
			body := map[string]any{"permissions": next}
			if r.Builtin == nil {
				body["name"] = r.Name
				if fl.Changed("name") {
					body["name"] = name
				}
				body["description"] = deref(r.Description)
				if fl.Changed("description") {
					body["description"] = description
				}
			}
			if err := a.client.Do(ctx, api.Request{Method: "PUT", Path: "/roles/" + api.P(r.ID), JSON: body}, nil); err != nil {
				return err
			}
			shown := r.Name
			if n, ok := body["name"].(string); ok {
				shown = n
			}
			ui.Success("Saved the role %s (%d permission(s)).", ui.Bold(txt(shown)), len(next))
			return nil
		},
	}
	set.Flags().StringVar(&permList, "permissions", "", "the full comma-separated list of permissions")
	set.Flags().StringVar(&add, "add", "", "permissions to add (comma-separated)")
	set.Flags().StringVar(&remove, "remove", "", "permissions to remove (comma-separated)")
	set.Flags().StringVar(&name, "name", "", "a new name (custom roles)")
	set.Flags().StringVar(&description, "description", "", "a new description (custom roles)")

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <role>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a custom role",
		Long:    "Delete a custom role. Asks for its name unless you pass --yes. Built-in roles cannot be deleted.",
		Example: "  serve roles rm deployer --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			r, err := a.findRole(ctx, args[0])
			if err != nil {
				return err
			}
			if r.Builtin != nil {
				return fmt.Errorf("%s is a built-in role and cannot be deleted", r.Name)
			}
			if err := confirmName("a role", r.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/roles/"+api.P(r.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the role %s.", ui.Bold(txt(r.Name)))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.AddCommand(perms, create, set, rm)
	return cmd
}

func (a *App) permissions(ctx context.Context) ([]api.Permission, any, error) {
	c, err := a.Client()
	if err != nil {
		return nil, nil, err
	}
	l, err := api.List[api.Permission](ctx, c, "/permissions", "permissions", nil)
	if err != nil {
		return nil, nil, err
	}
	return l.Items, l.Raw, nil
}

// checkPermissions refuses a permission the server does not know, which it would drop quietly.
func (a *App) checkPermissions(ctx context.Context, list []string) ([]string, error) {
	ps, _, err := a.permissions(ctx)
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	var ids []string
	for _, p := range ps {
		if p.ID != "admin" {
			known[p.ID] = true
			ids = append(ids, p.ID)
		}
	}
	out := []string{}
	for _, p := range list {
		if !known[p] {
			return nil, usagef("%q is not a permission. Known: %s", p, strings.Join(ids, ", "))
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out, nil
}

/* ---------------------------------- Tokens --------------------------------- */

func (a *App) tokensCmd() *cobra.Command {
	list := func(ctx context.Context) (*api.Listed[api.Token], error) {
		c, err := a.Client()
		if err != nil {
			return nil, err
		}
		return api.List[api.Token](ctx, c, "/tokens", "tokens", nil)
	}
	cmd := lsCmd("tokens", "List API tokens", []string{"token"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		l, err := list(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No API tokens. Make one with `serve tokens create <name> --access <permissions>`.")
			return nil
		}
		current := ""
		if me, err := a.client.Me(ctx); err == nil {
			current = me.Token.ID
		}
		owners := map[string]string{}
		if ms, err := a.members(ctx); err == nil {
			for _, m := range ms.Items {
				owners[m.User.ID] = orName(m.User.Email, m.User.Name)
			}
		}
		var rows [][]string
		for _, t := range l.Items {
			name := txt(t.Name)
			if t.ID == current {
				name += ui.OutDim(" (this login)")
			}
			used, expires := ui.OutDim("never"), ui.OutDim("never")
			if t.LastUsedAt != nil {
				used = ui.Ago(*t.LastUsedAt)
			}
			if t.ExpiresAt != nil {
				expires = when(*t.ExpiresAt)
			}
			rows = append(rows, []string{name, t.Prefix + "…", orName(owners[t.UserID], t.UserID), strings.Join(t.Granted, ", "), used, expires, t.ID})
		}
		ui.Table([]string{"NAME", "PREFIX", "OWNER", "ACCESS", "LAST USED", "EXPIRES", "ID"}, rows)
		return nil
	})
	cmd.Short = "List, create and revoke API tokens"
	cmd.Long = `List API tokens: your own, or every token of the organization with the members.manage
permission. serve tokens create makes one (for CI, say); serve login makes one for the CLI.`
	cmd.Example = "  serve tokens\n  serve tokens create CI --access services.deploy,projects.view --expires 90\n  serve tokens rm \"Old CI\""
	var yes bool
	rm := &cobra.Command{
		Use:     "rm <token>",
		Aliases: []string{"delete", "remove", "revoke"},
		Short:   "Revoke an API token",
		Long: `Revoke an API token (its name, id or prefix): whatever uses it stops working at once.
Asks for its name unless you pass --yes. A token can always revoke itself; other tokens need
the members.manage permission.`,
		Example: "  serve tokens rm \"Old CI\"\n  serve tokens rm srv_Yv6E09 --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			l, err := list(ctx)
			if err != nil {
				return err
			}
			ref := strings.TrimSuffix(args[0], "…")
			t, err := pickOne(l.Items, ref, "token", "serve tokens ls", func(t api.Token) string { return t.ID }, func(t api.Token) []string { return []string{t.Name, t.Prefix} })
			if err != nil {
				return err
			}
			self := false
			if me, err := a.client.Me(ctx); err == nil && me.Token.ID == t.ID {
				self = true
				ui.Warn("This is the token this login uses: the CLI is logged out once it is revoked.")
			}
			if err := confirmName("a token", t.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/tokens/"+api.P(t.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Revoked the token %s.", ui.Bold(txt(t.Name)))
			if self {
				ui.Info("Run `serve login` to log in again.")
			}
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.AddCommand(a.tokenCreateCmd(), rm)
	return cmd
}

func (a *App) tokenCreateCmd() *cobra.Command {
	var access, projects string
	var expires int
	var noExpiry bool
	cmd := &cobra.Command{
		Use:         "create <name>",
		Annotations: printsJSON,
		Short:       "Make an API token and print it once",
		Long: `Make an API token for yourself. --access is what it may do: permissions from
serve roles permissions (comma-separated), or admin; never more than this login may do.
--projects limits it to these projects (names or ids). --expires is the number of days it
lasts (1 to 3650); --no-expiry makes one that does not expire. Left out, it does not expire,
unless this login expires itself: then the new one expires with it.

The token is printed once, on standard output: it cannot be shown again. Keep it somewhere safe,
like your CI's secrets, and use it as SERVE_TOKEN with SERVE_URL.`,
		Example: "  serve tokens create CI --access services.deploy,projects.view --expires 90\n  serve tokens create backup-bot --access databases.backups --projects shop\n  serve tokens create admin-script --access admin --json",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			name := strings.TrimSpace(args[0])
			if name == "" {
				return usagef("give the token a name")
			}
			scopes := splitList(access)
			if len(scopes) == 0 {
				return usagef("say what the token may do with --access (see `serve roles permissions`), or --access admin")
			}
			fl := cmd.Flags()
			if fl.Changed("expires") && noExpiry {
				return usagef("pass --expires or --no-expiry, not both")
			}
			if fl.Changed("expires") && (expires < 1 || expires > 3650) {
				return usagef("--expires is a number of days from 1 to 3650")
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if !slices.Contains(scopes, "admin") {
				if scopes, err = a.checkPermissions(ctx, scopes); err != nil {
					return err
				}
			} else if len(scopes) > 1 {
				return usagef("admin may do everything: pass --access admin alone")
			}
			body := map[string]any{"name": name, "scopes": scopes}
			if projects != "" {
				ids, err := a.projectIDs(ctx, splitList(projects))
				if err != nil {
					return err
				}
				if len(ids) == 0 {
					return usagef("--projects needs at least one project")
				}
				body["projectIds"] = ids
			}
			if fl.Changed("expires") {
				body["expiresInDays"] = expires
			} else if noExpiry {
				body["expiresInDays"] = nil
			}
			var r struct {
				Token     string   `json:"token"`
				ID        *string  `json:"id"`
				Name      string   `json:"name"`
				Granted   []string `json:"granted"`
				ExpiresAt *string  `json:"expiresAt"`
			}
			if err := c.Post(ctx, "/tokens", body, &r); err != nil {
				return err
			}
			if r.Token == "" {
				return errors.New("the token was made, but the server's answer did not hold it. Revoke it with `serve tokens rm` and make another")
			}
			if jsonFlag(cmd) {
				return printJSON(r)
			}
			expiry := "does not expire"
			if r.ExpiresAt != nil {
				expiry = "expires " + when(*r.ExpiresAt)
			}
			ui.Success("Made the token %s (%s; %s).", ui.Bold(txt(orName(r.Name, name))), strings.Join(scopes, ", "), expiry)
			ui.Warn("It is shown only this once. Copy it now.")
			fmt.Fprintln(ui.Out, r.Token)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&access, "access", "", "permissions, comma-separated (or admin)")
	f.StringVar(&projects, "projects", "", "only these projects (comma-separated names or ids)")
	f.IntVar(&expires, "expires", 0, "days until it expires (1 to 3650)")
	f.BoolVar(&noExpiry, "no-expiry", false, "make a token that does not expire")
	return cmd
}

/* --------------------------------- Activity -------------------------------- */

// activityPage is the most the API answers at once; longer lists are read page by page.
const activityPage = 200

func (a *App) activityCmd() *cobra.Command {
	var limit int
	var asJSON bool
	var project string
	cmd := &cobra.Command{
		Use:   "activity",
		Short: "Show the organization's activity log",
		Long: `Show what happened in the organization, newest first: deploys, changes, members,
integrations. --project shows one project's activity only.`,
		Example: "  serve activity\n  serve activity --limit 200 --project shop\n  serve activity --json",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if limit < 1 {
				return usagef("--limit must be at least 1")
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			q := url.Values{}
			if project != "" {
				p, err := a.findProject(ctx, project)
				if err != nil {
					return err
				}
				q.Set("projectId", p.ID)
			}
			var items []api.Activity
			var raw []any
			for len(items) < limit {
				n := min(limit-len(items), activityPage)
				q.Set("limit", strconv.Itoa(n))
				q.Set("offset", strconv.Itoa(len(items)))
				l, err := api.List[api.Activity](ctx, c, "/activity", "activity", q)
				if err != nil {
					return err
				}
				items = append(items, l.Items...)
				for _, r := range l.Raw {
					raw = append(raw, r)
				}
				if len(l.Items) < n {
					break
				}
			}
			if asJSON {
				if raw == nil {
					raw = []any{}
				}
				return printJSON(raw)
			}
			if len(items) == 0 {
				ui.Info("Nothing happened yet.")
				return nil
			}
			var rows [][]string
			for _, e := range items {
				who := ui.OutDim("Serve")
				if e.User != nil {
					who = txt(e.User.Name)
				}
				rows = append(rows, []string{ui.Ago(e.CreatedAt), who, txt(e.Message)})
			}
			ui.Table([]string{"WHEN", "WHO", "WHAT"}, rows)
			return nil
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 50, "how many entries to show")
	cmd.Flags().StringVarP(&project, "project", "p", "", "only this project (`name` or id)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}
