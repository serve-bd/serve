package cmd

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) previewsCmd() *cobra.Command {
	cmd := lsCmd("previews", "List the open pull requests and their previews", []string{"preview"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		s, err := a.previewApp(ctx)
		if err != nil {
			return err
		}
		if s.SourceType() == "image" {
			// An image app has no pull requests to read: its previews are the ones deployed by tag.
			list, err := a.client.Previews(ctx, s)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(list)
			}
			if len(list) == 0 {
				ui.Info("%s has no previews. Deploy one with `serve previews deploy <number> --tag <image tag>`.", s.Name)
				return nil
			}
			var rows [][]string
			for _, p := range list {
				rows = append(rows, []string{"#" + strconv.Itoa(derefInt(p.PreviewPr)), ui.StatusColor(p.Status), p.Name, a.previewURL(ctx, p.ID)})
			}
			ui.Table([]string{"NUMBER", "STATUS", "PREVIEW", "URL"}, rows)
			return nil
		}
		prs, err := a.client.PullRequests(ctx, s.ID)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(prs)
		}
		if len(prs) == 0 {
			ui.Info("%s has no open pull requests.", s.Name)
			return nil
		}
		var rows [][]string
		for _, pr := range prs {
			preview := ui.OutDim("none")
			switch {
			case pr.PreviewID != nil:
				preview = a.previewURL(ctx, *pr.PreviewID)
				if preview == "" {
					preview = "yes"
				}
			case pr.Fork:
				preview = ui.OutDim("fork: not deployed")
			}
			rows = append(rows, []string{"#" + strconv.Itoa(pr.Number), shorten(pr.Title, 50), pr.Branch, deref(pr.Author), preview})
		}
		ui.Table([]string{"PR", "TITLE", "BRANCH", "AUTHOR", "PREVIEW"}, rows)
		return nil
	})
	cmd.Long = `List the open pull requests of the app's repository, with the preview each one has.
For an app that runs an image, list its previews (deployed by image tag).

Previews must be on for the app (Settings → Previews in the dashboard).`
	cmd.Example = "  serve previews\n  serve previews deploy 42\n  serve previews rm 42"
	cmd.AddCommand(a.previewDeployCmd(), a.previewRmCmd())
	return cmd
}

func derefInt(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

// previewApp is the app whose previews a command works on. A linked preview counts as its app.
func (a *App) previewApp(ctx context.Context) (*api.Service, error) {
	s, err := a.target(ctx, ".", appService)
	if err != nil {
		return nil, err
	}
	if s.ParentServiceID != nil {
		return a.client.Service(ctx, *s.ParentServiceID)
	}
	if s.Type != "app" {
		return nil, fmt.Errorf("%s is a %s: previews are for apps", s.Name, s.Kind())
	}
	return s, nil
}

// previewURL is the main address of a preview, or "".
func (a *App) previewURL(ctx context.Context, id string) string {
	ds, err := a.client.Domains(ctx, id)
	if err != nil || len(ds) == 0 {
		return ""
	}
	for _, d := range ds {
		if d.Primary {
			return d.URL
		}
	}
	return ds[0].URL
}

// prNumber reads "42" or "#42".
func prNumber(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimPrefix(s, "#"))
	return n, err == nil && n > 0
}

func (a *App) previewDeployCmd() *cobra.Command {
	var tag string
	var wait bool
	cmd := &cobra.Command{
		Use:   "deploy <pr number>",
		Short: "Deploy the preview of a pull request (again)",
		Long: `Deploy the preview of an open pull request: one opened before previews were on, or
one to build again. Pull requests from forks are not deployed.

For an app that runs an image, --tag deploys that image tag (or a sha256 digest) as the preview
with this number; the same number again moves that preview to the new tag.

--wait follows the build log until the preview is live.`,
		Example: "  serve previews deploy 42\n  serve previews deploy 42 --wait\n  serve previews deploy 7 --tag pr-7",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			n, ok := prNumber(args[0])
			if !ok {
				return usagef("%q is not a pull request number", args[0])
			}
			ctx := cmd.Context()
			s, err := a.previewApp(ctx)
			if err != nil {
				return err
			}
			var r struct {
				PreviewID    string `json:"previewId"`
				DeploymentID string `json:"deploymentId"`
			}
			switch {
			case s.SourceType() == "image":
				if tag == "" {
					return usagef("%s runs an image: pass --tag with the image tag to preview", s.Name)
				}
				err = a.client.Post(ctx, "/services/"+api.P(s.ID)+"/previews", map[string]any{"pr": n, "tag": tag}, &r)
			case tag != "":
				return usagef("--tag is for apps that run an image; %s is built from a repository", s.Name)
			default:
				err = a.client.Post(ctx, "/services/"+api.P(s.ID)+"/pull-requests/"+strconv.Itoa(n)+"/preview", nil, &r)
			}
			if err != nil {
				return err
			}
			ui.Success("Deploying the preview of #%d for %s.", n, ui.Bold(s.Name))
			if r.DeploymentID == "" {
				return nil
			}
			if !wait {
				ui.Line(ui.Dim("Follow it with: serve logs --build " + r.DeploymentID + " -f"))
				return nil
			}
			p, err := a.client.Service(ctx, r.PreviewID)
			if err != nil {
				return err
			}
			return a.wait(ctx, p, r.DeploymentID)
		},
	}
	cmd.Flags().StringVar(&tag, "tag", "", "an image app: the image `tag` (or digest) to run")
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "follow the build log until it ends")
	return cmd
}

func (a *App) previewRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <pr number or preview>",
		Aliases: []string{"delete", "remove"},
		Short:   "Remove a pull request preview",
		Long: `Remove a preview (and its database copy) before its pull request closes. Name it by
the pull request number, or by the preview's name or id. Asks for the preview's name unless you
pass --yes. Pushing to the pull request again deploys a new preview.`,
		Example: "  serve previews rm 42\n  serve previews rm 42 --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.previewApp(ctx)
			if err != nil {
				return err
			}
			list, err := a.client.Previews(ctx, s)
			if err != nil {
				return err
			}
			var p *api.Preview
			n, isNumber := prNumber(args[0])
			for i := range list {
				l := &list[i]
				if (isNumber && derefInt(l.PreviewPr) == n) || l.ID == args[0] || strings.EqualFold(l.Name, args[0]) {
					p = l
					break
				}
			}
			if p == nil {
				if isNumber {
					return fmt.Errorf("%s has no preview for #%d", s.Name, n)
				}
				return fmt.Errorf("%s has no preview %q", s.Name, args[0])
			}
			if err := confirmName("a preview", p.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/previews/"+api.P(p.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Removed the preview %s (#%d).", ui.Bold(p.Name), derefInt(p.PreviewPr))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}
