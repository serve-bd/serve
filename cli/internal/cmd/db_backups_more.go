package cmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// dbBackupTestCmd restores a backup into a throwaway database to prove it works.
func (a *App) dbBackupTestCmd() *cobra.Command {
	var wait bool
	cmd := &cobra.Command{
		Use:   "test <backup>",
		Short: "Test-restore a backup into a throwaway database",
		Long: `Restore a backup into a throwaway database of the same image on the database's server,
count what came back, and remove it. The result shows on the backup. <backup> is the backup's
id or latest. --wait waits for the result. The database is the linked one, or --service.`,
		Example: "  serve db backups test latest --wait",
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
			if err := a.client.Post(ctx, "/backups/"+api.P(b.ID)+"/test", nil, nil); err != nil {
				return err
			}
			hint := fmt.Sprintf("see `serve db backups -s %s`", s.Name)
			if !wait {
				ui.Success("Started testing backup %s of %s. %s.", b.ID, ui.Bold(s.Name), upper(hint))
				return nil
			}
			var done *api.Backup
			err = waitFor(ctx, "Testing backup "+b.ID, hint, func(ctx context.Context) (bool, error) {
				now, err := a.backup(ctx, s, b.ID)
				if err != nil {
					return false, err
				}
				done = now
				return deref(now.VerifyStatus) != "running", nil
			})
			if err != nil || done == nil {
				return err
			}
			if deref(done.VerifyStatus) == "failed" {
				return fmt.Errorf("the backup could not be restored: %s", firstNonEmpty(deref(done.VerifyError), "see its log in the dashboard"))
			}
			if deref(done.VerifyStatus) != "passed" {
				return fmt.Errorf("the test of backup %s stopped before it ended (Serve restarted?). Run it again", b.ID)
			}
			ui.Success("Backup %s restores: %s.", b.ID, firstNonEmpty(deref(done.VerifyDetail), "it works"))
			return nil
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "wait for the result")
	return cmd
}

// dbBackupDownloadCmd saves a backup's file and checks it against the checksum recorded for it.
func (a *App) dbBackupDownloadCmd() *cobra.Command {
	var out string
	cmd := &cobra.Command{
		Use:   "download <backup>",
		Short: "Download a backup's file",
		Long: `Save a backup's file as it is stored (an encrypted one stays encrypted: open it with
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000). The file is checked against the checksum
recorded when the backup was made. -o names the file (its own name by default; - writes to
stdout). The database is the linked one, or --service.`,
		Example: "  serve db backups download latest\n  serve db backups download b_123 -o app.dump",
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
				return fmt.Errorf("backup %s did not finish, so there is no file", b.ID)
			}
			name := firstNonEmpty(out, deref(b.Filename), b.ID)
			var w io.Writer = os.Stdout
			var f *os.File
			if name != "-" {
				f, err = os.Create(name)
				if err != nil {
					return err
				}
				defer f.Close()
				w = f
			}
			hash := sha256.New()
			header, err := a.client.Download(ctx, "/backups/"+api.P(b.ID)+"/download", io.MultiWriter(w, hash))
			if err != nil {
				if f != nil {
					os.Remove(name)
				}
				return err
			}
			want := header.Get("X-Checksum-Sha256")
			got := hex.EncodeToString(hash.Sum(nil))
			if want != "" && !strings.EqualFold(want, got) {
				if f != nil {
					f.Close()
					os.Remove(name)
				}
				return fmt.Errorf("the download does not match the backup's checksum (%s). Try again", want)
			}
			if f != nil {
				msg := "Saved %s"
				if want != "" {
					msg += " (checksum verified)"
				}
				ui.Success(msg+".", name)
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&out, "output", "o", "", "file to write (- for stdout)")
	return cmd
}

// dbBackupSettingsCmd shows the database's backup settings, and changes the ones given.
func (a *App) dbBackupSettingsCmd() *cobra.Command {
	var schedule, bucket, passphrase string
	var retention, retentionS3 int
	var copyTo []string
	var verify, noVerify, users, noUsers, encrypt, noEncrypt, noSchedule bool
	cmd := &cobra.Command{
		Use:   "settings [database]",
		Short: "Show or change a database's backup settings",
		Long: `Without flags, show the backup settings. With flags, change those: --schedule (cron),
--retention and --retention-s3 (backups kept), --bucket and --copy-to (S3 storages by
name or id), --verify (test the newest backup each day), --users (also save the server's users
and passwords; Postgres, MySQL, MariaDB), --encrypt with --passphrase or
SERVE_BACKUP_PASSPHRASE (8 characters or more), --no-encryption.`,
		Example: "  serve db backups settings\n  serve db backups settings --schedule '0 3 * * *' --retention 7\n  SERVE_BACKUP_PASSPHRASE=... serve db backups settings --encrypt --verify",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			path := "/services/" + api.P(s.ID) + "/backups/settings"
			body := map[string]any{}
			f := cmd.Flags()
			if f.Changed("schedule") {
				body["schedule"] = schedule
			}
			if noSchedule {
				body["schedule"] = nil
			}
			if f.Changed("retention") {
				body["retention"] = retention
			}
			if f.Changed("retention-s3") {
				body["retentionS3"] = retentionS3
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if f.Changed("bucket") {
				if bucket == "" || bucket == "none" {
					body["s3DestinationId"] = nil
				} else if body["s3DestinationId"], err = findStorage(ctx, c, bucket); err != nil {
					return err
				}
			}
			if f.Changed("copy-to") {
				ids := []string{}
				for _, ref := range copyTo {
					id, err := findStorage(ctx, c, ref)
					if err != nil {
						return err
					}
					ids = append(ids, id)
				}
				body["copyDestinationIds"] = ids
			}
			if verify || noVerify {
				body["verify"] = verify
			}
			if users || noUsers {
				body["users"] = users
			}
			if encrypt {
				p := firstNonEmpty(passphrase, os.Getenv("SERVE_BACKUP_PASSPHRASE"))
				if len(p) < 8 {
					return usagef("--encrypt needs a passphrase of 8 characters or more: --passphrase or SERVE_BACKUP_PASSPHRASE")
				}
				body["passphrase"] = p
			}
			if noEncrypt {
				body["passphrase"] = nil
			}
			if len(body) > 0 {
				if err := a.client.Patch(ctx, path, body, nil); err != nil {
					return err
				}
				ui.Success("Changed the backup settings of %s.", ui.Bold(s.Name))
			}
			var now map[string]any
			if err := a.client.Get(ctx, path, nil, &now); err != nil {
				return err
			}
			return printJSON(now)
		},
	}
	f := cmd.Flags()
	f.StringVar(&schedule, "schedule", "", "cron expression for automatic backups")
	f.BoolVar(&noSchedule, "no-schedule", false, "stop automatic backups")
	f.IntVar(&retention, "retention", 0, "backups kept on the server")
	f.IntVar(&retentionS3, "retention-s3", 0, "backups kept in the bucket")
	f.StringVar(&bucket, "bucket", "", "S3 storage for backups (name or id; none to stop)")
	f.StringArrayVar(&copyTo, "copy-to", nil, "also copy each backup to this S3 storage (repeat)")
	f.BoolVar(&verify, "verify", false, "test-restore the newest backup each day")
	f.BoolVar(&noVerify, "no-verify", false, "stop the daily backup test")
	f.BoolVar(&users, "users", false, "also save the server's users and passwords in backups")
	f.BoolVar(&noUsers, "no-users", false, "stop saving users and passwords in backups")
	f.BoolVar(&encrypt, "encrypt", false, "encrypt backups with --passphrase or SERVE_BACKUP_PASSPHRASE")
	f.StringVar(&passphrase, "passphrase", "", "the passphrase for --encrypt")
	f.BoolVar(&noEncrypt, "no-encryption", false, "stop encrypting backups")
	return cmd
}
