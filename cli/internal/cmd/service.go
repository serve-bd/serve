package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) statusCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the service, its URL and the deployment that runs now",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			c := a.client
			var current, latest *api.Deployment
			if id := deref(s.CurrentDeploymentID); id != "" {
				current, _ = c.Deployment(ctx, id)
			}
			if list, err := c.Deployments(ctx, s.ID, 1); err == nil && len(list) > 0 {
				latest = &list[0]
			}
			if current != nil {
				current.LogTail = ""
			}
			url := a.serviceURL(ctx, s)
			envName := ""
			if envs, err := c.Environments(ctx, s.ProjectID); err == nil {
				for _, e := range envs {
					if e.ID == s.EnvironmentID {
						envName = e.Name
					}
				}
			}
			running, total := -1, 0
			var containers struct {
				Containers []struct {
					State        string `json:"state"`
					DeploymentID string `json:"deploymentId"`
				} `json:"containers"`
			}
			if err := c.Get(ctx, "/services/"+api.P(s.ID)+"/containers", nil, &containers); err == nil {
				running = 0
				for _, ct := range containers.Containers {
					if s.Type == "app" && current != nil && ct.DeploymentID != "" && ct.DeploymentID != current.ID {
						continue
					}
					total++
					if ct.State == "running" {
						running++
					}
				}
			}
			if asJSON {
				return printJSON(map[string]any{
					"service": s, "environment": envName, "url": url, "dashboardUrl": a.dashboardURL(s),
					"currentDeployment": current, "latestDeployment": latest,
					"containers": map[string]int{"running": running, "total": total},
				})
			}
			fmt.Fprintf(ui.Out, "%s  %s\n", ui.OutBold(s.Name), ui.StatusColor(s.Status))
			pairs := [][2]string{
				{"Project", s.Project + " / " + envName},
				{"Type", s.Kind()},
				{"URL", url},
			}
			if current != nil {
				pairs = append(pairs, [2]string{"Deployment", fmt.Sprintf("%s  %s, %s (%s)", current.ID, ui.StatusColor(current.Status), ui.Ago(current.CreatedAt), triggerLabel(current.Trigger))})
				pairs = append(pairs, [2]string{"Source", commitLine(current)})
				if u := current.Upload; u != nil {
					pairs = append(pairs, [2]string{"Upload", fmt.Sprintf("%d files, %s", u.Files, ui.Bytes(u.Size))})
				}
			}
			if latest != nil && (current == nil || latest.ID != current.ID) {
				pairs = append(pairs, [2]string{"Latest", fmt.Sprintf("%s  %s, %s", latest.ID, ui.StatusColor(latest.Status), ui.Ago(latest.CreatedAt))})
				if e := deref(latest.Error); e != "" && latest.Status == "failed" {
					pairs = append(pairs, [2]string{"Error", firstLine(e)})
				}
			}
			if s.Type == "app" {
				want := max(s.Runtime.Replicas, 1)
				r := fmt.Sprint(want)
				if running >= 0 {
					r = fmt.Sprintf("%d running of %d", running, want)
				}
				pairs = append(pairs, [2]string{"Replicas", r})
			} else if running >= 0 {
				pairs = append(pairs, [2]string{"Containers", fmt.Sprintf("%d running of %d", running, total)})
			}
			pairs = append(pairs, [2]string{"Dashboard", a.dashboardURL(s)})
			ui.KV(pairs)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return l
}

func (a *App) openCmd() *cobra.Command {
	var dashboard bool
	cmd := &cobra.Command{
		Use:   "open",
		Short: "Open the service's address in the browser",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			u := a.dashboardURL(s)
			if !dashboard {
				if u = a.serviceURL(ctx, s); u == "" {
					return fmt.Errorf("%s has no domain. Add one with `serve domains add <host>`, or open its page with --dashboard", s.Name)
				}
			}
			if !canOpenBrowser() || openBrowser(u) != nil {
				fmt.Fprintln(ui.Out, u)
				return nil
			}
			ui.Info("Opening %s", u)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&dashboard, "dashboard", "d", false, "open the service's page in the dashboard instead")
	return cmd
}

func (a *App) controlCmd(command string) *cobra.Command {
	short := map[string]string{"start": "Start the service", "stop": "Stop the service", "restart": "Restart the service's containers"}[command]
	done := map[string]string{"start": "Starting", "stop": "Stopping", "restart": "Restarting"}[command]
	return &cobra.Command{
		Use:   command,
		Short: short,
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/"+command, nil, nil); err != nil {
				return err
			}
			ui.Success("%s %s.", done, ui.Bold(s.Name))
			return nil
		},
	}
}

func (a *App) logsCmd() *cobra.Command {
	var follow, timestamps bool
	var tail int
	var build string
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show the service's logs, or a deployment's build log",
		Long: `Show the last lines of the service's running containers. -f keeps printing new
lines until Ctrl+C.

--build shows the build and deploy log of the newest deployment, or of the one
named (--build=<id>). With -f it follows that log until the deployment ends.`,
		Example: "  serve logs -f\n  serve logs --tail 500\n  serve logs --build\n  serve logs --build=abc123 -f",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			if cmd.Flags().Changed("build") {
				return a.buildLogs(ctx, build, follow)
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			multi := false
			print := func(l api.LogLine) {
				var b strings.Builder
				if timestamps && !l.Time.IsZero() {
					b.WriteString(ui.OutDim(l.Time.Local().Format("2006-01-02 15:04:05.000")) + " ")
				}
				if multi {
					b.WriteString(ui.OutDim(ui.SanitizeLine(l.Container, false)) + " ")
				}
				b.WriteString(ui.SanitizeLine(l.Text, ui.ColorOut()))
				fmt.Fprintln(ui.Out, b.String())
			}
			lines, err := a.client.ServiceLogs(ctx, s.ID, tail, time.Time{})
			if err != nil {
				return err
			}
			names := map[string]bool{}
			for _, l := range lines {
				names[l.Container] = true
			}
			multi = len(names) > 1
			if !follow {
				if len(lines) > tail {
					lines = lines[len(lines)-tail:]
				}
				if len(lines) == 0 {
					ui.Info(ui.Dim("No log lines. Is %s running? See `serve status`."), s.Name)
				}
				for _, l := range lines {
					print(l)
				}
				return nil
			}
			return a.client.FollowServiceLogs(ctx, s.ID, tail, 2*time.Second, func(l api.LogLine) {
				if !names[l.Container] {
					names[l.Container] = true
					multi = len(names) > 1
				}
				print(l)
			})
		},
	}
	f := cmd.Flags()
	f.BoolVarP(&follow, "follow", "f", false, "keep printing new lines")
	f.IntVarP(&tail, "tail", "n", 100, "how many of the last lines to show")
	f.BoolVarP(&timestamps, "timestamps", "t", false, "show the time of each line")
	f.StringVar(&build, "build", "", "show a deployment's build log (the newest, or --build=<id>)")
	f.Lookup("build").NoOptDefVal = "latest"
	return cmd
}

func (a *App) buildLogs(ctx context.Context, id string, follow bool) error {
	c, err := a.Client()
	if err != nil {
		return err
	}
	if id == "" || id == "latest" {
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return err
		}
		list, err := c.Deployments(ctx, s.ID, 1)
		if err != nil {
			return err
		}
		if len(list) == 0 {
			return fmt.Errorf("%s has no deployments yet", s.Name)
		}
		id = list[0].ID
		ui.Line(ui.Dim(fmt.Sprintf("Deployment %s (%s, %s)", id, list[0].Status, ui.Ago(list[0].CreatedAt))))
	}
	if !follow {
		var r struct {
			Status string `json:"status"`
			Logs   string `json:"logs"`
		}
		if err := c.Get(ctx, "/deployments/"+api.P(id)+"/logs", nil, &r); err != nil {
			return err
		}
		fmt.Fprint(ui.NewLogWriter(ui.Out), r.Logs)
		if r.Logs != "" && !strings.HasSuffix(r.Logs, "\n") {
			fmt.Fprintln(ui.Out)
		}
		return nil
	}
	out := &lastByte{w: ui.NewLogWriter(ui.Out), last: '\n'}
	status, err := c.FollowBuild(ctx, id, out, api.FollowOptions{})
	if out.last != '\n' {
		fmt.Fprintln(out)
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	switch status {
	case "success":
		ui.Success("The deployment succeeded.")
	case "failed":
		if d, err := c.Deployment(ctx, id); err == nil && deref(d.Error) != "" {
			return exit(ExitDeployed, "the deployment failed: %s", deref(d.Error))
		}
		return exit(ExitDeployed, "the deployment failed")
	default:
		return exit(ExitDeployed, "the deployment ended: %s", status)
	}
	return nil
}
