package cmd

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// confirmName asks for the name of what is about to be deleted. --yes skips it; without a
// terminal the flag is required, so a script never deletes by accident.
func confirmName(what, name string, yes bool) error {
	if yes {
		return nil
	}
	if !ui.Interactive {
		return usagef("deleting %s needs --yes when there is no terminal to ask", what)
	}
	typed, err := ui.Input(fmt.Sprintf("Type %s to delete it", name), name, "")
	if err != nil {
		return err
	}
	if typed != name {
		return errors.New("the name did not match: nothing was deleted")
	}
	return nil
}

// forgetLinksTo removes this folder's link when it points at a service that is gone.
func forgetLinksTo(serviceIDs ...string) {
	l := config.FindLink(".")
	if l == nil {
		return
	}
	for _, id := range serviceIDs {
		if l.ServiceID == id {
			if config.RemoveLink(l.Dir) == nil {
				ui.Info("Removed this folder's link to %s.", orName(l.ServiceName, l.ServiceID))
			}
			return
		}
	}
}

func deleteService(cmd *cobra.Command, c *api.Client, id string, volumes bool) error {
	q := url.Values{}
	if volumes {
		q.Set("volumes", "true")
	}
	return c.Delete(cmd.Context(), "/services/"+api.P(id), q, nil)
}

func (a *App) serviceRmCmd() *cobra.Command {
	var yes, volumes bool
	cmd := &cobra.Command{
		Use:     "rm [service]",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a service: its containers, domains and the DNS records Serve made",
		Long: `Delete a service: the linked one, the one you name, or --service.
Its containers, domains and the DNS records Serve made go. Its data volumes stay unless you
pass --volumes. Asks for the service's name unless you pass --yes.`,
		Example: "  serve services rm web\n  serve services rm web --volumes --yes",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 1 {
				if a.service != "" && a.service != args[0] {
					return usagef("name the service once: %q or --service %q", args[0], a.service)
				}
				a.service = args[0]
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if err := confirmName("a service", s.Name, yes); err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := deleteService(cmd, c, s.ID, volumes); err != nil {
				return err
			}
			ui.Success("Deleted %s%s.", ui.Bold(s.Name), map[bool]string{true: " and its data", false: ""}[volumes])
			forgetLinksTo(s.ID)
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.Flags().BoolVar(&volumes, "volumes", false, "also delete the service's data volumes")
	return cmd
}

func (a *App) projectRmCmd() *cobra.Command {
	var yes, volumes, withServices bool
	cmd := &cobra.Command{
		Use:     "rm <project>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a project",
		Long: `Delete a project. A project with services is only deleted with --with-services,
which deletes them first (their data volumes stay unless you pass --volumes). Asks for the
project's name unless you pass --yes.`,
		Example: "  serve projects rm old-site\n  serve projects rm old-site --with-services --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			p, err := a.findProject(ctx, args[0])
			if err != nil {
				return err
			}
			list, err := c.Services(ctx, p.ID, "")
			if err != nil {
				return err
			}
			// Previews go with the service they belong to.
			var services []api.Service
			for _, s := range list {
				if s.ParentServiceID == nil {
					services = append(services, s)
				}
			}
			names := make([]string, len(services))
			for i, s := range services {
				names[i] = s.Name
			}
			if len(services) > 0 && !withServices {
				return usagef("%s has %d service(s): %s. Delete them first, or pass --with-services", p.Name, len(services), strings.Join(names, ", "))
			}
			if len(services) > 0 {
				ui.Warn("This also deletes %d service(s): %s.", len(services), strings.Join(names, ", "))
			}
			if err := confirmName("a project", p.Name, yes); err != nil {
				return err
			}
			ids := make([]string, 0, len(services))
			for _, s := range services {
				if err := deleteService(cmd, c, s.ID, volumes); err != nil {
					return fmt.Errorf("could not delete %s: %w (the project and the services after it are kept)", s.Name, err)
				}
				ids = append(ids, s.ID)
				ui.Info("Deleted %s.", s.Name)
			}
			forgetLinksTo(ids...)
			if err := c.Delete(ctx, "/projects/"+api.P(p.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the project %s.", ui.Bold(p.Name))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.Flags().BoolVar(&withServices, "with-services", false, "delete the project's services first")
	cmd.Flags().BoolVar(&volumes, "volumes", false, "with --with-services: also delete their data volumes")
	return cmd
}
