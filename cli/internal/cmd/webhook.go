package cmd

import (
	"fmt"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) webhookCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "webhook",
		Short: "Manage the service's deploy hook",
		Long:  "Manage the deploy hook of the service: the secret URL that deploys it when called (from CI, for example).",
	}
	var yes bool
	rotate := &cobra.Command{
		Use:   "rotate",
		Short: "Make a new deploy hook secret (the old URL stops working)",
		Long: `Make a new secret for the service's deploy hook and print the new deploy hook URL.
The old URL stops working right away, so update the places that call it. A repository hook Serve
registered gets the new secret by itself. Asks first unless you pass --yes.`,
		Example: "  serve webhook rotate\n  serve webhook rotate --yes --service api",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if !yes {
				if !ui.Interactive {
					return usagef("rotating the deploy hook needs --yes when there is no terminal to ask")
				}
				ok, err := ui.Confirm(fmt.Sprintf("Make a new deploy hook secret for %s? The old URL stops working.", s.Name), false)
				if err != nil {
					return err
				}
				if !ok {
					return ui.ErrAborted
				}
			}
			var r map[string]any
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/webhook-secret", nil, &r); err != nil {
				return err
			}
			ui.Success("Made a new deploy hook secret for %s. The old URL no longer works.", ui.Bold(s.Name))
			if u := hookURL(a.login.URL, s.ID, r); u != "" {
				fmt.Fprintln(ui.Out, u)
				return nil
			}
			// When the answer does not carry the new secret, the settings page shows it.
			ui.Line(ui.Dim("Copy the new URL from " + a.dashboardURL(s) + "/settings/webhooks"))
			return nil
		},
	}
	rotate.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask first")
	cmd.AddCommand(rotate)
	return cmd
}

// hookURL finds the deploy hook URL in the answer: given whole, or as the secret alone.
func hookURL(base, serviceID string, r map[string]any) string {
	for _, k := range []string{"deployHookUrl", "url"} {
		if s, ok := r[k].(string); ok && s != "" {
			return s
		}
	}
	for _, k := range []string{"webhookSecret", "secret", "token"} {
		if s, ok := r[k].(string); ok && s != "" {
			return base + "/api/deploy-hooks/" + api.P(serviceID) + "?token=" + s
		}
	}
	return ""
}
