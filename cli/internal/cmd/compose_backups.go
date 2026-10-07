package cmd

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

type composeBackup struct {
	Schedule           *string  `json:"schedule"`
	Retention          int      `json:"retention"`
	RetentionS3        *int     `json:"retentionS3"`
	S3DestinationID    *string  `json:"s3DestinationId"`
	Local              *bool    `json:"local"`
	TimeoutMinutes     *int     `json:"timeoutMinutes"`
	LowPriority        bool     `json:"lowPriority"`
	Encrypted          bool     `json:"encrypted"`
	CopyDestinationIDs []string `json:"copyDestinationIds"`
}

// composeBackupPath is the URL of one backup. The key goes through three decodings on the way
// (the dashboard's route parameters, the API router, the handler): a key with "/" or "%" (a
// directory) is encoded three times so that no "/" splits the path. Other keys are encoded once,
// which any number of decodings leaves as it is.
func composeBackupPath(serviceID, key string) string {
	k := api.P(key)
	if strings.ContainsAny(key, "/%") {
		k = url.PathEscape(url.PathEscape(url.PathEscape(key)))
	}
	return "/services/" + api.P(serviceID) + "/compose-backups/" + k
}

func checkBackupKey(key string) error {
	kind, name, ok := strings.Cut(key, ":")
	if !ok || name == "" || (kind != "db" && kind != "volume" && kind != "dir") {
		return usagef("%q is not a backup: write db:<compose service>, volume:<volume name> or dir:<path>", key)
	}
	return nil
}

// composeTarget is the stack or app whose storage backups a command works on.
func (a *App) composeTarget(ctx context.Context, args []string) (*api.Service, error) {
	if len(args) == 1 {
		if err := a.serviceArg(args[0]); err != nil {
			return nil, err
		}
	}
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return nil, err
	}
	if s.Type != "compose" && s.Type != "app" {
		return nil, fmt.Errorf("%s is a %s: these backups are for compose stacks and apps. Back up a database with `serve db backups`", s.Name, s.Kind())
	}
	return s, nil
}

func (a *App) composeBackupsCmd() *cobra.Command {
	var asJSON bool
	list := func(cmd *cobra.Command, args []string) error {
		ctx := cmd.Context()
		s, err := a.composeTarget(ctx, args)
		if err != nil {
			return err
		}
		var r struct {
			Backups map[string]composeBackup `json:"backups"`
		}
		if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/compose-backups", nil, &r); err != nil {
			return err
		}
		if r.Backups == nil {
			r.Backups = map[string]composeBackup{}
		}
		if asJSON {
			return printJSON(r.Backups)
		}
		if len(r.Backups) == 0 {
			ui.Info("%s backs up nothing. Add a backup with `serve compose-backups set <db:service | volume:name | dir:path> -s %s`.", s.Name, s.Name)
			return nil
		}
		keys := make([]string, 0, len(r.Backups))
		for k := range r.Backups {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		storages := map[string]string{}
		for _, b := range r.Backups {
			if b.S3DestinationID != nil {
				storages = a.storageNames(ctx)
				break
			}
		}
		var rows [][]string
		for _, k := range keys {
			b := r.Backups[k]
			kept := strconv.Itoa(b.Retention)
			bucket := ""
			if id := deref(b.S3DestinationID); id != "" {
				bucket = orName(storages[id], id)
				if b.RetentionS3 != nil {
					kept += fmt.Sprintf(" (%d in S3)", *b.RetentionS3)
				}
				if b.Local != nil && !*b.Local {
					bucket += " only"
				}
			}
			enc := ""
			if b.Encrypted {
				enc = "yes"
			}
			rows = append(rows, []string{txt(k), orName(deref(b.Schedule), ui.OutDim("manual")), kept, bucket, enc})
		}
		ui.Table([]string{"BACKUP", "SCHEDULE", "KEPT", "S3", "ENCRYPTED"}, rows)
		return nil
	}
	cmd := &cobra.Command{
		Use:     "compose-backups [service]",
		Aliases: []string{"compose-backup"},
		Short:   "List and set up backups of a compose stack's databases, volumes and folders",
		Long: `List what a compose stack (or an app) backs up: a database container (db:<compose
service>), a volume (volume:<name>) or a folder (dir:<path>), with each one's schedule, how many
backups are kept and where. Subcommands set one up, change it and stop it. Works on the linked
service, the one named, or --service. Backups of a Serve database are under serve db backups.`,
		Example: "  serve compose-backups\n  serve compose-backups set db:postgres --schedule '0 3 * * *' --retention 14\n  serve compose-backups rm volume:uploads",
		Args:    maxArgs(1),
		RunE:    list,
	}
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(&cobra.Command{Use: "ls [service]", Aliases: []string{"list"}, Short: "Print the list (the same as compose-backups alone)", Args: maxArgs(1), RunE: list})
	cmd.AddCommand(a.composeBackupSetCmd(), a.composeBackupRmCmd())
	return cmd
}

// storageNames maps S3 storage ids to names; empty when they cannot be read.
func (a *App) storageNames(ctx context.Context) map[string]string {
	out := map[string]string{}
	var r struct {
		Destinations []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"destinations"`
	}
	if a.client.Get(ctx, "/s3-destinations", nil, &r) == nil {
		for _, d := range r.Destinations {
			out[d.ID] = d.Name
		}
	}
	return out
}

func (a *App) composeBackupSetCmd() *cobra.Command {
	var schedule, bucket, passphrase string
	var retention, retentionS3, timeout int
	var copyTo []string
	var noSchedule, local, lowPriority, encrypt, noEncrypt bool
	cmd := &cobra.Command{
		Use:     "set <backup>",
		Aliases: []string{"add"},
		Short:   "Set up or change a backup of a compose stack",
		Long: `Set up a backup (made when missing; manual until it has a schedule) or change one. The
backup is db:<compose service> (a database container: a dump), volume:<name> or dir:<path>
(a folder the stack mounts). Only the flags you pass change:

  --schedule, --no-schedule    a cron expression for automatic backups, or manual only
  --retention                  backups kept on the server (1 to 365)
  --bucket, --retention-s3     an S3 storage (name or id; none to stop) and backups kept there
  --copy-to                    also copy each backup to this S3 storage (repeat; none for no copies)
  --local=false                with a bucket, keep backups in the bucket only
  --timeout                    minutes a dump may take (0: no limit; database dumps)
  --low-priority               dump at the lowest CPU priority (database dumps)
  --encrypt, --no-encryption   encrypt with --passphrase or SERVE_BACKUP_PASSPHRASE (8+ characters)

Changing backups needs an admin of the organization.`,
		Example: "  serve compose-backups set db:postgres --schedule '0 3 * * *'\n  serve compose-backups set volume:uploads --bucket backups --retention-s3 30\n  SERVE_BACKUP_PASSPHRASE=... serve compose-backups set dir:/srv/data --encrypt",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			key := args[0]
			if err := checkBackupKey(key); err != nil {
				return err
			}
			fl := cmd.Flags()
			body := map[string]any{}
			switch {
			case fl.Changed("schedule") && noSchedule:
				return usagef("pass --schedule or --no-schedule, not both")
			case fl.Changed("schedule"):
				if strings.TrimSpace(schedule) == "" {
					return usagef("--schedule needs a cron expression, like '0 3 * * *' (or pass --no-schedule)")
				}
				body["schedule"] = schedule
			case noSchedule:
				body["schedule"] = nil
			}
			if fl.Changed("retention") {
				if retention < 1 || retention > 365 {
					return usagef("--retention is from 1 to 365")
				}
				body["retention"] = retention
			}
			if fl.Changed("retention-s3") {
				if retentionS3 < 1 || retentionS3 > 3650 {
					return usagef("--retention-s3 is from 1 to 3650")
				}
				body["retentionS3"] = retentionS3
			}
			if fl.Changed("local") {
				body["local"] = local
			}
			if fl.Changed("timeout") {
				if timeout < 0 || timeout > 10080 {
					return usagef("--timeout is from 1 to 10080 minutes (0: no limit)")
				}
				body["timeoutMinutes"] = timeout
				if timeout == 0 {
					body["timeoutMinutes"] = nil
				}
			}
			if fl.Changed("low-priority") {
				body["lowPriority"] = lowPriority
			}
			switch {
			case encrypt && noEncrypt:
				return usagef("pass --encrypt or --no-encryption, not both")
			case encrypt:
				p := firstNonEmpty(passphrase, os.Getenv("SERVE_BACKUP_PASSPHRASE"))
				if len(p) < 8 {
					return usagef("--encrypt needs a passphrase of 8 characters or more: --passphrase or SERVE_BACKUP_PASSPHRASE")
				}
				body["passphrase"] = p
			case noEncrypt:
				body["passphrase"] = nil
			case passphrase != "":
				return usagef("--passphrase goes with --encrypt")
			}
			s, err := a.composeTarget(ctx, nil)
			if err != nil {
				return err
			}
			if fl.Changed("bucket") || len(copyTo) > 0 {
				c, err := a.Client()
				if err != nil {
					return err
				}
				if fl.Changed("bucket") {
					if bucket == "" || bucket == "none" {
						body["s3DestinationId"] = nil
					} else if body["s3DestinationId"], err = findStorage(ctx, c, bucket); err != nil {
						return err
					}
				}
				if len(copyTo) > 0 {
					ids := []string{}
					for _, ref := range copyTo {
						if ref == "none" {
							continue
						}
						id, err := findStorage(ctx, c, ref)
						if err != nil {
							return err
						}
						ids = append(ids, id)
					}
					body["copyDestinationIds"] = ids
				}
			}
			if err := a.client.PutJSON(ctx, composeBackupPath(s.ID, key), body, nil); err != nil {
				return err
			}
			ui.Success("Saved the backup %s of %s.", ui.Bold(key), s.Name)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&schedule, "schedule", "", "cron expression for automatic backups")
	f.BoolVar(&noSchedule, "no-schedule", false, "stop automatic backups (manual only)")
	f.IntVar(&retention, "retention", 0, "backups kept on the server")
	f.IntVar(&retentionS3, "retention-s3", 0, "backups kept in the bucket")
	f.StringVar(&bucket, "bucket", "", "S3 storage for backups (name or id; none to stop)")
	f.StringArrayVar(&copyTo, "copy-to", nil, "also copy each backup to this S3 storage (repeat; none for no copies)")
	f.BoolVar(&local, "local", true, "with a bucket, also keep backups on the server")
	f.IntVar(&timeout, "timeout", 0, "minutes a dump may take (0: no limit)")
	f.BoolVar(&lowPriority, "low-priority", false, "dump at the lowest CPU priority")
	f.BoolVar(&encrypt, "encrypt", false, "encrypt backups with --passphrase or SERVE_BACKUP_PASSPHRASE")
	f.StringVar(&passphrase, "passphrase", "", "the passphrase for --encrypt")
	f.BoolVar(&noEncrypt, "no-encryption", false, "stop encrypting backups")
	return cmd
}

func (a *App) composeBackupRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <backup>",
		Aliases: []string{"delete", "remove"},
		Short:   "Stop backing up part of a compose stack",
		Long:    "Stop backing up a database container, volume or folder of the stack. Backups already taken stay until they are deleted. Asks first unless --yes.",
		Example: "  serve compose-backups rm volume:uploads\n  serve compose-backups rm db:postgres --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			key := args[0]
			if err := checkBackupKey(key); err != nil {
				return err
			}
			s, err := a.composeTarget(ctx, nil)
			if err != nil {
				return err
			}
			if err := confirmYes(fmt.Sprintf("Stop backing up %s of %s? Backups already taken stay.", key, s.Name), "stop the backup", yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, composeBackupPath(s.ID, key), nil, nil); err != nil {
				return err
			}
			ui.Success("Stopped backing up %s of %s.", ui.Bold(key), s.Name)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	return cmd
}
