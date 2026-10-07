package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

type statusPage struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type incident struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"` // incident, maintenance
	Title      string   `json:"title"`
	Impact     string   `json:"impact"`
	State      *string  `json:"state"`
	StartsAt   *string  `json:"startsAt"`
	EndsAt     *string  `json:"endsAt"`
	ResolvedAt *string  `json:"resolvedAt"`
	CreatedAt  string   `json:"createdAt"`
	Components []string `json:"componentIds"`
	Updates    []struct {
		State     string `json:"state"`
		Body      string `json:"body"`
		CreatedAt string `json:"createdAt"`
	} `json:"updates"`
}

// stateNow is the state of an incident, or the latest of a maintenance's updates.
func (n *incident) stateNow() string {
	if s := deref(n.State); s != "" {
		return s
	}
	if len(n.Updates) > 0 {
		return n.Updates[len(n.Updates)-1].State
	}
	if n.ResolvedAt != nil {
		return "completed"
	}
	return "scheduled"
}

var (
	incidentImpacts = []string{"minor", "major", "critical"}
	incidentStates  = []string{"investigating", "identified", "monitoring", "resolved"}
	maintStates     = []string{"scheduled", "in-progress", "completed"}
)

// statusPageOf is the page named by --page, or the organization's only one.
func (a *App) statusPageOf(ctx context.Context, ref string) (*statusPage, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	l, err := api.List[statusPage](ctx, c, "/status-pages", "statusPages", nil)
	if err != nil {
		return nil, err
	}
	if ref != "" {
		return pickOne(l.Items, ref, "status page", "serve incidents --page <name>", func(p statusPage) string { return p.ID }, func(p statusPage) []string { return []string{p.Name, p.Slug} })
	}
	switch len(l.Items) {
	case 0:
		return nil, fmt.Errorf("this organization has no status page. Make one in the dashboard first")
	case 1:
		return &l.Items[0], nil
	}
	names := make([]string, len(l.Items))
	for i, p := range l.Items {
		names[i] = p.Name
	}
	return nil, usagef("there are %d status pages: pick one with --page (%s)", len(l.Items), strings.Join(names, ", "))
}

func (a *App) incidents(ctx context.Context, page *statusPage, q url.Values) ([]incident, []json.RawMessage, error) {
	l, err := api.List[incident](ctx, a.client, "/status-pages/"+api.P(page.ID)+"/incidents", "incidents", q)
	if err != nil {
		return nil, nil, err
	}
	return l.Items, l.Raw, nil
}

// findIncident takes an incident's id or title (among the newest 200).
func (a *App) findIncident(ctx context.Context, page *statusPage, ref string) (*incident, error) {
	list, _, err := a.incidents(ctx, page, url.Values{"limit": {"200"}})
	if err != nil {
		return nil, err
	}
	return pickOne(list, ref, "incident", "serve incidents", func(n incident) string { return n.ID }, func(n incident) []string { return []string{n.Title} })
}

// componentIDs turns component names or ids of the page into ids.
func (a *App) componentIDs(ctx context.Context, page *statusPage, refs []string) ([]string, error) {
	type component struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	l, err := api.List[component](ctx, a.client, "/status-pages/"+api.P(page.ID)+"/components", "components", nil)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, ref := range refs {
		c, err := pickOne(l.Items, ref, "component", "the status page's settings in the dashboard", func(c component) string { return c.ID }, func(c component) []string { return []string{c.Name} })
		if err != nil {
			return nil, err
		}
		ids = append(ids, c.ID)
	}
	return ids, nil
}

// isoTime checks a time and writes it in UTC.
func isoTime(flag, v string) (string, error) {
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return "", usagef("--%s takes a time like 2026-10-06T22:00:00Z", flag)
	}
	return t.UTC().Format(time.RFC3339), nil
}

// textArg reads a message: the text itself, or a file's content with @file, or - for stdin.
func textArg(v string) (string, error) {
	switch {
	case v == "-":
		b, err := io.ReadAll(os.Stdin)
		return strings.TrimSpace(string(b)), err
	case strings.HasPrefix(v, "@"):
		b, err := os.ReadFile(v[1:])
		return strings.TrimSpace(string(b)), err
	}
	return v, nil
}

func (a *App) incidentsCmd() *cobra.Command {
	var page string
	var open, asJSON bool
	var limit int
	cmd := &cobra.Command{
		Use:     "incidents",
		Aliases: []string{"incident"},
		Short:   "Report incidents and plan maintenance on a status page",
		Long: `List the incidents and maintenance of a status page, newest first, with their state.
--open lists only ongoing ones. The page is --page (a name, slug or id), or the organization's
only one. Subcommands report an incident or plan maintenance, post updates, change and delete
them. Needs the status-pages.manage permission.`,
		Example: "  serve incidents --open\n  serve incidents create \"Checkout errors\" --message \"We are looking into it\" --impact major\n  serve incidents update \"Checkout errors\" \"Fixed, watching it\" --state monitoring",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if limit < 1 || limit > 200 {
				return usagef("--limit is from 1 to 200")
			}
			p, err := a.statusPageOf(ctx, page)
			if err != nil {
				return err
			}
			q := url.Values{"limit": {strconv.Itoa(limit)}}
			if open {
				q.Set("open", "true")
			}
			list, raw, err := a.incidents(ctx, p, q)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(raw)
			}
			if len(list) == 0 {
				what := "no incidents or maintenance"
				if open {
					what = "nothing ongoing"
				}
				ui.Info("%s has %s.", txt(p.Name), what)
				return nil
			}
			var rows [][]string
			for _, n := range list {
				at := ui.Ago(n.CreatedAt)
				if n.Kind == "maintenance" && n.StartsAt != nil {
					at = "from " + when(*n.StartsAt)
				}
				rows = append(rows, []string{txt(shorten(n.Title, 50)), n.Kind, ui.StatusColor(n.stateNow()), n.Impact, at, n.ID})
			}
			ui.Table([]string{"TITLE", "KIND", "STATE", "IMPACT", "WHEN", "ID"}, rows)
			return nil
		},
	}
	cmd.PersistentFlags().StringVar(&page, "page", "", "the status page (`name`, slug or id; default: the only one)")
	cmd.Flags().BoolVar(&open, "open", false, "only ongoing incidents and maintenance not ended")
	cmd.Flags().IntVarP(&limit, "limit", "n", 50, "how many to show (at most 200)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(a.incidentCreateCmd(&page), a.incidentUpdateCmd(&page), a.incidentEditCmd(&page), a.incidentRmCmd(&page))
	return cmd
}

func (a *App) incidentCreateCmd(page *string) *cobra.Command {
	var message, impact, state, starts, ends string
	var components []string
	var maintenance, noNotify bool
	cmd := &cobra.Command{
		Use:   "create <title>",
		Short: "Report an incident, or plan maintenance",
		Long: `Report an incident on the status page: --message says what is happening (@file or - reads
it), --impact is minor, major (default) or critical, --state is investigating (default),
identified, monitoring or resolved. --component names the affected components (repeat it).

--maintenance plans maintenance instead: it needs --starts and --ends (times like
2026-10-06T22:00:00Z).

Subscribers and the page's team channels are told, unless --no-notify.`,
		Example: "  serve incidents create \"Checkout errors\" --message \"We are looking into it\" --component Checkout\n  serve incidents create \"Database upgrade\" --maintenance --starts 2026-10-06T22:00:00Z --ends 2026-10-06T23:00:00Z",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			title := strings.TrimSpace(args[0])
			if title == "" {
				return usagef("give the incident a title")
			}
			fl := cmd.Flags()
			body := map[string]any{"title": title, "kind": "incident"}
			if maintenance {
				if starts == "" || ends == "" {
					return usagef("maintenance needs --starts and --ends")
				}
				if fl.Changed("state") {
					return usagef("--state is for incidents: maintenance starts as scheduled")
				}
				body["kind"] = "maintenance"
			} else {
				if message == "" {
					return usagef("say what is happening with --message")
				}
				if starts != "" || ends != "" {
					return usagef("--starts and --ends are for --maintenance")
				}
				if !slices.Contains(incidentStates, state) {
					return usagef("--state is one of %s", strings.Join(incidentStates, ", "))
				}
				body["state"] = state
			}
			if !slices.Contains(incidentImpacts, impact) {
				return usagef("--impact is one of %s", strings.Join(incidentImpacts, ", "))
			}
			body["impact"] = impact
			for flag, v := range map[string]string{"starts": starts, "ends": ends} {
				if v != "" {
					t, err := isoTime(flag, v)
					if err != nil {
						return err
					}
					body[flag+"At"] = t
				}
			}
			msg, err := textArg(message)
			if err != nil {
				return fmt.Errorf("could not read the message: %w", err)
			}
			body["body"] = msg
			body["notify"] = !noNotify
			p, err := a.statusPageOf(ctx, *page)
			if err != nil {
				return err
			}
			if len(components) > 0 {
				ids, err := a.componentIDs(ctx, p, components)
				if err != nil {
					return err
				}
				body["componentIds"] = ids
			}
			var n incident
			if err := a.client.Post(ctx, "/status-pages/"+api.P(p.ID)+"/incidents", body, &n); err != nil {
				return err
			}
			what := "Reported the incident"
			if maintenance {
				what = "Planned the maintenance"
			}
			ui.Success("%s %s on %s.", what, ui.Bold(txt(title)), txt(p.Name))
			if n.ID != "" {
				ui.Line(ui.Dim(fmt.Sprintf("Post updates with `serve incidents update %s \"<message>\" --state <state>`.", n.ID)))
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&message, "message", "m", "", "what is happening (@file or - reads it)")
	f.StringVar(&impact, "impact", "major", "minor, major or critical")
	f.StringVar(&state, "state", "investigating", "investigating, identified, monitoring or resolved")
	f.StringArrayVar(&components, "component", nil, "an affected component (`name` or id; repeat)")
	f.BoolVar(&maintenance, "maintenance", false, "plan maintenance instead of an incident")
	f.StringVar(&starts, "starts", "", "when the maintenance starts (like 2026-10-06T22:00:00Z)")
	f.StringVar(&ends, "ends", "", "when the maintenance ends")
	f.BoolVar(&noNotify, "no-notify", false, "do not tell subscribers and channels")
	return cmd
}

func (a *App) incidentUpdateCmd(page *string) *cobra.Command {
	var state string
	var noNotify bool
	cmd := &cobra.Command{
		Use:   "update <incident> <message>",
		Short: "Post an update to an incident or maintenance",
		Long: `Post an update (the message; @file or - reads it). --state is required: investigating,
identified, monitoring or resolved for an incident (resolved closes it); scheduled, in-progress
or completed for maintenance (completed ends it now). The incident is its id or title.
Subscribers and the page's team channels are told, unless --no-notify.`,
		Example: "  serve incidents update \"Checkout errors\" \"A fix is deployed\" --state monitoring\n  serve incidents update 4f2a \"All good again\" --state resolved",
		Args:    exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if state == "" {
				return usagef("say the state with --state (%s; for maintenance %s)", strings.Join(incidentStates, ", "), strings.Join(maintStates, ", "))
			}
			msg, err := textArg(args[1])
			if err != nil {
				return fmt.Errorf("could not read the message: %w", err)
			}
			if msg == "" {
				return usagef("the message is empty")
			}
			p, err := a.statusPageOf(ctx, *page)
			if err != nil {
				return err
			}
			n, err := a.findIncident(ctx, p, args[0])
			if err != nil {
				return err
			}
			states := incidentStates
			if n.Kind == "maintenance" {
				states = maintStates
			}
			if !slices.Contains(states, state) {
				return usagef("the state of %s %s is one of %s", n.Kind, txt(n.Title), strings.Join(states, ", "))
			}
			body := map[string]any{"state": state, "body": msg}
			body["notify"] = !noNotify
			if err := a.client.Post(ctx, "/status-pages/"+api.P(p.ID)+"/incidents/"+api.P(n.ID)+"/updates", body, nil); err != nil {
				return err
			}
			ui.Success("Posted an update to %s (%s).", ui.Bold(txt(n.Title)), state)
			return nil
		},
	}
	cmd.Flags().StringVar(&state, "state", "", "the state after this update")
	cmd.Flags().BoolVar(&noNotify, "no-notify", false, "do not tell subscribers and channels")
	return cmd
}

func (a *App) incidentEditCmd(page *string) *cobra.Command {
	var title, impact, starts, ends, postmortem string
	var components []string
	cmd := &cobra.Command{
		Use:   "edit <incident>",
		Short: "Change an incident or maintenance without notifying anyone",
		Long: `Change the title, --impact, affected --component list (repeat; it replaces the list),
--starts and --ends of maintenance, or the --postmortem (@file or - reads it; "" removes it).
Only the flags you pass change, and nobody is notified: post an update for news. The incident
is its id or title.`,
		Example: "  serve incidents edit \"Checkout errors\" --impact critical\n  serve incidents edit 4f2a --postmortem @postmortem.md",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fl := cmd.Flags()
			body := map[string]any{}
			if fl.Changed("title") {
				if strings.TrimSpace(title) == "" {
					return usagef("--title cannot be empty")
				}
				body["title"] = title
			}
			if fl.Changed("impact") {
				if !slices.Contains(incidentImpacts, impact) {
					return usagef("--impact is one of %s", strings.Join(incidentImpacts, ", "))
				}
				body["impact"] = impact
			}
			for flag, v := range map[string]string{"starts": starts, "ends": ends} {
				if fl.Changed(flag) {
					t, err := isoTime(flag, v)
					if err != nil {
						return err
					}
					body[flag+"At"] = t
				}
			}
			if fl.Changed("postmortem") {
				text, err := textArg(postmortem)
				if err != nil {
					return fmt.Errorf("could not read the postmortem: %w", err)
				}
				body["postmortem"] = text
				if text == "" {
					body["postmortem"] = nil
				}
			}
			if len(body) == 0 && !fl.Changed("component") {
				return usagef("say what to change: --title, --impact, --component, --starts, --ends or --postmortem")
			}
			p, err := a.statusPageOf(ctx, *page)
			if err != nil {
				return err
			}
			n, err := a.findIncident(ctx, p, args[0])
			if err != nil {
				return err
			}
			if fl.Changed("component") {
				ids, err := a.componentIDs(ctx, p, components)
				if err != nil {
					return err
				}
				body["componentIds"] = ids
			}
			if err := a.client.Patch(ctx, "/status-pages/"+api.P(p.ID)+"/incidents/"+api.P(n.ID), body, nil); err != nil {
				return err
			}
			ui.Success("Saved %s.", ui.Bold(txt(orName(title, n.Title))))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&title, "title", "", "a new title")
	f.StringVar(&impact, "impact", "", "minor, major or critical")
	f.StringArrayVar(&components, "component", nil, "an affected component (`name` or id; repeat; replaces the list)")
	f.StringVar(&starts, "starts", "", "when the maintenance starts")
	f.StringVar(&ends, "ends", "", "when the maintenance ends")
	f.StringVar(&postmortem, "postmortem", "", "the postmortem (@file or - reads it; \"\" removes it)")
	return cmd
}

func (a *App) incidentRmCmd(page *string) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <incident>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete an incident or maintenance",
		Long:    "Delete an incident or maintenance from the status page and its history, with every update. To close one, post an update with --state resolved instead. Asks first unless --yes.",
		Example: "  serve incidents rm \"Test incident\" --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			p, err := a.statusPageOf(ctx, *page)
			if err != nil {
				return err
			}
			n, err := a.findIncident(ctx, p, args[0])
			if err != nil {
				return err
			}
			if err := confirmYes(fmt.Sprintf("Delete %s %q from %s, with its history?", n.Kind, n.Title, p.Name), "delete it", yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/status-pages/"+api.P(p.ID)+"/incidents/"+api.P(n.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted %s %s.", n.Kind, ui.Bold(txt(n.Title)))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	return cmd
}
