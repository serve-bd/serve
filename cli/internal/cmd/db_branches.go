package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// branch finds a branch of the database by name or id.
func (a *App) branch(ctx context.Context, s *api.Service, ref string) (*api.Branch, []api.Branch, error) {
	list, err := a.client.Branches(ctx, s.ID)
	if err != nil {
		return nil, nil, err
	}
	for i := range list {
		if list[i].ID == ref || list[i].Name == ref {
			return &list[i], list, nil
		}
	}
	return nil, list, fmt.Errorf("%s has no branch %q. See `serve db branches -s %s`", s.Name, ref, s.Name)
}

// waitBranch waits until a branch is ready or failed.
func (a *App) waitBranch(ctx context.Context, s *api.Service, id, msg string) error {
	var now *api.Branch
	hint := fmt.Sprintf("see `serve db branches -s %s`", s.Name)
	err := waitFor(ctx, msg, hint, func(ctx context.Context) (bool, error) {
		b, _, err := a.branch(ctx, s, id)
		if err != nil {
			return false, err
		}
		now = b
		return b.Status == "ready" || b.Status == "failed", nil
	})
	if err != nil || now == nil {
		return err
	}
	switch now.Status {
	case "ready":
		ui.Success("Branch %s of %s is ready.", ui.Bold(now.Name), s.Name)
	case "failed":
		return fmt.Errorf("branch %s failed: %s", now.Name, firstNonEmpty(deref(now.Error), "see the dashboard"))
	}
	return nil
}

func (a *App) dbBranchesCmd() *cobra.Command {
	cmd := dbListCmd("branches", "List, make, reset and delete branches of a database",
		`List the branches of the database: copies of its data inside the same container, each
with a login of its own. Apps reach one with ${{<database>.branches.<name>.DATABASE_URL}}.`,
		"  serve db branches\n  serve db branches create staging --wait\n  serve db branches reset staging\n  serve db branches rm staging",
		func(cmd *cobra.Command, args []string, asJSON bool) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			list, err := a.client.Branches(ctx, s.ID)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(orEmpty(list))
			}
			if len(list) == 0 {
				ui.Info("%s has no branches. Make one with `serve db branches create <name> -s %s`.", s.Name, s.Name)
				return nil
			}
			names := map[string]string{}
			for _, b := range list {
				names[b.ID] = b.Name
			}
			var rows [][]string
			for _, b := range list {
				size := ""
				if b.SizeBytes != nil {
					size = ui.Bytes(*b.SizeBytes)
				}
				var notes []string
				if id := deref(b.SourceBranchID); id != "" {
					notes = append(notes, "from "+orName(names[id], id))
				}
				if b.PersonalDataHidden {
					notes = append(notes, "personal data hidden")
				}
				if b.AllDatabases {
					notes = append(notes, "every database")
				}
				if b.PreviewServiceID != nil {
					notes = append(notes, "preview")
				}
				status := ui.StatusColor(b.Status)
				if b.Status == "failed" && deref(b.Error) != "" {
					status += " " + ui.OutDim(firstLine(deref(b.Error)))
				}
				copied := ""
				if b.CopiedAt != nil {
					copied = ui.Ago(*b.CopiedAt)
				}
				rows = append(rows, []string{b.Name, status, b.Database, size, copied, ui.OutDim(strings.Join(notes, ", "))})
			}
			ui.Table([]string{"NAME", "STATUS", "DATABASE", "SIZE", "COPIED", ""}, rows)
			return nil
		})

	var from string
	var hide, allDatabases, createWait bool
	create := &cobra.Command{
		Use:   "create <name>",
		Short: "Make a branch: a copy of the database's data",
		Long: `Make a branch: a copy of the database's data inside the same container, with a login of
its own. --from copies another ready branch instead of the main data. --hide-personal-data runs
the database's clean-up SQL on the copy (set it first with serve db branches cleanup-sql).
--all-databases also copies every other database on the server. --wait waits until the copy
is ready.`,
		Example: "  serve db branches create staging --wait\n  serve db branches create demo --hide-personal-data -s postgres",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0]}
			if hide {
				body["hidePersonalData"] = true
			}
			if allDatabases {
				body["allDatabases"] = true
			}
			if from != "" {
				src, _, err := a.branch(ctx, s, from)
				if err != nil {
					return err
				}
				body["sourceBranchId"] = src.ID
			}
			var r struct {
				ID string `json:"id"`
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/branches", body, &r); err != nil {
				return err
			}
			if !createWait || r.ID == "" {
				ui.Success("Started branch %s of %s. See `serve db branches -s %s`.", ui.Bold(args[0]), s.Name, s.Name)
				return nil
			}
			return a.waitBranch(ctx, s, r.ID, "Copying "+s.Name+" into "+args[0])
		},
	}
	create.Flags().StringVar(&from, "from", "", "copy this branch (`name` or id) instead of the main data")
	create.Flags().BoolVar(&hide, "hide-personal-data", false, "run the clean-up SQL on the copy")
	create.Flags().BoolVar(&allDatabases, "all-databases", false, "also copy every other database on the server")
	create.Flags().BoolVar(&createWait, "wait", false, "wait until the branch is ready")

	var resetYes, resetWait bool
	reset := &cobra.Command{
		Use:   "reset <branch>",
		Short: "Copy the data into a branch again",
		Long: `Replace a branch's data with a fresh copy of the main database (or of the branch it was
copied from). What was written to the branch is lost. Asks first unless --yes. --wait waits
until the copy is ready.`,
		Example: "  serve db branches reset staging --wait",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			b, _, err := a.branch(ctx, s, args[0])
			if err != nil {
				return err
			}
			if err := confirmYes(fmt.Sprintf("Copy the data into branch %s again? What was written to it is lost.", b.Name), "reset the branch", resetYes); err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/branches/"+api.P(b.ID)+"/reset", map[string]any{}, nil); err != nil {
				return err
			}
			if !resetWait {
				ui.Success("Copying the data into branch %s again. See `serve db branches -s %s`.", ui.Bold(b.Name), s.Name)
				return nil
			}
			return a.waitBranch(ctx, s, b.ID, "Copying "+s.Name+" into "+b.Name)
		},
	}
	reset.Flags().BoolVarP(&resetYes, "yes", "y", false, "do not ask first")
	reset.Flags().BoolVar(&resetWait, "wait", false, "wait until the copy is ready")

	var rmYes, children bool
	rm := &cobra.Command{
		Use:     "rm <branch>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a branch and its data",
		Long: `Delete a branch, its data and its login. Branches copied from it stay (and copy the main
data on their next reset) unless --children, which deletes them too. Asks for the branch's name
unless --yes.`,
		Example: "  serve db branches rm staging\n  serve db branches rm staging --children --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			b, list, err := a.branch(ctx, s, args[0])
			if err != nil {
				return err
			}
			if children {
				var kids []string
				var walk func(id string)
				walk = func(id string) {
					for _, c := range list {
						if deref(c.SourceBranchID) == id {
							kids = append(kids, c.Name)
							walk(c.ID)
						}
					}
				}
				walk(b.ID)
				if len(kids) > 0 {
					ui.Warn("This also deletes %s.", strings.Join(kids, ", "))
				}
			}
			if err := confirmName("a branch", b.Name, rmYes); err != nil {
				return err
			}
			q := map[bool]string{true: "true", false: "false"}[children]
			if err := a.client.Delete(ctx, "/branches/"+api.P(b.ID), map[string][]string{"children": {q}}, nil); err != nil {
				return err
			}
			ui.Success("Deleted branch %s of %s.", ui.Bold(b.Name), s.Name)
			return nil
		},
	}
	rm.Flags().BoolVarP(&rmYes, "yes", "y", false, "do not ask for the branch's name")
	rm.Flags().BoolVar(&children, "children", false, "also delete the branches copied from it")

	var clearSQL bool
	cleanup := &cobra.Command{
		Use:   "cleanup-sql <sql | ->",
		Short: "Set the SQL that hides personal data in branches",
		Long: `Set the clean-up SQL of the database: it runs on the copy of every branch made with
--hide-personal-data, like "UPDATE users SET email = id || '@example.com';". - reads it from
standard input. It replaces the SQL saved before; --clear removes it. Branches made already
are not changed. The database is the linked one, or --service.`,
		Example: "  serve db branches cleanup-sql \"UPDATE users SET email = id || '@example.com';\"\n  serve db branches cleanup-sql - < scrub.sql\n  serve db branches cleanup-sql --clear",
		Args: func(cmd *cobra.Command, args []string) error {
			if clearSQL {
				return noArgs(cmd, args)
			}
			return exactArgs(1)(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			var sql any
			if !clearSQL {
				text, err := readArg(args[0], "SQL")
				if err != nil {
					return err
				}
				if strings.TrimSpace(text) == "" {
					return usagef("the SQL is empty. Pass --clear to remove it")
				}
				sql = text
			}
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			if err := a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+"/branches/cleanup-sql", map[string]any{"sql": sql}, nil); err != nil {
				return err
			}
			if clearSQL {
				ui.Success("Removed the clean-up SQL of %s.", ui.Bold(s.Name))
			} else {
				ui.Success("Saved the clean-up SQL of %s. Branches made with --hide-personal-data run it.", ui.Bold(s.Name))
			}
			return nil
		},
	}
	cleanup.Flags().BoolVar(&clearSQL, "clear", false, "remove the clean-up SQL")

	cmd.AddCommand(create, reset, rm, cleanup)
	return cmd
}
