package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Deploy approval: deployments of environments that need approval wait until someone approves them.

// waitingDeployment picks the deployment that waits for approval: the only one, or one picked from a list.
func waitingDeployment(verb string) func(s *api.Service, list []api.Deployment) (string, error) {
	return func(s *api.Service, list []api.Deployment) (string, error) {
		var waiting []api.Deployment
		for _, d := range list {
			if d.Status == "waiting" {
				waiting = append(waiting, d)
			}
		}
		switch len(waiting) {
		case 0:
			return "", fmt.Errorf("no deployment of %s waits for approval", s.Name)
		case 1:
			return waiting[0].ID, nil
		}
		opts := make([]ui.Option, len(waiting))
		ids := make([]string, len(waiting))
		for i := range waiting {
			d := &waiting[i]
			opts[i] = ui.Option{Label: strings.TrimSpace(fmt.Sprintf("%s  %s  %s", ui.Ago(d.CreatedAt), d.ID, commitLine(d))), Value: d.ID}
			ids[i] = d.ID
		}
		id, err := ui.Select(strings.ToUpper(verb[:1])+verb[1:], opts)
		return id, needChoice(err, fmt.Sprintf("%d deployments of %s wait for approval. Pass the one to %s: %s", len(waiting), s.Name, verb, strings.Join(ids, ", ")))
	}
}

func (a *App) approveCmd() *cobra.Command {
	var wait, asJSON bool
	cmd := &cobra.Command{
		Use:   "approve [deployment-id]",
		Short: "Approve a deployment that waits for approval",
		Long: `Approve a deployment that waits for approval: it is queued and builds as usual. Without an
id, the one of the linked service (or --service) that waits; with several, pick one.

A deploy freeze still holds it back: approve it once the freeze ends. You need the
Approve deploys permission. --wait follows the build log until the deployment ends.`,
		Example: "  serve approve\n  serve approve 01J9ZK3Q2W --wait\n  serve approve -s api",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, id, err := a.deploymentArg(ctx, args, waitingDeployment("approve"))
			if err != nil {
				return err
			}
			d, err := a.decide(ctx, id, "approve", nil)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(d)
			}
			if wait {
				ui.Info("Approved the deployment %s of %s.", id, ui.Bold(s.Name))
				return a.wait(ctx, s, id)
			}
			ui.Success("Approved the deployment %s of %s. It is %s.", id, s.Name, statusWord(d.Status))
			ui.Line(ui.Dim(fmt.Sprintf("Follow it with `serve logs --build=%s -f`.", id)))
			return nil
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "follow the build until the deployment ends")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the deployment as JSON")
	return cmd
}

func (a *App) rejectCmd() *cobra.Command {
	var reason string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "reject [deployment-id]",
		Short: "Reject a deployment that waits for approval",
		Long: `Reject a deployment that waits for approval: it is cancelled and never builds. Without an
id, the one of the linked service (or --service) that waits; with several, pick one.
--reason is saved with it, so others see why. You need the Approve deploys permission.`,
		Example: "  serve reject\n  serve reject 01J9ZK3Q2W --reason \"Wait for the migration on Monday\"",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(reason) > 500 {
				return usagef("keep --reason under 500 characters")
			}
			ctx := cmd.Context()
			s, id, err := a.deploymentArg(ctx, args, waitingDeployment("reject"))
			if err != nil {
				return err
			}
			body := map[string]any{}
			if strings.TrimSpace(reason) != "" {
				body["reason"] = strings.TrimSpace(reason)
			}
			d, err := a.decide(ctx, id, "reject", body)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(d)
			}
			ui.Success("Rejected the deployment %s of %s.", id, s.Name)
			return nil
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "why it was rejected (shown with the deployment)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the deployment as JSON")
	return cmd
}

// decide approves or rejects a deployment and answers it as it is now.
func (a *App) decide(ctx context.Context, id, verb string, body any) (*api.Deployment, error) {
	var r struct{ Deployment api.Deployment }
	if err := a.client.Post(ctx, "/deployments/"+api.P(id)+"/"+verb, body, &r); err != nil {
		if api.IsStatus(err, 404) && strings.Contains(err.Error(), "No API route") {
			return nil, fmt.Errorf("this dashboard cannot %s deployments over the API yet. Update Serve, or %s it in the dashboard", verb, verb)
		}
		return nil, err
	}
	if r.Deployment.ID == "" {
		r.Deployment.ID, r.Deployment.Status = id, map[string]string{"approve": "queued", "reject": "cancelled"}[verb]
	}
	return &r.Deployment, nil
}

func statusWord(s string) string {
	if s == "" {
		return "queued"
	}
	return s
}
