package cmd

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/gitinfo"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

var triggerLabels = map[string]string{
	"cli": "CLI upload", "manual": "manual", "create": "created", "rollback": "rollback",
	"redeploy": "redeploy", "webhook": "git push", "deploy-hook": "deploy hook", "api": "API",
}

func triggerLabel(t string) string {
	if l, ok := triggerLabels[t]; ok {
		return l
	}
	return t
}

// commitLine describes the source of a deployment: "1a2b3c4 main Fix the header".
func commitLine(d *api.Deployment) string {
	parts := []string{}
	if sha := deref(d.CommitSha); sha != "" {
		parts = append(parts, gitinfo.Short(sha))
	}
	if b := deref(d.Branch); b != "" {
		parts = append(parts, b)
	}
	if m := deref(d.CommitMessage); m != "" {
		m, _, _ = strings.Cut(m, "\n")
		if len(m) > 60 {
			m = m[:57] + "..."
		}
		parts = append(parts, m)
	}
	if d.Upload != nil && d.Upload.Dirty {
		parts = append(parts, "+ local changes")
	}
	return strings.Join(parts, " ")
}

func (a *App) deploymentsCmd() *cobra.Command {
	var asJSON bool
	var limit int
	cmd := &cobra.Command{
		Use:     "deployments",
		Aliases: []string{"deploys"},
		Short:   "List the deployments of the service, newest first",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if limit < 1 || limit > 200 {
				return usagef("--limit must be from 1 to 200")
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			list, err := a.client.Deployments(ctx, s.ID, limit)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(list)
			}
			if len(list) == 0 {
				ui.Info("%s has no deployments yet.", s.Name)
				return nil
			}
			cur := deref(s.CurrentDeploymentID)
			var rows [][]string
			for i := range list {
				d := &list[i]
				id := d.ID
				if d.ID == cur {
					id += " *"
				}
				rows = append(rows, []string{id, ui.StatusColor(d.Status), triggerLabel(d.Trigger), commitLine(d), ui.Ago(d.CreatedAt)})
			}
			ui.Table([]string{"ID", "STATUS", "TRIGGER", "SOURCE", "CREATED"}, rows)
			if cur != "" {
				ui.Line(ui.Dim("* is the deployment that runs now."))
			}
			return nil
		},
	}
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.PersistentFlags().IntVarP(&limit, "limit", "n", 20, "how many to show (at most 200)")
	// "serve deployments ls" reads naturally too.
	cmd.AddCommand(&cobra.Command{Use: "ls", Short: "Same as serve deployments", Args: noArgs, RunE: cmd.RunE})
	return cmd
}

// deploymentArg answers the deployment named by args, or one picked by pick from the service's list.
func (a *App) deploymentArg(ctx context.Context, args []string, pick func(s *api.Service, list []api.Deployment) (string, error)) (*api.Service, string, error) {
	c, err := a.Client()
	if err != nil {
		return nil, "", err
	}
	if len(args) > 0 {
		d, err := c.Deployment(ctx, args[0])
		if err != nil {
			return nil, "", err
		}
		s, err := c.Service(ctx, d.ServiceID)
		return s, d.ID, err
	}
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return nil, "", err
	}
	list, err := c.Deployments(ctx, s.ID, 50)
	if err != nil {
		return nil, "", err
	}
	id, err := pick(s, list)
	return s, id, err
}

func (a *App) redeployCmd() *cobra.Command {
	var noWait bool
	cmd := &cobra.Command{
		Use:   "redeploy [deployment-id]",
		Short: "Deploy the same source again (by default the one that runs now)",
		Long:  "Build and deploy the source of a deployment again: the same commit, or the same upload. Without an id, the deployment that runs now (or the newest one).",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, id, err := a.deploymentArg(ctx, args, func(s *api.Service, list []api.Deployment) (string, error) {
				if cur := deref(s.CurrentDeploymentID); cur != "" {
					return cur, nil
				}
				if len(list) == 0 {
					return "", fmt.Errorf("%s has no deployments yet. Run `serve deploy`", s.Name)
				}
				return list[0].ID, nil
			})
			if err != nil {
				return err
			}
			var r map[string]any
			if err := a.client.Post(ctx, "/deployments/"+api.P(id)+"/redeploy", nil, &r); err != nil {
				return err
			}
			return a.started(ctx, s, api.DeploymentIDOf(r), "Redeploying", noWait)
		},
	}
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "do not wait for the deployment to end")
	return cmd
}

// started reports a new deployment and waits for it unless noWait.
func (a *App) started(ctx context.Context, s *api.Service, id, what string, noWait bool) error {
	if id == "" {
		ui.Success("%s %s.", what, s.Name)
		return nil
	}
	if noWait {
		ui.Success("%s %s.", what, s.Name)
		fmt.Fprintln(ui.Out, id)
		return nil
	}
	ui.Info("%s %s...", what, ui.Bold(s.Name))
	return a.wait(ctx, s, id)
}

func (a *App) rollbackCmd() *cobra.Command {
	var noWait bool
	cmd := &cobra.Command{
		Use:   "rollback [deployment-id]",
		Short: "Run an earlier deployment's image again, without building",
		Long:  "Roll back to an earlier successful deployment. Without an id, pick one from a list.",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, id, err := a.deploymentArg(ctx, args, func(s *api.Service, list []api.Deployment) (string, error) {
				cur := deref(s.CurrentDeploymentID)
				var opts []ui.Option
				for i := range list {
					d := &list[i]
					if d.Status != "success" || d.ID == cur {
						continue
					}
					label := fmt.Sprintf("%s  %s  %s", ui.Ago(d.CreatedAt), d.ID, commitLine(d))
					opts = append(opts, ui.Option{Label: strings.TrimSpace(label), Value: d.ID})
				}
				if len(opts) == 0 {
					return "", fmt.Errorf("%s has no earlier successful deployment to roll back to", s.Name)
				}
				id, err := ui.Select("Roll back to", opts)
				return id, needChoice(err, "pass the deployment id: serve rollback <id> (see `serve deployments`)")
			})
			if err != nil {
				return err
			}
			var r map[string]any
			if err := a.client.Post(ctx, "/deployments/"+api.P(id)+"/rollback", nil, &r); err != nil {
				return err
			}
			return a.started(ctx, s, api.DeploymentIDOf(r), "Rolling back", noWait)
		},
	}
	cmd.Flags().BoolVar(&noWait, "no-wait", false, "do not wait for the rollback to end")
	return cmd
}

func (a *App) cancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel [deployment-id]",
		Short: "Cancel a deployment (by default the newest one still running)",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			_, id, err := a.deploymentArg(ctx, args, func(s *api.Service, list []api.Deployment) (string, error) {
				for _, d := range list {
					if api.Active(d.Status) {
						return d.ID, nil
					}
				}
				return "", errors.New("no deployment of " + s.Name + " is running or queued")
			})
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/deployments/"+api.P(id)+"/cancel", nil, nil); err != nil {
				return err
			}
			ui.Success("Cancelled the deployment %s.", id)
			return nil
		},
	}
}

func (a *App) forceStartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "force-start [deployment-id]",
		Short: "Start a queued deployment now, past the build server's limit",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			_, id, err := a.deploymentArg(ctx, args, func(s *api.Service, list []api.Deployment) (string, error) {
				for _, d := range list {
					if d.Status == "queued" {
						return d.ID, nil
					}
				}
				return "", errors.New("no deployment of " + s.Name + " is queued")
			})
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/deployments/"+api.P(id)+"/force-start", nil, nil); err != nil {
				return err
			}
			ui.Success("Started the deployment %s.", id)
			return nil
		},
	}
}
