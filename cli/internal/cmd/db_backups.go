package cmd

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// backup finds a backup of the database by id, or "latest": the newest one that succeeded.
func (a *App) backup(ctx context.Context, s *api.Service, ref string) (*api.Backup, error) {
	list, err := a.client.Backups(ctx, s.ID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		b := &list[i]
		if ref == "latest" && b.Status == "success" || b.ID == ref {
			return b, nil
		}
	}
	if ref == "latest" {
		return nil, fmt.Errorf("%s has no finished backup yet. Make one with `serve db backups create -s %s`", s.Name, s.Name)
	}
	return nil, fmt.Errorf("%s has no backup %q. See `serve db backups -s %s`", s.Name, ref, s.Name)
}

func backupWhen(b *api.Backup) string {
	return ui.Ago(b.CreatedAt)
}

func (a *App) dbBackupsCmd() *cobra.Command {
	cmd := dbListCmd("backups", "List, make, restore and delete backups of a database",
		`List the backups of the database, newest first: the linked one, the one you name, or
--service. Subcommands make a backup now, restore one and delete one.`,
		"  serve db backups\n  serve db backups postgres --json\n  serve db backups create --wait\n  serve db backups restore latest",
		func(cmd *cobra.Command, args []string, asJSON bool) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			list, err := a.client.Backups(ctx, s.ID)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(orEmpty(list))
			}
			if len(list) == 0 {
				ui.Info("%s has no backups. Make one with `serve db backups create -s %s`.", s.Name, s.Name)
				return nil
			}
			var rows [][]string
			for i := range list {
				b := &list[i]
				size := ""
				if b.Size != nil {
					size = ui.Bytes(*b.Size)
				}
				status := ui.StatusColor(b.Status)
				if b.Status == "failed" && deref(b.Error) != "" {
					status += " " + ui.OutDim(firstLine(deref(b.Error)))
				}
				restore := ""
				switch deref(b.RestoreStatus) {
				case "running":
					restore = ui.StatusColor("restoring")
				case "success":
					restore = "restored " + ui.Ago(deref(b.RestoredAt))
				case "failed":
					restore = ui.StatusColor("failed")
				}
				rows = append(rows, []string{b.ID, backupWhen(b), status, b.Trigger, size, strings.Join(b.Databases, ","), restore})
			}
			ui.Table([]string{"ID", "CREATED", "STATUS", "TRIGGER", "SIZE", "DATABASES", "RESTORE"}, rows)
			return nil
		})

	var createWait, all bool
	var databases []string
	create := &cobra.Command{
		Use:   "create [database]",
		Short: "Back up a database now",
		Long: `Back up the database now. Without --database the backup takes what the database's
backup settings choose (the main database by default); --database takes the ones named, and
--all every database on it. --wait waits until the backup ends.`,
		Example: "  serve db backups create\n  serve db backups create postgres --wait\n  serve db backups create --database app --database analytics",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if all && len(databases) > 0 {
				return usagef("pass --all or --database, not both")
			}
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			body := map[string]any{}
			if all {
				body["databases"] = []string{"*"}
			} else if len(databases) > 0 {
				body["databases"] = databases
			}
			var r struct {
				ID string `json:"id"`
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/backups", body, &r); err != nil {
				return err
			}
			hint := fmt.Sprintf("see `serve db backups -s %s`", s.Name)
			if !createWait || r.ID == "" {
				ui.Success("Started a backup of %s (%s). %s.", ui.Bold(s.Name), r.ID, upper(hint))
				return nil
			}
			var done *api.Backup
			err = waitFor(ctx, "Backing up "+s.Name, hint, func(ctx context.Context) (bool, error) {
				b, err := a.backup(ctx, s, r.ID)
				if err != nil {
					return false, err
				}
				done = b
				return b.Status != "running", nil
			})
			if err != nil || done == nil || done.Status == "running" {
				return err
			}
			if done.Status == "failed" {
				return fmt.Errorf("the backup failed: %s", firstNonEmpty(deref(done.Error), "see its log in the dashboard"))
			}
			size := ""
			if done.Size != nil {
				size = " (" + ui.Bytes(*done.Size) + ")"
			}
			ui.Success("Backed up %s%s. Backup %s.", ui.Bold(s.Name), size, done.ID)
			return nil
		},
	}
	create.Flags().BoolVar(&createWait, "wait", false, "wait until the backup ends")
	create.Flags().StringArrayVarP(&databases, "database", "d", nil, "a database on the server to take (repeat for more)")
	create.Flags().BoolVar(&all, "all", false, "take every database on the server, new ones included")

	var restoreWait, restoreYes, backupFirst, users bool
	var into, passphrase string
	var only, renames, tables []string
	restore := &cobra.Command{
		Use:   "restore <backup>",
		Short: "Restore a backup, replacing the database's data",
		Long: `Restore a backup into the database it was taken from, replacing its data. <backup> is the
backup's id (see serve db backups) or latest, the newest one that finished.

--backup-first backs up the current data before restoring. --users also restores the dump's
users, passwords and roles (Serve's own accounts keep theirs). --into restores into another
database service of the same kind. --database restores only the databases named, --as db=new
under another name, --table only some tables of the one database. An encrypted backup made with
another passphrase takes --passphrase (or SERVE_BACKUP_PASSPHRASE). Asks for the database's name
unless --yes. --wait waits until the restore ends. The database is the linked one, or --service.
Only organization admins can restore.`,
		Example: "  serve db backups restore latest --wait\n  serve db backups restore b_123 -s postgres --backup-first --yes\n  serve db backups restore latest --into staging-db --yes\n  serve db backups restore latest --database shop --as shop=shop_copy\n  serve db backups restore latest --table public.orders --table public.items",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			b, err := a.backup(ctx, s, args[0])
			if err != nil {
				return err
			}
			if b.Status != "success" {
				return fmt.Errorf("backup %s did not finish (it is %s), so it cannot be restored", b.ID, b.Status)
			}
			if deref(b.RestoreStatus) == "running" {
				return fmt.Errorf("backup %s is being restored already", b.ID)
			}
			if !restoreYes {
				ui.Warn("This replaces the data of %s with the backup from %s (%s).", s.Name, backupWhen(b), b.ID)
			}
			if err := confirmTyped("restore it", s.Name, restoreYes); err != nil {
				return err
			}
			body := map[string]any{"backupFirst": backupFirst, "users": users}
			if into != "" {
				target, err := a.findService(ctx, into, s.ProjectID, s.EnvironmentID)
				if err != nil {
					return err
				}
				body["into"] = target.ID
			}
			if len(only) > 0 {
				body["databases"] = only
			}
			if len(renames) > 0 {
				m := map[string]string{}
				for _, r := range renames {
					from, to, ok := strings.Cut(r, "=")
					if !ok || to == "" {
						return usagef("write --as as <database>=<new name>")
					}
					m[from] = to
				}
				body["renames"] = m
			}
			if len(tables) > 0 {
				body["tables"] = tables
			}
			if p := firstNonEmpty(passphrase, os.Getenv("SERVE_BACKUP_PASSPHRASE")); p != "" {
				body["passphrase"] = p
			}
			if err := a.client.Post(ctx, "/backups/"+api.P(b.ID)+"/restore", body, nil); err != nil {
				return err
			}
			hint := fmt.Sprintf("see the RESTORE column of `serve db backups -s %s`", s.Name)
			if !restoreWait {
				ui.Success("Started restoring %s from backup %s. %s.", ui.Bold(s.Name), b.ID, upper(hint))
				return nil
			}
			var status string
			err = waitFor(ctx, "Restoring "+s.Name, hint, func(ctx context.Context) (bool, error) {
				now, err := a.backup(ctx, s, b.ID)
				if err != nil {
					return false, err
				}
				status = deref(now.RestoreStatus)
				return status != "running", nil
			})
			if err != nil {
				return err
			}
			switch status {
			case "success":
				ui.Success("Restored %s from backup %s.", ui.Bold(s.Name), b.ID)
			case "failed":
				return fmt.Errorf("the restore failed. See the backup's log in the dashboard: %s", a.dashboardURL(s))
			}
			return nil
		},
	}
	restore.Flags().BoolVar(&restoreWait, "wait", false, "wait until the restore ends")
	restore.Flags().BoolVarP(&restoreYes, "yes", "y", false, "do not ask for the database's name")
	restore.Flags().BoolVar(&backupFirst, "backup-first", false, "back up the current data first")
	restore.Flags().BoolVar(&users, "users", false, "also restore the dump's users and passwords")
	restore.Flags().StringVar(&into, "into", "", "restore into another database service of the same kind")
	restore.Flags().StringArrayVar(&only, "database", nil, "only this database of the backup (repeat for more)")
	restore.Flags().StringArrayVar(&renames, "as", nil, "restore a database under another name: <database>=<new name> (repeat)")
	restore.Flags().StringArrayVar(&tables, "table", nil, "only this table of the one database (repeat; Postgres as schema.table)")
	restore.Flags().StringVar(&passphrase, "passphrase", "", "passphrase of an encrypted backup made with another one")

	var rmYes bool
	rm := &cobra.Command{
		Use:     "rm <backup>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a backup",
		Long: `Delete a backup and its files (on the server and in S3). Asks for the backup's id unless
--yes. The database is the linked one, or --service.`,
		Example: "  serve db backups rm b_123\n  serve db backups rm b_123 -s postgres --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, nil)
			if err != nil {
				return err
			}
			b, err := a.backup(ctx, s, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("a backup", b.ID, rmYes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/backups/"+api.P(b.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted backup %s of %s.", b.ID, ui.Bold(s.Name))
			return nil
		},
	}
	rm.Flags().BoolVarP(&rmYes, "yes", "y", false, "do not ask for the backup's id")
	cmd.AddCommand(create, restore, rm, a.dbBackupTestCmd(), a.dbBackupDownloadCmd(), a.dbBackupSettingsCmd())
	return cmd
}
