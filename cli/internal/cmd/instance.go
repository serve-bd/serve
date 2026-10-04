package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) instanceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "instance",
		Short: "This Serve instance: its version, updates and backups",
		Long: `Work with the Serve instance itself: see its version, update it, and back it up.
These commands need an admin of the Root organization.`,
		Example: "  serve instance version\n  serve instance update\n  serve instance backups create --wait",
	}
	cmd.PersistentFlags().Bool("json", false, "print JSON")
	cmd.AddCommand(a.instanceVersionCmd(), a.instanceUpdateCmd(), a.instanceBackupsCmd())
	return cmd
}

func (a *App) updateStatus(ctx context.Context) (*api.UpdateStatus, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var st api.UpdateStatus
	if err := c.Get(ctx, "/instance/updates", nil, &st); err != nil {
		return nil, needs(err, needInstance)
	}
	return &st, nil
}

func newer(st *api.UpdateStatus) string {
	if st.Check == nil || st.Check.Latest == nil || *st.Check.Latest == "" {
		return ""
	}
	latest := *st.Check.Latest
	_, okL := parseVersion(latest)
	_, okV := parseVersion(st.Version)
	if okL && okV {
		if newerVersion(latest, st.Version) {
			return latest
		}
		return ""
	}
	if strings.TrimPrefix(latest, "v") != strings.TrimPrefix(st.Version, "v") {
		return latest
	}
	return ""
}

func (a *App) instanceVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "version",
		Short:   "Show the version of Serve and whether a newer one is out",
		Long:    "Show the version this Serve instance runs, the newest release from its last check, and the last update.",
		Example: "  serve instance version\n  serve instance version --json",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := a.updateStatus(cmd.Context())
			if err != nil {
				return err
			}
			if jsonFlag(cmd) {
				return printJSON(st)
			}
			pairs := [][2]string{{"Version", ui.OutBold(st.Version)}}
			if chk := st.Check; chk != nil {
				latest := deref(chk.Latest)
				if n := newer(st); n != "" {
					latest = n + " is out. Run `serve instance update`"
				} else if latest != "" {
					latest += " (up to date)"
				}
				pairs = append(pairs, [2]string{"Latest", latest}, [2]string{"Checked", ui.Ago(chk.CheckedAt)})
				if e := deref(chk.Error); e != "" {
					pairs = append(pairs, [2]string{"Check error", e})
				}
			} else {
				pairs = append(pairs, [2]string{"Latest", "not checked yet. Run `serve instance update --check`"})
			}
			if run := st.Run; run != nil {
				pairs = append(pairs, [2]string{"Last update", fmt.Sprintf("%s to %s, %s (%s)", run.From, run.To, run.State, ui.Ago(run.StartedAt))})
			}
			ui.KV(pairs)
			return nil
		},
	}
}

func (a *App) instanceUpdateCmd() *cobra.Command {
	var check, yes, wait bool
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update Serve to the newest release",
		Long: `Look for a new release of Serve and install it. Serve backs itself up first, and goes
back to the version it ran by itself if the new one does not start. Asks first unless --yes.

--check only looks and says what it found. --wait follows the update until it ends (the
dashboard restarts on the way).`,
		Example: "  serve instance update --check\n  serve instance update --wait\n  serve instance update --yes",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			var r struct{ Check api.UpdateCheck }
			if err := c.Post(ctx, "/instance/updates/check", nil, &r); err != nil {
				return needs(err, needInstance)
			}
			st, err := a.updateStatus(ctx)
			if err != nil {
				return err
			}
			st.Check = &r.Check
			latest := newer(st)
			if check && jsonFlag(cmd) {
				return printJSON(map[string]any{"version": st.Version, "latest": r.Check.Latest, "updateAvailable": latest != "", "url": r.Check.URL})
			}
			if latest == "" {
				ui.Success("Serve %s is the newest release.", st.Version)
				return nil
			}
			ui.Info("Serve %s is out (this instance runs %s).", ui.Bold(latest), st.Version)
			if u := deref(r.Check.URL); u != "" {
				ui.Info("What changed: %s", u)
			}
			if check {
				ui.Info("Install it with `serve instance update`.")
				return nil
			}
			if run := st.Run; run != nil && (run.State == "backing-up" || run.State == "running") {
				return fmt.Errorf("an update to %s is already running", run.To)
			}
			if err := confirmAction(fmt.Sprintf("Update Serve from %s to %s? It backs up first; the dashboard restarts.", st.Version, latest), yes); err != nil {
				return err
			}
			if err := c.Post(ctx, "/instance/updates/install", nil, nil); err != nil {
				return needs(err, needInstance)
			}
			ui.Info("Updating Serve to %s.", latest)
			if !wait {
				ui.Info("Follow it with `serve instance version`.")
				return nil
			}
			return a.waitUpdate(ctx, latest)
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "only look for a new release")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the update ends")
	return cmd
}

// waitUpdate follows an update. The dashboard goes away while it restarts: no answer, or a
// 502/503 from a proxy in front, only means "still going".
func (a *App) waitUpdate(ctx context.Context, to string) error {
	sp := ui.StartSpinner("Updating Serve to " + to + "...")
	defer sp.Stop()
	state := ""
	down := time.Time{}
	for {
		if err := sleepCtx(ctx, adminPoll); err != nil {
			return err
		}
		st, err := a.updateStatus(ctx)
		if err != nil {
			var ne *api.NetworkError
			if errors.As(err, &ne) || api.IsStatus(err, http.StatusBadGateway) || api.IsStatus(err, http.StatusServiceUnavailable) || api.IsStatus(err, http.StatusGatewayTimeout) {
				if down.IsZero() {
					down = time.Now()
					sp.Update("The dashboard is restarting...")
				}
				if time.Since(down) > 15*time.Minute {
					return fmt.Errorf("the dashboard has not answered for 15 minutes: %w", err)
				}
				continue
			}
			return err
		}
		down = time.Time{}
		run := st.Run
		if run == nil || run.To != to {
			continue
		}
		if run.State != state {
			state = run.State
			switch state {
			case "backing-up":
				sp.Update("Backing up before the update...")
			case "running":
				sp.Update("Installing " + to + "...")
			}
		}
		switch state {
		case "backing-up", "running":
			continue
		case "success":
			sp.Stop()
			ui.Success("Serve runs %s.", ui.Bold(st.Version))
			return nil
		case "rolled-back":
			sp.Stop()
			return fmt.Errorf("%s did not start, so Serve went back to %s. See Settings → Updates in the dashboard for the log", to, run.From)
		}
		sp.Stop()
		lines := strings.Split(strings.TrimSpace(run.Log), "\n")
		last := lines[len(lines)-1]
		return fmt.Errorf("the update to %s failed: %s", to, ui.SanitizeLine(last, false))
	}
}

func (a *App) instanceBackups(ctx context.Context) ([]api.InstanceBackup, json.RawMessage, error) {
	c, err := a.Client()
	if err != nil {
		return nil, nil, err
	}
	var list []api.InstanceBackup
	raw, err := c.GetRaw(ctx, "/instance/backups", "backups", &list)
	return list, raw, needs(err, needInstance)
}

func (a *App) instanceBackupsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "backups",
		Aliases: []string{"backup"},
		Short:   "List and make backups of this Serve instance",
		Long:    "List and make backups of the Serve instance: its database and settings. Restoring one is done on the server, as the docs say.",
		Example: "  serve instance backups\n  serve instance backups create --wait",
	}
	list := func(cmd *cobra.Command, args []string) error {
		list, raw, err := a.instanceBackups(cmd.Context())
		if err != nil {
			return err
		}
		if jsonFlag(cmd) {
			return printJSON(raw)
		}
		if len(list) == 0 {
			ui.Info("No backups yet. Make one with `serve instance backups create`.")
			return nil
		}
		var rows [][]string
		for _, b := range list {
			size := ""
			if b.Size != nil {
				size = ui.Bytes(*b.Size)
			}
			status := ui.StatusColor(b.Status)
			if b.S3Status != nil {
				status += ui.OutDim(", copy " + *b.S3Status)
			}
			rows = append(rows, []string{ui.Ago(b.CreatedAt), status, b.Trigger, size, b.Version, deref(b.Filename)})
		}
		ui.Table([]string{"CREATED", "STATUS", "TRIGGER", "SIZE", "VERSION", "FILE"}, rows)
		return nil
	}
	cmd.Args = noArgs
	cmd.RunE = list
	cmd.AddCommand(&cobra.Command{Use: "ls", Aliases: []string{"list"}, Short: "List the instance's backups", Args: noArgs, RunE: list})

	var wait bool
	create := &cobra.Command{
		Use:     "create",
		Short:   "Back up this Serve instance now",
		Long:    "Start a backup of the Serve instance. It runs in the background; --wait follows it until it ends.",
		Example: "  serve instance backups create\n  serve instance backups create --wait",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			var r struct {
				BackupID string `json:"backupId"`
			}
			if err := c.Post(ctx, "/instance/backups", nil, &r); err != nil {
				return needs(err, needInstance)
			}
			if !wait {
				if jsonFlag(cmd) {
					return printJSON(r)
				}
				ui.Info("Started a backup. See it with `serve instance backups`.")
				return nil
			}
			sp := ui.StartSpinner("Backing up...")
			defer sp.Stop()
			for {
				if err := sleepCtx(ctx, adminPoll); err != nil {
					return err
				}
				list, _, err := a.instanceBackups(ctx)
				if err != nil {
					return err
				}
				for _, b := range list {
					if b.ID != r.BackupID || b.Status == "running" {
						continue
					}
					sp.Stop()
					if jsonFlag(cmd) {
						return printJSON(b)
					}
					if b.Status == "failed" {
						return fmt.Errorf("the backup failed: %s", orName(deref(b.Error), "no reason was given"))
					}
					size := ""
					if b.Size != nil {
						size = " (" + ui.Bytes(*b.Size) + ")"
					}
					ui.Success("Backed up to %s%s.", deref(b.Filename), size)
					if b.S3Status != nil && *b.S3Status == "failed" {
						ui.Warn("The copy to S3 storage failed: %s", deref(b.Error))
					}
					return nil
				}
			}
		},
	}
	create.Flags().BoolVarP(&wait, "wait", "w", false, "wait until the backup ends")
	cmd.AddCommand(create)
	return cmd
}
