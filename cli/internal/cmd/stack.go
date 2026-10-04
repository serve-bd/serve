package cmd

import (
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

type maintenanceState struct {
	Enabled bool     `json:"enabled"`
	Title   string   `json:"title"`
	Message string   `json:"message"`
	Allow   []string `json:"allow"`
	Since   *string  `json:"since"`
}

func (a *App) maintenanceCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "maintenance",
		Short: "Show, turn on or turn off the maintenance page",
		Long: `While maintenance is on, visitors of the service's domains get a maintenance page
instead of the app (addresses passed with --allow still reach it). Without on or off,
shows whether it is on. Works on the linked service, or --service.`,
		Example: "  serve maintenance\n  serve maintenance on --message \"Back at 14:00 UTC\"\n  serve maintenance on --allow 203.0.113.7\n  serve maintenance off",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			var r struct {
				Service struct {
					Maintenance *maintenanceState `json:"maintenance"`
				} `json:"service"`
			}
			if err := a.client.Get(ctx, "/services/"+api.P(s.ID), nil, &r); err != nil {
				return err
			}
			m := r.Service.Maintenance
			if asJSON {
				if m == nil {
					m = &maintenanceState{}
				}
				return printJSON(m)
			}
			if m == nil || !m.Enabled {
				fmt.Fprintf(ui.Out, "Maintenance is off for %s.\n", s.Name)
				return nil
			}
			fmt.Fprintf(ui.Out, "Maintenance is %s for %s.\n", ui.OutBold("on"), s.Name)
			pairs := [][2]string{{"Title", m.Title}, {"Message", m.Message}, {"Allowed", strings.Join(m.Allow, ", ")}}
			if m.Since != nil {
				pairs = append(pairs, [2]string{"Since", ui.Ago(*m.Since)})
			}
			ui.KV(pairs)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")

	var title, message string
	var allow []string
	on := &cobra.Command{
		Use:     "on [service]",
		Short:   "Show the maintenance page instead of the app",
		Long:    "Turn the maintenance page on. --title and --message change its text (kept for next time); --allow lets addresses through (replaces the list).",
		Example: "  serve maintenance on\n  serve maintenance on web --message \"Upgrading the database, back soon\"",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"enabled": true}
			if cmd.Flags().Changed("title") {
				body["title"] = title
			}
			if cmd.Flags().Changed("message") {
				body["message"] = message
			}
			if cmd.Flags().Changed("allow") {
				body["allow"] = allow
			}
			return a.setMaintenance(cmd, args, body, "Maintenance is on for %s: visitors see the maintenance page.")
		},
	}
	on.Flags().StringVar(&title, "title", "", "the page's title")
	on.Flags().StringVarP(&message, "message", "m", "", "the page's message")
	on.Flags().StringSliceVar(&allow, "allow", nil, "IP addresses or ranges that still reach the app (comma separated)")
	off := &cobra.Command{
		Use:     "off [service]",
		Short:   "Serve the app again",
		Example: "  serve maintenance off",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.setMaintenance(cmd, args, map[string]any{"enabled": false}, "Maintenance is off for %s.")
		},
	}
	cmd.AddCommand(on, off)
	return cmd
}

func (a *App) setMaintenance(cmd *cobra.Command, args []string, body map[string]any, done string) error {
	ctx := cmd.Context()
	if len(args) == 1 {
		if err := a.serviceArg(args[0]); err != nil {
			return err
		}
	}
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return err
	}
	if s.Type == "database" {
		return fmt.Errorf("%s is a database: it has no web page to put in maintenance", s.Name)
	}
	if err := a.client.Do(ctx, api.Request{Method: "PUT", Path: "/services/" + api.P(s.ID) + "/maintenance", JSON: body}, nil); err != nil {
		return err
	}
	ui.Success(done, ui.Bold(s.Name))
	return nil
}

func (a *App) composeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "compose [stack]",
		Short: "Print the compose file of a stack as it was deployed",
		Long: `Print the compose file Serve last deployed for a Docker Compose stack: your file with the
labels, networks and ports Serve adds. Values of variables stay in its .env, not here.
Works on the linked stack, the one named, or --service.`,
		Example: "  serve compose\n  serve compose plausible > deployed.yml",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 1 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if s.Type != "compose" {
				return fmt.Errorf("%s is not a compose stack (it is a %s)", s.Name, s.Kind())
			}
			var r struct {
				Compose *struct {
					Content   string `json:"content"`
					WrittenAt string `json:"writtenAt"`
				} `json:"compose"`
			}
			if err := a.client.Get(ctx, "/services/"+api.P(s.ID)+"/compose", nil, &r); err != nil {
				return err
			}
			if r.Compose == nil {
				return fmt.Errorf("%s has not been deployed yet, so there is no deployed compose file", s.Name)
			}
			ui.Line(ui.Dim(fmt.Sprintf("Deployed %s", ui.Ago(r.Compose.WrittenAt))))
			fmt.Fprint(ui.Out, r.Compose.Content)
			if !strings.HasSuffix(r.Compose.Content, "\n") {
				fmt.Fprintln(ui.Out)
			}
			return nil
		},
	}
}

func (a *App) containersCmd() *cobra.Command {
	cmd := lsCmd("containers", "List the service's containers, or restart one", []string{"container", "ps"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return err
		}
		list, err := a.client.Containers(ctx, s.ID)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			ui.Info("%s has no containers. Is it deployed? See `serve status`.", s.Name)
			return nil
		}
		// The compose service column only for stacks.
		compose := false
		for _, c := range list {
			compose = compose || deref(c.ComposeService) != ""
		}
		var rows [][]string
		for _, c := range list {
			row := []string{c.Name, ui.StatusColor(c.State), c.Status, c.Image, c.ID}
			if compose {
				row = append([]string{c.Name, deref(c.ComposeService)}, row[1:]...)
			}
			rows = append(rows, row)
		}
		headers := []string{"NAME", "STATE", "STATUS", "IMAGE", "ID"}
		if compose {
			headers = []string{"NAME", "SERVICE", "STATE", "STATUS", "IMAGE", "ID"}
		}
		ui.Table(headers, rows)
		return nil
	})
	cmd.Long = "List the containers of the linked service (or --service): replicas of an app, the services of a compose stack, a database and its helpers."
	cmd.Example = "  serve containers\n  serve containers --service shop-stack --json\n  serve containers restart worker"
	cmd.AddCommand(&cobra.Command{
		Use:   "restart <container>",
		Short: "Restart one container, without a deployment",
		Long: `Restart one container of the service: by its id (or the start of it), its name, or the
compose service it runs. The rest of the service keeps running.`,
		Example: "  serve containers restart worker\n  serve containers restart 3f2a9c1b",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			list, err := a.client.Containers(ctx, s.ID)
			if err != nil {
				return err
			}
			c, err := pickContainer(list, args[0], s.Name)
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/containers/"+api.P(c.ID)+"/restart", nil, nil); err != nil {
				return err
			}
			ui.Success("Restarted %s.", ui.Bold(c.Name))
			return nil
		},
	})
	return cmd
}

// pickContainer finds a container by name, id (or its start), or compose service.
func pickContainer(list []api.Container, ref, serviceName string) (*api.Container, error) {
	var found []*api.Container
	for _, pass := range []func(c *api.Container) bool{
		func(c *api.Container) bool { return c.Name == ref || c.ID == ref },
		func(c *api.Container) bool { return deref(c.ComposeService) == ref },
		func(c *api.Container) bool { return len(ref) >= 4 && strings.HasPrefix(c.ID, ref) },
	} {
		for i := range list {
			if pass(&list[i]) {
				found = append(found, &list[i])
			}
		}
		if len(found) > 0 {
			break
		}
	}
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		names := make([]string, len(list))
		for i, c := range list {
			names[i] = c.Name
		}
		if len(names) == 0 {
			return nil, fmt.Errorf("%s has no containers", serviceName)
		}
		return nil, fmt.Errorf("%s has no container %q. It has: %s", serviceName, ref, strings.Join(names, ", "))
	}
	lines := []string{fmt.Sprintf("%d containers match %q. Name one:", len(found), ref)}
	for _, c := range found {
		lines = append(lines, fmt.Sprintf("  %s  %s", c.Name, c.ID))
	}
	return nil, usagef("%s", strings.Join(lines, "\n"))
}
