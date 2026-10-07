package cmd

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// requestPage is the most the API answers at once; longer lists are read page by page.
const requestPage = 500

type loggedRequest struct {
	Time       string  `json:"time"`
	Hostname   string  `json:"hostname"`
	Method     string  `json:"method"`
	Path       string  `json:"path"`
	Status     int     `json:"status"`
	DurationMs *int    `json:"durationMs"`
	Bytes      *int64  `json:"bytes"`
	IP         *string `json:"ip"`
	AnsweredBy *string `json:"answeredBy"`
}

func (a *App) requestsCmd() *cobra.Command {
	var status, path, method, from, to string
	var since time.Duration
	var limit int
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "requests [service]",
		Short: "Show the request log of a service",
		Long: `Show single requests that reached the service through the proxy, newest first. They are
kept only while the service's request log is on (its Monitoring settings in the dashboard), and
only the status groups it keeps (4xx and 5xx by default).

--status filters by status group (5xx, or 4,5), --path by part of the path, --method by method.
--since 1h shows the last hour; --from and --to take RFC 3339 times or Unix seconds.
--limit is how many to show (default 100).`,
		Example: "  serve requests\n  serve requests api --status 5xx --since 1h\n  serve requests --path /checkout --method POST --limit 500 --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if limit < 1 {
				return usagef("--limit must be at least 1")
			}
			if since < 0 {
				return usagef("--since must be a positive duration, like 30m or 2h")
			}
			if since > 0 && from != "" {
				return usagef("pass --since or --from, not both")
			}
			if len(args) == 1 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			q := url.Values{}
			for k, v := range map[string]string{"status": status, "path": path, "method": method, "from": from, "to": to} {
				if v != "" {
					q.Set(k, v)
				}
			}
			if since > 0 {
				q.Set("from", time.Now().Add(-since).UTC().Format(time.RFC3339))
			}
			var items []loggedRequest
			raw := []json.RawMessage{}
			for len(items) < limit {
				n := min(limit-len(items), requestPage)
				q.Set("limit", strconv.Itoa(n))
				var r struct {
					Requests []json.RawMessage `json:"requests"`
					Next     *string           `json:"next"`
				}
				if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/request-log", q, &r); err != nil {
					return err
				}
				for _, m := range r.Requests {
					var it loggedRequest
					if err := json.Unmarshal(m, &it); err != nil {
						return fmt.Errorf("the server's answer could not be read: %w", err)
					}
					items = append(items, it)
					raw = append(raw, m)
				}
				if r.Next == nil || *r.Next == "" || len(r.Requests) == 0 {
					break
				}
				q.Set("before", *r.Next)
			}
			if asJSON {
				return printJSON(raw)
			}
			if len(items) == 0 {
				ui.Info("No requests of %s match. The request log keeps requests only while it is on (Monitoring settings in the dashboard).", s.Name)
				return nil
			}
			var rows [][]string
			for _, r := range items {
				took, ip := "", ""
				if r.DurationMs != nil {
					took = strconv.Itoa(*r.DurationMs) + "ms"
				}
				if r.IP != nil {
					ip = *r.IP
				}
				rows = append(rows, []string{ui.Ago(r.Time), strconv.Itoa(r.Status), txt(r.Method), txt(shorten(r.Hostname+r.Path, 70)), took, ip, txt(deref(r.AnsweredBy))})
			}
			ui.Table([]string{"WHEN", "STATUS", "METHOD", "URL", "TOOK", "IP", "ANSWERED BY"}, rows)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&status, "status", "", "status groups, like 5xx or 4,5")
	f.StringVar(&path, "path", "", "only paths that contain this")
	f.StringVar(&method, "method", "", "only this method, like POST")
	f.DurationVar(&since, "since", 0, "only the last duration, like 30m or 2h")
	f.StringVar(&from, "from", "", "only from this time (RFC 3339 or Unix seconds)")
	f.StringVar(&to, "to", "", "only before this time (RFC 3339 or Unix seconds)")
	f.IntVarP(&limit, "limit", "n", 100, "how many requests to show")
	f.BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}
