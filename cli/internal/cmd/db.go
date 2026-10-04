package cmd

import (
	"errors"
	"fmt"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) dbCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "db",
		Aliases: []string{"database"},
		Short:   "Work with databases",
	}
	var public bool
	urlCmd := &cobra.Command{
		Use:   "url [database]",
		Short: "Print the connection string of a database",
		Long: `Print the connection string of a database: the linked service when it is a
database, else one picked from its environment (or --service).

The address works from other services on the same Serve network. --public prints the
address that works from outside, when the database has a public port or a domain.`,
		Example: "  serve db url\n  serve db url postgres\n  serve db url --service postgres --public",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			// The database may be named directly: serve db url postgres.
			if len(args) == 1 {
				if a.service != "" && a.service != args[0] {
					return usagef("name the database once: %q or --service %q", args[0], a.service)
				}
				a.service = args[0]
			}
			s, err := a.target(ctx, ".", databaseService)
			if err != nil {
				return err
			}
			if s.Type != "database" {
				return fmt.Errorf("%s is not a database (it is a %s)", s.Name, s.Kind())
			}
			var r struct{ Connection api.Connection }
			if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/connection", nil, &r); err != nil {
				return err
			}
			conn := r.Connection
			if public {
				if conn.PublicURL == nil || *conn.PublicURL == "" {
					return fmt.Errorf("%s cannot be reached from outside: give it a public port or a domain in the dashboard first", s.Name)
				}
				fmt.Fprintln(ui.Out, *conn.PublicURL)
				return nil
			}
			u := conn.Variables["DATABASE_URL"]
			if u == "" {
				if _, ok := conn.Variables["HOST"]; ok {
					return errors.New(noSecrets)
				}
				return fmt.Errorf("%s has no connection string", s.Name)
			}
			fmt.Fprintln(ui.Out, u)
			return nil
		},
	}
	urlCmd.Flags().BoolVar(&public, "public", false, "the address that works from outside the server")
	cmd.AddCommand(urlCmd)
	return cmd
}
