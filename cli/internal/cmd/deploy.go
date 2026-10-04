package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/gitinfo"
	"github.com/serve-bd/serve/cli/internal/pack"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

const (
	bigUpload = 100 * 1000 * 1000
	// manyFiles without a project marker looks like the wrong folder.
	manyFiles = 5000
)

type deployFlags struct {
	noWait, noCache, git, includeEnv, yes bool
	message, root                         string
}

func (a *App) deployCmd() *cobra.Command {
	var f deployFlags
	cmd := &cobra.Command{
		Use:   "deploy [path]",
		Short: "Upload this folder, build it and deploy it",
		Long: `Upload a folder (this one by default) to the linked app, build it on the server and
stream the build log until the deployment ends.

Left out of the upload: what .gitignore files (nested ones too, .git/info/exclude
and your global git ignore file) and .dockerignore name, and always .git, .serve,
node_modules and .env files (keep the .env files with --include-env). A .serveignore
file replaces the .gitignore files, so build output that git ignores can be sent.
Symlinks that point outside the folder are left out.

In a monorepo, deploy a subfolder (serve deploy apps/web), or pass --root to upload
a wider folder when the service builds from a base directory inside it.

In a git checkout, the commit, branch and message are shown on the deployment. With
--git, the app's own git repository is deployed instead of the folder.

Exit codes: 0 deployed, 1 error, 2 usage error, 3 the deployment failed or was cancelled.`,
		Example: "  serve deploy\n  serve deploy ./web --message \"New header\"\n  serve deploy apps/web --root .\n  serve deploy --env staging --no-wait",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) > 0 {
				dir = args[0]
			}
			return a.deploy(cmd.Context(), dir, f)
		},
	}
	fl := cmd.Flags()
	fl.BoolVar(&f.noWait, "no-wait", false, "start the deployment and exit (prints its id)")
	fl.StringVarP(&f.message, "message", "m", "", "message shown on the deployment (default: the commit subject)")
	fl.BoolVar(&f.noCache, "no-cache", false, "build without the build cache")
	fl.BoolVar(&f.git, "git", false, "deploy the app's git source instead of uploading the folder")
	fl.BoolVar(&f.includeEnv, "include-env", false, "upload .env files too")
	fl.BoolVarP(&f.yes, "yes", "y", false, "do not ask: upload even a large or unusual folder, and one-off deploys of git apps")
	fl.StringVar(&f.root, "root", "", "upload this wider folder (the service builds from its base directory inside it)")
	return cmd
}

// notUploadable explains why a service cannot be deployed from a folder, or answers "".
func notUploadable(s *api.Service) string {
	switch {
	case s.Type == "database":
		return fmt.Sprintf("%s is a %s database: there is nothing to build from a folder. To restart it with its settings, run `serve redeploy`", s.Name, s.Kind())
	case s.Type == "compose":
		return fmt.Sprintf("%s is a Docker Compose stack, which cannot be deployed from a folder. To deploy it again, run `serve redeploy`", s.Name)
	case s.Type == "app" && s.SourceType() == "image":
		return fmt.Sprintf("%s runs a ready-made image, so there is nothing to build from a folder. To pull and run it again, run `serve redeploy`", s.Name)
	case s.Type != "app":
		return fmt.Sprintf("%s is a %s and cannot be deployed from a folder. Try `serve redeploy`", s.Name, s.Type)
	}
	return ""
}

func (a *App) deploy(ctx context.Context, dir string, f deployFlags) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return usagef("%s is not a folder", dir)
	}
	root := abs
	if f.root != "" {
		if root, err = filepath.Abs(f.root); err != nil {
			return err
		}
		if !insideDir(root, abs) {
			return usagef("--root %s must hold the folder %s", f.root, dir)
		}
	}
	a.dir = abs
	c, err := a.Client()
	if err != nil {
		return err
	}

	var s *api.Service
	if a.service == "" && a.linkFor(abs) == nil {
		if s, err = a.offerLink(ctx, abs); err != nil {
			return err
		}
	} else if s, err = a.target(ctx, abs, anyService); err != nil {
		return err
	}

	var deploymentID string
	if f.git {
		if s.Type == "app" && s.SourceType() == "upload" {
			return errors.New(s.Name + " has no git source; it is deployed from uploads. Run `serve deploy` without --git")
		}
		var r map[string]any
		if err := c.Post(ctx, "/services/"+api.P(s.ID)+"/deploy", map[string]any{"noCache": f.noCache}, &r); err != nil {
			return err
		}
		deploymentID = api.DeploymentIDOf(r)
		ui.Success("Started a deploy of %s from its %s source.", ui.Bold(s.Name), s.Kind())
	} else {
		if msg := notUploadable(s); msg != "" {
			return errors.New(msg)
		}
		if err := a.confirmOneOff(s, abs, f.yes); err != nil {
			return err
		}
		if err := a.checkFolder(root, f.yes); err != nil {
			return err
		}
		if root != abs {
			a.checkRootDir(s, root, abs)
		}
		if deploymentID, err = a.upload(ctx, c, s, root, f); err != nil {
			return err
		}
	}
	if deploymentID == "" {
		ui.Info("The deploy was accepted but did not start yet (a deploy freeze or an approval may hold it). See it in the dashboard:")
		ui.Info("  %s", a.dashboardURL(s)+"/deployments")
		return nil
	}
	if f.noWait {
		fmt.Fprintln(ui.Out, deploymentID)
		ui.Line(ui.Dim("Follow it with: serve logs --build " + deploymentID + " -f"))
		return nil
	}
	return a.wait(ctx, s, deploymentID)
}

func insideDir(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// confirmOneOff warns that an upload to a git app lasts until its next push. Once agreed, the
// link remembers it.
func (a *App) confirmOneOff(s *api.Service, dir string, yes bool) error {
	if s.SourceType() != "git" || yes {
		return nil
	}
	l := a.linkFor(dir)
	if l != nil && l.ServiceID == s.ID && l.OneOffOK {
		return nil
	}
	ui.Warn("%s deploys from git. This upload is a one-off: the next push (or git deploy) replaces it.", s.Name)
	if !ui.Interactive {
		return nil
	}
	ok, err := ui.Confirm("Upload this folder anyway?", true)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("not deployed")
	}
	if l != nil && l.ServiceID == s.ID {
		l.OneOffOK = true
		_ = l.Save()
	}
	return nil
}

// checkFolder stops before uploading a home folder, the root folder, or a big folder that does
// not look like a project.
func (a *App) checkFolder(dir string, yes bool) error {
	if yes {
		return nil
	}
	home, _ := os.UserHomeDir()
	reason := ""
	switch {
	case dir == filepath.VolumeName(dir)+string(filepath.Separator):
		reason = "This is the root folder of the machine."
	case home != "" && filepath.Clean(dir) == filepath.Clean(home):
		reason = "This is your home folder."
	case !pack.HasProjectMarker(dir):
		if n := countFiles(dir, manyFiles+1); n > manyFiles {
			reason = fmt.Sprintf("This folder has more than %d files and no project file (package.json, Dockerfile, go.mod, requirements.txt, index.html, ...).", manyFiles)
		}
	}
	if reason == "" {
		return nil
	}
	ui.Warn("%s Is it the folder you want to deploy?", reason)
	if !ui.Interactive {
		return usagef("refusing to upload %s. Pass --yes if it is the right folder", dir)
	}
	ok, err := ui.Confirm("Upload it anyway?", false)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("not deployed. Run serve deploy in your project folder, or pass its path")
	}
	return nil
}

// countFiles counts files under dir, up to limit, skipping what is always left out.
func countFiles(dir string, limit int) int {
	n := 0
	stop := errors.New("enough")
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules") && p != dir {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			if n++; n >= limit {
				return stop
			}
		}
		return nil
	})
	return n
}

// checkRootDir compares the folder inside --root with the service's base directory.
func (a *App) checkRootDir(s *api.Service, root, dir string) {
	rel, _ := filepath.Rel(root, dir)
	rel = filepath.ToSlash(rel)
	base := ""
	if s.Build != nil {
		base = strings.Trim(strings.TrimPrefix(s.Build.RootDir, "./"), "/")
	}
	if base != rel {
		shown := base
		if shown == "" {
			shown = "the root of the upload"
		}
		ui.Warn("%s builds from %s, not %s. Set its base directory to %s in the service's build settings if it should build that folder.", s.Name, shown, rel, rel)
	}
}

// offerLink asks to link an existing service or create an app when the folder has no link.
func (a *App) offerLink(ctx context.Context, dir string) (*api.Service, error) {
	if !ui.Interactive {
		return nil, usagef("this folder is not linked to an app. Run `serve init` to create one or `serve link` to pick one, or pass --service")
	}
	ui.Info("This folder is not linked to an app yet.")
	choice, err := ui.Select("What do you want to do?", []ui.Option{
		{Label: "Create a new app for this folder", Value: "create"},
		{Label: "Link it to an app that already exists", Value: "link"},
	})
	if err != nil {
		return nil, err
	}
	var l *config.Link
	if choice == "create" {
		l, err = a.create(ctx, dir, createOptions{})
	} else {
		l, err = a.link(ctx, dir, appService)
	}
	if err != nil {
		return nil, err
	}
	c, _ := a.Client()
	return c.Service(ctx, l.ServiceID)
}

// upload packs dir, sends it and answers the new deployment's id.
func (a *App) upload(ctx context.Context, c *api.Client, s *api.Service, dir string, f deployFlags) (string, error) {
	sp := ui.StartSpinner("Reading the folder...")
	res, err := pack.Scan(dir, pack.Options{IncludeEnv: f.includeEnv, GlobalExcludes: gitinfo.ExcludesFile(dir)})
	sp.Stop()
	if err != nil {
		return "", err
	}
	if res.Count == 0 {
		return "", errors.New("there are no files to upload in " + dir + " (are all of them ignored?)")
	}
	ui.Info("Deploying %s to %s", ui.Bold(filepath.Base(dir)), ui.Bold(s.Name))
	ui.Info("  %s files, %s", fmt.Sprint(res.Count), ui.Bytes(res.Size))
	if len(res.Rules) > 0 {
		ui.Line(ui.Dim("  Ignore rules from " + strings.Join(res.Rules, ", ")))
	}
	if len(res.SkippedEnv) > 0 {
		ui.Line(ui.Dim(fmt.Sprintf("  Left out %d .env file(s); pass --include-env to upload them.", len(res.SkippedEnv))))
	}
	if len(res.SkippedLinks) > 0 {
		ui.Warn("Left out %d symlink(s) that point outside the folder: %s", len(res.SkippedLinks), listSome(res.SkippedLinks, 5))
	}
	if len(res.Unreadable) > 0 {
		ui.Warn("Left out %d item(s) that cannot be read: %s", len(res.Unreadable), listSome(res.Unreadable, 5))
	}
	if res.Size > bigUpload {
		ui.Warn("This upload is large (%s). The biggest parts:", ui.Bytes(res.Size))
		for _, d := range res.Largest(5) {
			ui.Info("    %-10s %s", ui.Bytes(d.Size), d.Path)
		}
		ui.Line(ui.Dim("  Add what the build does not need to .serveignore (same format as .gitignore)."))
	}

	q := url.Values{}
	msg := f.message
	if gi := gitinfo.Read(dir); gi != nil && gi.Commit != "" {
		line := "  Commit " + gitinfo.Short(gi.Commit)
		if gi.Branch != "" {
			line += " on " + gi.Branch
		}
		if gi.Subject != "" {
			line += ": " + gi.Subject
		}
		if gi.Dirty {
			line += ui.Yellow(" + local changes")
		}
		ui.Line(line)
		if gitinfo.IsSha(gi.Commit) {
			q.Set("commit", gi.Commit)
		}
		if gi.Branch != "" {
			q.Set("branch", gi.Branch)
		}
		if gi.Dirty {
			q.Set("dirty", "1")
		}
		if msg == "" {
			msg = gi.Subject
		}
	}
	if msg != "" {
		q.Set("message", msg)
	}
	if f.noCache {
		q.Set("noCache", "1")
	}

	// Ctrl+C during packing or upload stops it and removes the archive.
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	sp = ui.StartSpinner("Compressing...")
	archive, size, err := res.WriteTemp()
	sp.Stop()
	if err != nil {
		return "", fmt.Errorf("cannot pack the folder: %w", err)
	}
	defer os.Remove(archive)

	var r map[string]any
	for attempt := 0; ; attempt++ {
		err = a.send(ctx, c, s, archive, size, q, &r)
		if err == nil || ctx.Err() != nil || attempt >= UploadRetries || !uploadRetryable(err) {
			break
		}
		wait := UploadBackoff << attempt
		ui.Warn("The upload failed (%v). Trying again in %s...", err, wait)
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
	if ctx.Err() != nil {
		return "", errors.New("upload stopped; nothing was deployed")
	}
	if err != nil {
		var ae *api.Error
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound && strings.HasPrefix(ae.Message, "No API route") {
			return "", errors.New("this dashboard does not accept uploads yet. Update Serve to a version with CLI deploys")
		}
		return "", err
	}
	ui.Success("Uploaded %s.", ui.Bytes(size))
	return api.DeploymentIDOf(r), nil
}

// uploadRetryable is a failed upload worth sending again: no answer, or a gateway error. An
// answer of the server about the upload itself (a 4xx, 507 disk full) never is.
func uploadRetryable(err error) bool {
	var ne *api.NetworkError
	if errors.As(err, &ne) {
		return true
	}
	var ae *api.Error
	return errors.As(err, &ae) && (ae.Status == 502 || ae.Status == 503 || ae.Status == 504)
}

// Upload retries: two more tries after a network or server error, waiting 2s, then 4s.
var (
	UploadRetries = 2
	UploadBackoff = 2 * time.Second
)

func (a *App) send(ctx context.Context, c *api.Client, s *api.Service, archive string, size int64, q url.Values, out any) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	bar := ui.NewProgress(file, size, "  Uploading")
	defer bar.Done()
	return c.Do(ctx, api.Request{
		Method:      http.MethodPost,
		Path:        "/services/" + api.P(s.ID) + "/deploy/upload",
		Query:       q,
		Body:        bar,
		ContentType: "application/gzip",
		Length:      size,
	}, out)
}

func listSome(list []string, n int) string {
	if len(list) <= n {
		return strings.Join(list, ", ")
	}
	return strings.Join(list[:n], ", ") + fmt.Sprintf(" and %d more", len(list)-n)
}

// lastByte remembers whether output ended with a newline.
type lastByte struct {
	w    io.Writer
	last byte
}

func (l *lastByte) Write(p []byte) (int, error) {
	if len(p) > 0 {
		l.last = p[len(p)-1]
	}
	return l.w.Write(p)
}

// wait streams the build log until the deployment ends. Ctrl+C asks whether to cancel the
// deployment, detach, or keep watching. A deployment that does not succeed exits with code 3.
func (a *App) wait(ctx context.Context, s *api.Service, deploymentID string) error {
	c, err := a.Client()
	if err != nil {
		return err
	}
	ui.Line(ui.Dim(fmt.Sprintf("Deployment %s  %s", deploymentID, a.dashboardURL(s)+"/deployments")))
	out := &lastByte{w: ui.NewLogWriter(ui.Out), last: '\n'}
	started := time.Now()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)

	status := ""
	for {
		fctx, cancel := context.WithCancel(ctx)
		var interrupted atomic.Bool
		go func() {
			select {
			case <-sigs:
				interrupted.Store(true)
				cancel()
			case <-fctx.Done():
			}
		}()
		status, err = c.FollowBuild(fctx, deploymentID, out, api.FollowOptions{
			Interval: time.Second,
			OnStatus: func(st string) {
				if out.last != '\n' {
					fmt.Fprintln(out)
				}
				switch st {
				case "queued":
					ui.Line(ui.Dim("Queued, waiting for a free build slot..."))
				case "waiting":
					ui.Line(ui.Yellow("Waiting for someone to approve this deployment in the dashboard..."))
				}
			},
		})
		cancel()
		if !interrupted.Load() {
			if err != nil {
				return err
			}
			break
		}
		if out.last != '\n' {
			fmt.Fprintln(out)
		}
		if !ui.Interactive {
			ui.Info("Stopped following. The deployment keeps going: serve logs --build %s", deploymentID)
			return silentExit(130)
		}
		choice, perr := ui.Select("Stop watching this deployment?", []ui.Option{
			{Label: "Detach: the deployment keeps going", Value: "detach"},
			{Label: "Cancel the deployment", Value: "cancel"},
			{Label: "Keep watching", Value: "watch"},
		})
		if perr != nil || choice == "detach" {
			ui.Info("Detached. The deployment keeps going. Follow it again with: serve logs --build %s -f", deploymentID)
			return nil
		}
		if choice == "cancel" {
			if err := c.Post(ctx, "/deployments/"+api.P(deploymentID)+"/cancel", nil, nil); err != nil {
				return fmt.Errorf("could not cancel the deployment: %w", err)
			}
			ui.Info("Cancelling...")
			// Keep following until the server reports it cancelled.
		}
	}
	if out.last != '\n' {
		fmt.Fprintln(out)
	}

	d, derr := c.Deployment(ctx, deploymentID)
	elapsed := time.Since(started)
	if derr == nil && d.StartedAt != nil && d.FinishedAt != nil {
		st, e1 := time.Parse(time.RFC3339Nano, *d.StartedAt)
		fi, e2 := time.Parse(time.RFC3339Nano, *d.FinishedAt)
		if e1 == nil && e2 == nil {
			elapsed = fi.Sub(st)
		}
	}
	switch status {
	case "success":
		ui.Success("Deployed %s in %s.", ui.Bold(s.Name), ui.Duration(elapsed))
		if u := a.serviceURL(ctx, s); u != "" {
			ui.Info("  %s", ui.Bold(ui.Cyan(u)))
		}
		return nil
	case "cancelled":
		return exit(ExitDeployed, "the deployment was cancelled")
	case "superseded":
		return exit(ExitDeployed, "a newer deployment of %s replaced this one", s.Name)
	}
	reason := ""
	if derr == nil {
		reason = deref(d.Error)
	}
	if reason != "" {
		return exit(ExitDeployed, "the deployment failed: %s", reason)
	}
	return exit(ExitDeployed, "the deployment failed. See the log above")
}
