package cmd

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

var tagColors = []string{"gray", "red", "orange", "green", "blue", "purple"}

func (a *App) tagsCmd() *cobra.Command {
	cmd := lsCmd("tags", "List tags, tag the service, deploy every service of a tag", []string{"tag"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		c, err := a.Client()
		if err != nil {
			return err
		}
		tags, err := c.Tags(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(tags)
		}
		if len(tags) == 0 {
			ui.Info("No tags yet. Tag the linked service with `serve tags set <tag>`.")
			return nil
		}
		names := map[string]string{}
		if all, err := c.Services(ctx, "", ""); err == nil {
			for _, s := range all {
				names[s.ID] = s.Name
			}
		}
		var rows [][]string
		for _, t := range tags {
			var svc []string
			for _, id := range t.ServiceIDs {
				svc = append(svc, orName(names[id], id))
			}
			sort.Strings(svc)
			list := strings.Join(svc, ", ")
			if len(svc) == 0 {
				list = ui.OutDim("none")
			}
			rows = append(rows, []string{t.Name, t.Color, list})
		}
		ui.Table([]string{"TAG", "COLOR", "SERVICES"}, rows)
		return nil
	})
	cmd.Long = `Tags group services across projects, like prod or team-api. List them, set the tags
of the linked service, and deploy every service that carries a tag at once.`
	cmd.Example = "  serve tags\n  serve tags set prod api\n  serve tags deploy prod"
	cmd.AddCommand(a.tagSetCmd(), a.tagCreateCmd(), a.tagDeployCmd(), a.tagRmCmd())
	return cmd
}

func (a *App) findTag(ctx context.Context, ref string) (*api.Tag, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	tags, err := c.Tags(ctx)
	if err != nil {
		return nil, err
	}
	for i := range tags {
		if tags[i].ID == ref || strings.EqualFold(tags[i].Name, ref) {
			return &tags[i], nil
		}
	}
	return nil, fmt.Errorf("there is no tag %q. See `serve tags`", ref)
}

func (a *App) tagSetCmd() *cobra.Command {
	var none bool
	cmd := &cobra.Command{
		Use:   "set <tag...>",
		Short: "Set the tags of the service (new names become tags)",
		Long: `Set the tags of the linked service (or --service). The list replaces the tags it had;
names without a tag yet become new tags. --none removes every tag from the service.`,
		Example: "  serve tags set prod\n  serve tags set prod team-api --service api\n  serve tags set --none",
		RunE: func(cmd *cobra.Command, args []string) error {
			if none && len(args) > 0 {
				return usagef("pass tags or --none, not both")
			}
			if !none && len(args) == 0 {
				return usagef("name at least one tag, or pass --none to remove them all")
			}
			names := []string{}
			seen := map[string]bool{}
			for _, n := range args {
				for _, part := range strings.Split(n, ",") {
					part = strings.TrimSpace(part)
					if part != "" && !seen[strings.ToLower(part)] {
						seen[strings.ToLower(part)] = true
						names = append(names, part)
					}
				}
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if err := a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+"/tags", map[string]any{"tags": names}, nil); err != nil {
				return err
			}
			if len(names) == 0 {
				ui.Success("Removed every tag from %s.", ui.Bold(s.Name))
			} else {
				ui.Success("Tagged %s: %s.", ui.Bold(s.Name), strings.Join(names, ", "))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&none, "none", false, "remove every tag from the service")
	return cmd
}

func (a *App) tagCreateCmd() *cobra.Command {
	var color string
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a tag",
		Long: `Create a tag without putting it on a service yet. Names are up to 40 letters, numbers,
dots, dashes or underscores. Colors: ` + strings.Join(tagColors, ", ") + ".",
		Example: "  serve tags create prod --color red",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"name": args[0]}
			if color != "" {
				ok := false
				for _, c := range tagColors {
					ok = ok || c == color
				}
				if !ok {
					return usagef("--color must be one of %s", strings.Join(tagColors, ", "))
				}
				body["color"] = color
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := c.Post(cmd.Context(), "/tags", body, nil); err != nil {
				return err
			}
			ui.Success("Created the tag %s.", ui.Bold(args[0]))
			return nil
		},
	}
	cmd.Flags().StringVar(&color, "color", "", "the tag's `color` ("+strings.Join(tagColors, ", ")+")")
	return cmd
}

func (a *App) tagDeployCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "deploy <tag>",
		Short: "Deploy every service that carries a tag",
		Long: `Deploy every service that carries the tag (the ones this login can reach). Each deploy
follows its project's rules: a deploy freeze skips it, a required approval holds it.`,
		Example: "  serve tags deploy prod",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			t, err := a.findTag(ctx, args[0])
			if err != nil {
				return err
			}
			var r struct {
				Queued []struct {
					ServiceID    string `json:"serviceId"`
					DeploymentID string `json:"deploymentId"`
				} `json:"queued"`
				Skipped []struct {
					Service string `json:"service"`
					Reason  string `json:"reason"`
				} `json:"skipped"`
			}
			if err := a.client.Post(ctx, "/tags/"+api.P(t.ID)+"/deploy", nil, &r); err != nil {
				return err
			}
			if len(r.Queued) == 0 && len(r.Skipped) == 0 {
				return fmt.Errorf("no service you can reach carries the tag %s", t.Name)
			}
			if len(r.Queued) > 0 {
				ui.Success("Deploying %d service(s) tagged %s.", len(r.Queued), ui.Bold(t.Name))
			}
			for _, s := range r.Skipped {
				ui.Warn("Skipped %s: %s", s.Service, s.Reason)
			}
			if len(r.Queued) == 0 {
				return silentExit(ExitError)
			}
			ui.Line(ui.Dim("See them with `serve deployments --service <name>`, or in the dashboard."))
			return nil
		},
	}
	return cmd
}

func (a *App) tagRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <tag>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a tag (the services stay)",
		Long:    "Delete a tag: it goes from every service, and its deploy hook stops working. The services stay. Asks for the tag's name unless you pass --yes.",
		Example: "  serve tags rm old\n  serve tags rm old --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			t, err := a.findTag(ctx, args[0])
			if err != nil {
				return err
			}
			if n := len(t.ServiceIDs); n > 0 {
				ui.Warn("%s is on %d service(s); it goes from all of them.", t.Name, n)
			}
			if err := confirmName("a tag", t.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/tags/"+api.P(t.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the tag %s.", ui.Bold(t.Name))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}
