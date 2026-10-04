package cmd

import (
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

var accessLabels = map[string]string{"read": "read only", "readwrite": "read and write", "owner": "full access"}

func printLogin(u *api.DatabaseUserLogin, withPassword bool) {
	pairs := [][2]string{}
	if withPassword {
		pairs = append(pairs, [2]string{"Password", u.Password})
	}
	pairs = append(pairs, [2]string{"URL", u.PrivateURL}, [2]string{"Public URL", deref(u.PublicURL)})
	ui.KV(pairs)
}

func (a *App) dbUsersCmd() *cobra.Command {
	cmd := dbListCmd("users", "List, add and remove the users of a database",
		`List the logins inside a running PostgreSQL, MySQL, MariaDB or MongoDB database, with the
access Serve gave the ones it made. Logins of Serve itself, of branches and of the database are
shown but not changed here. Passwords are printed only by serve db users password and url.`,
		"  serve db users\n  serve db users create reporting --access read\n  serve db users url reporting",
		func(cmd *cobra.Command, args []string, asJSON bool) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			r, err := a.client.DatabaseUsers(ctx, s.ID)
			if err != nil {
				return err
			}
			if asJSON {
				r.Users = orEmpty(r.Users)
				r.Databases = orEmpty(r.Databases)
				return printJSON(r)
			}
			var rows [][]string
			for _, u := range r.Users {
				access := accessLabels[deref(u.Access)]
				note := ""
				switch {
				case u.ProtectedReason != nil:
					note = deref(u.ProtectedReason)
				case !u.Managed:
					note = "made outside Serve"
				case !u.KnowsPassword:
					note = "password not known to Serve"
				}
				rows = append(rows, []string{u.Username, access, strings.Join(u.Databases, ","), ui.OutDim(note)})
			}
			ui.Table([]string{"USER", "ACCESS", "DATABASES", ""}, rows)
			return nil
		})

	var access string
	var databases []string
	create := &cobra.Command{
		Use:   "create <user>",
		Short: "Add a user to a database",
		Long: `Add a login to the database with a new random password. --access is read, readwrite
(the default) or owner, on the databases named with --database (the main one by default).
Print its password and connection string afterwards with serve db users url <user>. The
database is the linked one, or --service.`,
		Example: "  serve db users create reporting --access read\n  serve db users create etl -d app -d analytics -s postgres",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if _, ok := accessLabels[access]; !ok {
				return usagef("--access is read, readwrite or owner")
			}
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			list := databases
			if len(list) == 0 {
				main := s.DatabaseInfo().Database
				if main == "" {
					return usagef("name the database to give access to with --database")
				}
				list = []string{main}
			}
			body := map[string]any{"username": args[0], "access": access, "databases": list}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/users", body, nil); err != nil {
				return err
			}
			ui.Success("Added the user %s to %s (%s on %s).", ui.Bold(args[0]), s.Name, accessLabels[access], strings.Join(list, ", "))
			ui.Line(ui.Dim(fmt.Sprintf("Print its connection string with `serve db users url %s -s %s`.", args[0], s.Name)))
			return nil
		},
	}
	create.Flags().StringVar(&access, "access", "readwrite", "read, readwrite or owner")
	create.Flags().StringArrayVarP(&databases, "database", "d", nil, "a database to give access to (repeat for more; default: the main one)")

	var rmYes bool
	rm := &cobra.Command{
		Use:     "rm <user>",
		Aliases: []string{"delete", "remove"},
		Short:   "Remove a user from a database",
		Long: `Remove a login from the database. On PostgreSQL, what the user made is given to the main
login first. Asks for the user's name unless --yes.`,
		Example: "  serve db users rm reporting\n  serve db users rm reporting -s postgres --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			if err := confirmName("a user", args[0], rmYes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/services/"+api.P(s.ID)+"/users/"+api.P(args[0]), nil, nil); err != nil {
				return err
			}
			ui.Success("Removed the user %s from %s.", ui.Bold(args[0]), s.Name)
			return nil
		},
	}
	rm.Flags().BoolVarP(&rmYes, "yes", "y", false, "do not ask for the user's name")

	var pwYes bool
	password := &cobra.Command{
		Use:         "password <user>",
		Annotations: printsJSON,
		Short:       "Give a database user a new password and print it",
		Long: `Change the password of a login to a new random one, and print it with the connection
strings. Whatever uses the old password stops working. Asks first unless --yes.`,
		Example: "  serve db users password reporting\n  serve db users password reporting --yes --json",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			if err := confirmYes(fmt.Sprintf("Change the password of %s in %s? The old one stops working.", args[0], s.Name), "change the password", pwYes); err != nil {
				return err
			}
			var r struct{ User api.DatabaseUserLogin }
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/users/"+api.P(args[0])+"/password", map[string]any{}, &r); err != nil {
				return err
			}
			if asJSON, _ := cmd.Flags().GetBool("json"); asJSON {
				return printJSON(r.User)
			}
			ui.Success("Changed the password of %s.", ui.Bold(args[0]))
			printLogin(&r.User, true)
			return nil
		},
	}
	password.Flags().BoolVarP(&pwYes, "yes", "y", false, "do not ask first")

	var public bool
	url := &cobra.Command{
		Use:   "url <user>",
		Short: "Print the connection string of a database user",
		Long: `Print the connection string of a login Serve made (or gave a password). --public prints
the one that works from outside, when the database has a public port or a domain.`,
		Example: "  serve db users url reporting\n  serve db users url reporting --public",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			var r struct{ User api.DatabaseUserLogin }
			if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/users/"+api.P(args[0])+"/connection", nil, &r); err != nil {
				return err
			}
			if public {
				if deref(r.User.PublicURL) == "" {
					return fmt.Errorf("%s cannot be reached from outside: give it a public port or a domain in the dashboard first", s.Name)
				}
				fmt.Fprintln(ui.Out, *r.User.PublicURL)
				return nil
			}
			fmt.Fprintln(ui.Out, r.User.PrivateURL)
			return nil
		},
	}
	url.Flags().BoolVar(&public, "public", false, "the address that works from outside the server")

	cmd.AddCommand(create, rm, password, url)
	return cmd
}
