package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// monitorIntervals are the check intervals the server accepts, in seconds.
var monitorIntervals = []int{30, 60, 120, 300, 600}

func (a *App) uptimeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "uptime",
		Aliases: []string{"monitor"},
		Short:   "Set and run the service's uptime check",
		Long: `Set the uptime check of the service and run it now. Serve checks the service on an
interval and alerts the organization's channels when it goes down.`,
		Example: "  serve uptime set /health\n  serve uptime set /health --interval 5m\n  serve uptime check",
	}
	cmd.AddCommand(a.uptimeSetCmd(), a.uptimeCheckCmd())
	return cmd
}

func (a *App) uptimeSetCmd() *cobra.Command {
	var interval, status, keyword, timeout string
	var off, container bool
	var failures int
	cmd := &cobra.Command{
		Use:   "set [path or url]",
		Short: "Set the uptime check (a path of the main domain, or a URL)",
		Long: `Set the uptime check of the service. Give a path of the service's main domain (like
/health), or a full URL. --container checks that its containers run instead of asking a URL.
--off pauses the check.

The settings you do not pass go back to their defaults: every minute, status 200-399, a 10s
timeout, down after 3 failed checks.`,
		Example: "  serve uptime set /health\n  serve uptime set https://shop.example.com/up --interval 30s --keyword ok\n  serve uptime set --container\n  serve uptime set --off",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"enabled": !off, "kind": "http", "path": "/", "url": nil, "expectedStatus": status, "keyword": nil, "failureThreshold": failures}
			if container {
				if len(args) == 1 {
					return usagef("--container checks the containers, not a path: drop %q", args[0])
				}
				body["kind"] = "container"
			} else if len(args) == 1 {
				target := strings.TrimSpace(args[0])
				switch {
				case strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://"):
					body["url"] = target
				case strings.HasPrefix(target, "/"):
					body["path"] = target
				default:
					return usagef("%q is neither a path (start it with /) nor a URL (start it with https://)", target)
				}
			} else if !off {
				return usagef("name a path to check (like /health), a URL, or pass --container")
			}
			secs, err := parseSeconds(interval)
			if err != nil {
				return usagef("--interval: %s", err.Error())
			}
			ok := false
			for _, v := range monitorIntervals {
				ok = ok || v == secs
			}
			if !ok {
				return usagef("--interval must be one of 30s, 1m, 2m, 5m or 10m")
			}
			body["intervalSeconds"] = secs
			t, err := time.ParseDuration(timeout)
			if err != nil || t < time.Second || t > 30*time.Second {
				return usagef("--timeout must be from 1s to 30s")
			}
			body["timeoutMs"] = int(t.Milliseconds())
			if failures < 1 || failures > 10 {
				return usagef("--failures must be from 1 to 10")
			}
			if keyword != "" {
				body["keyword"] = keyword
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if err := a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+"/monitor", body, nil); err != nil {
				return err
			}
			switch {
			case off:
				ui.Success("Paused the uptime check of %s.", ui.Bold(s.Name))
			case container:
				ui.Success("%s is checked every %s: its containers must run.", ui.Bold(s.Name), ui.Duration(time.Duration(secs)*time.Second))
			default:
				what := fmt.Sprint(body["path"])
				if u, ok := body["url"].(string); ok {
					what = u
				}
				ui.Success("%s is checked every %s at %s.", ui.Bold(s.Name), ui.Duration(time.Duration(secs)*time.Second), what)
				ui.Line(ui.Dim("Run it now with `serve uptime check`."))
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&interval, "interval", "1m", "how often to check: 30s, 1m, 2m, 5m or 10m")
	f.BoolVar(&off, "off", false, "pause the check")
	f.BoolVar(&container, "container", false, "check that the containers run, not a URL")
	f.StringVar(&status, "status", "200-399", "the status `codes` that count as up, like 200 or 200-299,301")
	f.StringVar(&keyword, "keyword", "", "`text` the page must contain")
	f.StringVar(&timeout, "timeout", "10s", "how long to wait for an answer (1s to 30s)")
	f.IntVar(&failures, "failures", 3, "failed checks in a row before the service counts as down (1 to 10)")
	return cmd
}

func (a *App) uptimeCheckCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "check",
		Short:   "Run the uptime check now",
		Long:    "Run the service's uptime check now and print the result. Exits with 1 when the check fails.",
		Example: "  serve uptime check\n  serve uptime check --json",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			var r struct{ Result api.CheckResult }
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/monitor/check", nil, &r); err != nil {
				if strings.Contains(err.Error(), "Save the check first") {
					return fmt.Errorf("%s has no uptime check yet. Set one with `serve uptime set /health`", s.Name)
				}
				return err
			}
			res := r.Result
			if asJSON {
				if err := printJSON(res); err != nil {
					return err
				}
				if !res.OK {
					return silentExit(ExitError)
				}
				return nil
			}
			var parts []string
			if res.StatusCode != nil {
				parts = append(parts, fmt.Sprintf("status %d", *res.StatusCode))
			}
			if res.LatencyMs != nil {
				parts = append(parts, fmt.Sprintf("%d ms", *res.LatencyMs))
			}
			detail := ""
			if len(parts) > 0 {
				detail = " (" + strings.Join(parts, ", ") + ")"
			}
			if res.OK {
				ui.Success("%s is up%s.", ui.Bold(s.Name), detail)
				return nil
			}
			reason := deref(res.Error)
			if reason == "" {
				reason = "the check failed"
			}
			return exit(ExitError, "%s is down%s: %s", s.Name, detail, reason)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}
