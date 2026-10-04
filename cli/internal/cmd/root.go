// Package cmd holds the commands of the serve CLI.
package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Build information, set by main.
type Build struct {
	Version string
	Commit  string
	Date    string
}

// App is the state shared by the commands of one run.
type App struct {
	Build Build

	contextName string
	service     string
	environment string
	project     string
	noColor     bool
	insecure    bool
	// dir is the folder whose link the commands use (deploy sets it to its path).
	dir string

	warnedInsecure bool
	cfg            *config.Config
	login          *config.Context
	client         *api.Client
	notice         *updateNotice
}

func NewRoot(b Build) *cobra.Command {
	root, _ := newRoot(b)
	return root
}

// noticeCommands show the update notice when they end (see notice.go).
var noticeCommands = [][]string{
	{"deploy"}, {"redeploy"}, {"rollback"}, {"init"}, {"link"}, {"status"}, {"login"}, {"logs"},
	{"env", "pull"}, {"env", "push"},
}

func newRoot(b Build) (*cobra.Command, *App) {
	cobra.EnableCommandSorting = false
	a := &App{Build: b}
	root := &cobra.Command{
		Use:   "serve",
		Short: "Deploy and manage apps on your Serve dashboard",
		Long: `serve deploys a folder to your Serve dashboard and manages its services.

  serve login https://serve.example.com   log in (opens the browser)
  serve deploy                            upload this folder, build it and stream the log
  serve status                            the service, its URL and current deployment

Commands that work on a service use the one this folder is linked to (serve link), or
--service. In CI, set SERVE_URL and SERVE_TOKEN instead of logging in.`,
		SilenceUsage:      true,
		SilenceErrors:     true,
		Version:           b.Version,
		CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: false},
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			if a.noColor {
				ui.DisableColor()
			}
			a.startNotice(cmd)
		},
	}
	root.SetVersionTemplate("serve {{.Version}}\n")
	root.SetFlagErrorFunc(func(c *cobra.Command, err error) error { return usagef("%s", err.Error()) })

	pf := root.PersistentFlags()
	pf.StringVar(&a.contextName, "context", "", "use the login (context) of this `name`")
	pf.StringVarP(&a.service, "service", "s", "", "the service (`name` or id) to use instead of the linked one")
	pf.StringVarP(&a.environment, "env", "e", "", "the environment (`name` or id) to use instead of the linked one")
	pf.BoolVar(&a.noColor, "no-color", false, "print without colors")
	pf.BoolVar(&a.insecure, "insecure", false, "skip HTTPS certificate checks (a self-signed dashboard; also SERVE_INSECURE=1)")
	_ = root.RegisterFlagCompletionFunc("service", a.completeServices)
	_ = root.RegisterFlagCompletionFunc("context", a.completeContexts)

	root.AddGroup(
		&cobra.Group{ID: "start", Title: "Getting started:"},
		&cobra.Group{ID: "deploy", Title: "Deploying:"},
		&cobra.Group{ID: "manage", Title: "Managing a service:"},
		&cobra.Group{ID: "browse", Title: "Browsing:"},
	)
	add := func(group string, cmds ...*cobra.Command) {
		for _, c := range cmds {
			c.GroupID = group
			root.AddCommand(c)
		}
	}
	add("start", a.loginCmd(), a.logoutCmd(), a.whoamiCmd(), a.contextCmd(), a.linkCmd(), a.initCmd(), a.unlinkCmd())
	add("deploy", a.deployCmd(), a.deploymentsCmd(), a.redeployCmd(), a.rollbackCmd(), a.cancelCmd(), a.forceStartCmd())
	add("manage", a.statusCmd(), a.openCmd(), a.logsCmd(), a.controlCmd("start"), a.controlCmd("stop"), a.controlCmd("restart"), a.builderCmd(), a.envCmd(), a.domainsCmd(), a.dbCmd())
	add("manage", a.varsCmd(), a.tasksCmd(), a.previewsCmd(), a.tagsCmd(), a.uptimeCmd(), a.webhookCmd())
	add("browse", a.projectsCmd(), a.servicesCmd(), a.serversCmd())
	root.AddCommand(a.versionCmd(), a.upgradeCmd())
	guardGroups(root)
	for _, p := range noticeCommands {
		if c, _, err := root.Find(p); err == nil && c.Name() == p[len(p)-1] {
			withNotice(c)
		}
	}
	return root, a
}

// Execute runs the CLI and answers the exit code.
func Execute(b Build, args []string) int {
	root, a := newRoot(b)
	root.SetArgs(args)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	cmd, err := root.ExecuteContextC(ctx)
	if err != nil {
		path := ""
		if cmd != nil {
			path = cmd.CommandPath()
		}
		PrintError(err, path)
	}
	a.finishNotice()
	return ExitCode(err)
}

func (a *App) userAgent() string {
	return fmt.Sprintf("serve-cli/%s (%s/%s)", a.Build.Version, runtime.GOOS, runtime.GOARCH)
}

func (a *App) config() (*config.Config, error) {
	if a.cfg == nil {
		c, err := config.Load()
		if err != nil {
			return nil, err
		}
		a.cfg = c
	}
	return a.cfg, nil
}

func (a *App) workDir() string {
	if a.dir != "" {
		return a.dir
	}
	return "."
}

// Client is the API client of the login to use. The link of the folder helps pick it: a
// context for the linked dashboard is used, and without one the CLI offers to log in to it.
func (a *App) Client() (*api.Client, error) {
	if a.client != nil {
		return a.client, nil
	}
	cfg, err := a.config()
	if err != nil {
		return nil, err
	}
	linkURL := ""
	if l := config.FindLink(a.workDir()); l != nil {
		linkURL = l.URL
	}
	login, err := cfg.Resolve(a.contextName, linkURL)
	if errors.Is(err, config.ErrTokenWithoutURL) {
		return nil, usagef("%s", err.Error())
	}
	if errors.Is(err, config.ErrNoLogin) && linkURL != "" {
		login, err = a.offerLogin(linkURL)
	}
	if err != nil {
		return nil, err
	}
	if linkURL != "" && !login.Matches(linkURL) && !login.Explicit {
		if login, err = a.offerLogin(linkURL); err != nil {
			return nil, err
		}
	}
	return a.use(login), nil
}

// offerLogin is for a folder linked to a dashboard without a saved login.
func (a *App) offerLogin(linkURL string) (*config.Context, error) {
	if !ui.Interactive {
		return nil, fmt.Errorf("this folder is linked to %s, where you are not logged in. Run `serve login %s`, or pass --context", linkURL, linkURL)
	}
	ok, err := ui.Confirm(fmt.Sprintf("This folder is linked to %s, where you are not logged in. Log in now?", linkURL), true)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("not logged in to %s. Run `serve login %s`, or `serve unlink`", linkURL, linkURL)
	}
	return a.loginTo(context.Background(), linkURL, loginOpts{})
}

func (a *App) use(login *config.Context) *api.Client {
	a.login = login
	insecure := login.Insecure || a.insecureWanted()
	if insecure {
		a.warnInsecure()
	}
	c := api.NewInsecure(login.URL, login.Token, a.userAgent(), insecure)
	if login.FromHost {
		c.DownHint = "Serve on this machine is not answering at " + login.URL + ". Is it running?"
		ui.Line(ui.Dim("Using this server's Serve (signed in as " + orName(login.UserEmail, login.UserName) + ")"))
	}
	a.client = c
	return c
}

func (a *App) insecureWanted() bool {
	v := strings.ToLower(os.Getenv("SERVE_INSECURE"))
	return a.insecure || v == "1" || v == "true" || v == "yes"
}

func (a *App) warnInsecure() {
	if !a.warnedInsecure {
		a.warnedInsecure = true
		ui.Warn("HTTPS certificate checks are off. Use this only with a dashboard you trust.")
	}
}

func printJSON(v any) error {
	enc := json.NewEncoder(ui.Out)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// deref answers the string or "".
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// guardGroups makes a command that only groups others (serve db, serve env) refuse a word it does
// not know, instead of printing its help as if nothing were wrong. With no word it prints the help.
func guardGroups(c *cobra.Command) {
	for _, sub := range c.Commands() {
		guardGroups(sub)
	}
	if c.Parent() == nil || !c.HasSubCommands() || c.Run != nil || c.RunE != nil {
		return
	}
	c.Args = func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return nil
		}
		// Typos of up to two letters, like "ulr" for "url", get the right word back.
		if cmd.SuggestionsMinimumDistance <= 0 {
			cmd.SuggestionsMinimumDistance = 2
		}
		if s := cmd.SuggestionsFor(args[0]); len(s) > 0 {
			return usagef("unknown command %q for %s. Did you mean %s %s?", args[0], cmd.CommandPath(), cmd.CommandPath(), s[0])
		}
		return usagef("unknown command %q for %s", args[0], cmd.CommandPath())
	}
	c.RunE = func(cmd *cobra.Command, args []string) error { return cmd.Help() }
}
