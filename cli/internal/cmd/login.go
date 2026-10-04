package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

func (a *App) loginCmd() *cobra.Command {
	var o loginOpts
	var local bool
	cmd := &cobra.Command{
		Use:   "login [url]",
		Short: "Log in to a Serve dashboard",
		Long: `Log in to a Serve dashboard. This opens the dashboard in your browser, where you
approve this computer and pick the organization. The login is saved as a context
named after the host, and becomes the current one.

With --token, an API token made on the dashboard's Keys & tokens page is saved
instead, without the browser.

On a machine that runs Serve, the CLI signs in to it by itself (as root): that is
the "local" context. --local switches back to it after logging in elsewhere.`,
		Example: "  serve login https://serve.example.com\n  serve login serve.example.com --token srv_...\n  sudo serve login --local",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			cfg, err := a.config()
			if err != nil {
				return err
			}
			if local {
				if len(args) > 0 || o.token != "" {
					return usagef("--local takes no URL or token")
				}
				return a.useLocal(ctx)
			}
			raw := ""
			if len(args) > 0 {
				raw = args[0]
			} else {
				if _, state := config.ReadHost(); state == config.HostReadable {
					choice, err := ui.Select("Sign in to", []ui.Option{
						{Label: "This server's Serve (automatic)", Value: "local"},
						{Label: "Another instance (enter its URL)", Value: "other"},
					})
					if err != nil {
						return needChoice(err, "pass --local for this server's Serve, or the address of another: serve login https://serve.example.com")
					}
					if choice == "local" {
						return a.useLocal(ctx)
					}
				} else if cur := cfg.Get(cfg.Current); cur != nil {
					raw = cur.URL
				} else if u := os.Getenv("SERVE_URL"); u != "" {
					raw = u
				}
				if raw == "" {
					raw, err = ui.Input("Address of your Serve dashboard", "https://serve.example.com", "")
					if err != nil {
						return needChoice(err, "pass the address: serve login https://serve.example.com")
					}
				}
			}
			base, err := config.NormalizeURL(raw)
			if err != nil {
				return usagef("%s", err.Error())
			}
			_, err = a.loginTo(ctx, base, o)
			return err
		},
	}
	cmd.Flags().StringVar(&o.token, "token", "", "save this API token instead of logging in with the browser")
	cmd.Flags().StringVar(&o.name, "name", "", "name of the context to save (default: the host)")
	cmd.Flags().BoolVar(&o.noBrowser, "no-browser", false, "print the approval link without opening the browser")
	cmd.Flags().BoolVar(&local, "local", false, "use this server's Serve again (the automatic \"local\" context)")
	return cmd
}

type loginOpts struct {
	token, name string
	noBrowser   bool
}

// loginTo logs in to base (with the browser, or the given token), saves the context and makes
// it the current one.
func (a *App) loginTo(ctx context.Context, base string, o loginOpts) (*config.Context, error) {
	cfg, err := a.config()
	if err != nil {
		return nil, err
	}
	if o.name == config.LocalContext {
		return nil, usagef("the name %q is kept for this server's own Serve. Pick another --name", config.LocalContext)
	}
	insecure := a.insecureWanted()
	if insecure {
		a.warnInsecure()
	}
	tok := strings.TrimSpace(o.token)
	if tok == "" {
		if tok, err = a.deviceLogin(ctx, base, o.noBrowser, insecure); err != nil {
			return nil, err
		}
	}
	client := api.NewInsecure(base, tok, a.userAgent(), insecure)
	me, err := client.Me(ctx)
	if err != nil {
		if api.IsStatus(err, http.StatusUnauthorized) {
			return nil, errors.New("this token is not valid for " + base)
		}
		return nil, err
	}
	name := o.name
	if name == "" {
		name = cfg.NameFor(base, me.Organization.ID, me.Organization.Name)
	}
	login := config.Context{
		Name: name, URL: base, Token: tok,
		OrgID: me.Organization.ID, OrgName: me.Organization.Name,
		UserName: me.User.Name, UserEmail: me.User.Email,
		Insecure: insecure,
	}
	cfg.Put(login)
	cfg.Current = name
	if err := cfg.Save(); err != nil {
		return nil, fmt.Errorf("cannot save the login: %w", err)
	}
	ui.Success("Logged in to %s as %s, organization %s.", ui.Bold(config.HostOf(base)), ui.Bold(orName(me.User.Name, me.User.Email)), ui.Bold(me.Organization.Name))
	ui.Line(ui.Dim(fmt.Sprintf("Saved as context %q in %s", name, cfg.Path())))
	return cfg.Get(name), nil
}

// useLocal makes the host's own Serve the current login again.
func (a *App) useLocal(ctx context.Context) error {
	cfg, err := a.config()
	if err != nil {
		return err
	}
	login, err := config.HostContext()
	if err != nil {
		return err
	}
	c := api.New(login.URL, login.Token, a.userAgent())
	c.DownHint = "Serve on this machine is not answering at " + login.URL + ". Is it running?"
	if _, err := c.Me(ctx); err != nil {
		return err
	}
	cfg.SetHostAutoLogin(true)
	cfg.Current = config.LocalContext
	if err := cfg.Save(); err != nil {
		return err
	}
	ui.Success("Using this server's Serve, signed in as %s, organization %s.", ui.Bold(orName(login.UserEmail, login.UserName)), ui.Bold(login.OrgName))
	return nil
}

type loginStart struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	VerifyURL  string `json:"verifyUrl"`
	Interval   int    `json:"interval"`
	ExpiresIn  int    `json:"expiresIn"`
}

type loginPoll struct {
	Status string `json:"status"`
	Token  string `json:"token"`
}

// deviceLogin runs the browser approval and answers the new token.
func (a *App) deviceLogin(ctx context.Context, base string, noBrowser, insecure bool) (string, error) {
	c := api.NewInsecure(base, "", a.userAgent(), insecure)
	host, _ := os.Hostname()
	if host == "" {
		host = runtime.GOOS
	}
	var start loginStart
	err := c.Post(ctx, "/api/cli/login", map[string]string{"client": host, "version": a.Build.Version}, &start)
	if err != nil {
		if api.IsStatus(err, http.StatusNotFound) || api.IsStatus(err, http.StatusUnauthorized) || api.IsStatus(err, http.StatusMethodNotAllowed) {
			return "", fmt.Errorf("This Serve is older than the CLI login. Update it, or use serve login --token (make a token on the Keys & tokens page of %s)", base)
		}
		return "", err
	}
	if start.DeviceCode == "" || start.UserCode == "" {
		return "", errors.New("the server's answer to the login request is missing fields. Is this a Serve dashboard?")
	}
	// The page on the address this login uses: the server's verifyUrl names its public address,
	// which can be another host than the one given here (a dev instance behind a tunnel).
	start.VerifyURL = strings.TrimRight(base, "/") + "/cli/login?code=" + url.QueryEscape(start.UserCode)
	ui.Info("")
	ui.Info("  Your code: %s", ui.Bold(ui.Cyan(start.UserCode)))
	ui.Info("  Approve this computer at: %s", ui.Bold(start.VerifyURL))
	ui.Info("")
	if !noBrowser && canOpenBrowser() {
		if err := openBrowser(start.VerifyURL); err == nil {
			ui.Line(ui.Dim("Opened your browser. Check that it shows the same code."))
		}
	}
	interval := time.Duration(max(start.Interval, 1)) * time.Second
	deadline := time.Now().Add(time.Duration(max(start.ExpiresIn, 60)) * time.Second)
	if !ui.Animated() {
		ui.Info("Waiting for you to approve in the browser...")
	}
	sp := ui.StartSpinner("Waiting for you to approve in the browser...")
	defer sp.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		if time.Now().After(deadline) {
			return "", errors.New("the code expired before it was approved. Run `serve login` again")
		}
		var r loginPoll
		err := c.Do(ctx, api.Request{Method: http.MethodPost, Path: "/api/cli/login/poll", JSON: map[string]string{"deviceCode": start.DeviceCode}, NoRetry: true}, &r)
		var ae *api.Error
		if errors.As(err, &ae) {
			status, _ := ae.Body["status"].(string)
			switch {
			case ae.Status == http.StatusForbidden || status == "denied":
				return "", errors.New("the login was denied in the browser")
			case ae.Status == http.StatusGone || status == "expired":
				return "", errors.New("the code expired or was already used. Run `serve login` again")
			case ae.Status == http.StatusTooManyRequests:
				// slow_down: poll less often, as the server asks.
				if n, ok := ae.Body["interval"].(float64); ok && n > 0 {
					interval = time.Duration(n) * time.Second
				} else {
					interval += time.Second
				}
				continue
			}
		}
		if err != nil {
			if api.Retryable(err) {
				continue
			}
			return "", err
		}
		if r.Status == "approved" && r.Token != "" {
			return r.Token, nil
		}
	}
}

func canOpenBrowser() bool {
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return false
	}
	if runtime.GOOS == "linux" || runtime.GOOS == "freebsd" {
		return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
	}
	return true
}

func openBrowser(u string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	c.Stdout, c.Stderr = nil, nil
	if err := c.Start(); err != nil {
		return err
	}
	go c.Wait()
	return nil
}

func (a *App) logoutCmd() *cobra.Command {
	var keep bool
	cmd := &cobra.Command{
		Use:   "logout [context]",
		Short: "Log out and revoke the token",
		Long:  "Removes the login (the current one, or the named context) and revokes its token on the dashboard.",
		Args:  maxArgs(1),
		ValidArgsFunction: func(cmd *cobra.Command, args []string, s string) ([]string, cobra.ShellCompDirective) {
			return a.completeContexts(cmd, args, s)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Getenv("SERVE_TOKEN") != "" && len(args) == 0 && a.contextName == "" {
				return errors.New("SERVE_TOKEN is set, so there is no saved login to remove. Unset SERVE_TOKEN")
			}
			cfg, err := a.config()
			if err != nil {
				return err
			}
			name := a.contextName
			if len(args) > 0 {
				name = args[0]
			}
			if name == "" {
				if r, err := cfg.Resolve("", ""); err == nil {
					name = r.Name
				}
			}
			if name == config.LocalContext {
				return a.logoutLocal()
			}
			login := cfg.Get(name)
			if login == nil {
				if name == "" {
					return errors.New("you are not logged in")
				}
				return fmt.Errorf("there is no context named %q", name)
			}
			revoked := false
			var revokeErr error
			if !keep {
				insecure := login.Insecure || a.insecureWanted()
				if insecure {
					a.warnInsecure()
				}
				c := api.NewInsecure(login.URL, login.Token, a.userAgent(), insecure)
				ctx, cancel := context.WithTimeout(cmd.Context(), 15*time.Second)
				defer cancel()
				me, err := c.Me(ctx)
				if err == nil {
					err = c.Delete(ctx, "/tokens/"+api.P(me.Token.ID), nil, nil)
				}
				revoked, revokeErr = err == nil, err
			}
			addr := login.URL
			cfg.Remove(name)
			if err := cfg.Save(); err != nil {
				return err
			}
			switch {
			case revoked:
				ui.Success("Logged out of %s and revoked its token.", name)
			case keep:
				ui.Success("Logged out of %s. The token still works.", name)
			default:
				ui.Success("Logged out of %s here.", name)
				ui.Warn("Could not revoke the token on %s: %v. Revoke it in Keys & tokens.", addr, revokeErr)
			}
			if cfg.Current != "" {
				ui.Line(ui.Dim("Now using context " + cfg.Current + "."))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&keep, "keep-token", false, "remove the login here but keep the token working")
	return cmd
}

// logoutLocal stops the automatic use of this server's Serve. The server's cli.json is left
// alone: it belongs to the server.
func (a *App) logoutLocal() error {
	cfg, err := a.config()
	if err != nil {
		return err
	}
	cfg.SetHostAutoLogin(false)
	if cfg.Current == config.LocalContext || cfg.Get(cfg.Current) == nil {
		cfg.Current = ""
		if len(cfg.Contexts) > 0 {
			cfg.Current = cfg.Contexts[0].Name
		}
	}
	if err := cfg.Save(); err != nil {
		return err
	}
	ui.Success("Signed out of this server's Serve. The CLI no longer uses it by itself.")
	ui.Line(ui.Dim("Log in to another instance with `serve login <url>`, or come back with `serve login --local`."))
	return nil
}

func (a *App) whoamiCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "whoami",
		Short: "Show the login in use",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			me, err := c.Me(cmd.Context())
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(map[string]any{"url": a.login.URL, "context": a.login.Name, "me": me})
			}
			role := "member"
			if me.Admin {
				role = "admin"
			}
			ui.KV([][2]string{
				{"User", strings.TrimSpace(me.User.Name + " <" + me.User.Email + ">")},
				{"Organization", me.Organization.Name + " (" + role + ")"},
				{"Dashboard", a.login.URL},
				{"Context", a.login.Name},
				{"Token", me.Token.Name},
			})
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) contextCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "context",
		Aliases: []string{"contexts", "ctx"},
		Short:   "List and switch logins",
		Long:    "A context is one login: a dashboard, a token and an organization. One is current; --context picks another for a single command.",
	}
	var asJSON bool
	ls := &cobra.Command{
		Use:     "ls",
		Aliases: []string{"list"},
		Short:   "List the contexts",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := a.config()
			if err != nil {
				return err
			}
			host, _ := config.ReadHost()
			if host != nil && host.Token == "" {
				host = nil
			}
			current := ""
			if r, err := cfg.Resolve("", ""); err == nil && !r.FromEnv {
				current = r.Name
			}
			if asJSON {
				out := []map[string]any{}
				if host != nil {
					out = append(out, map[string]any{"name": config.LocalContext, "url": host.URL, "organization": host.Organization.Name, "user": host.User.Email, "current": current == config.LocalContext, "automatic": true, "enabled": cfg.HostAutoLoginOn()})
				}
				for _, c := range cfg.Contexts {
					out = append(out, map[string]any{"name": c.Name, "url": c.URL, "organization": c.OrgName, "user": c.UserEmail, "current": c.Name == current})
				}
				return printJSON(out)
			}
			if len(cfg.Contexts) == 0 && host == nil {
				ui.Info("No logins yet. Run `serve login <url>`.")
				return nil
			}
			mark := func(name string) string {
				if name == current {
					return "* "
				}
				return "  "
			}
			var rows [][]string
			if host != nil {
				note := "(this server's Serve, automatic)"
				if !cfg.HostAutoLoginOn() {
					note = "(this server's Serve, off: serve login --local)"
				}
				rows = append(rows, []string{mark(config.LocalContext) + config.LocalContext + "  " + ui.OutDim(note), host.URL, host.Organization.Name, host.User.Email})
			}
			for _, c := range cfg.Contexts {
				rows = append(rows, []string{mark(c.Name) + c.Name, c.URL, c.OrgName, c.UserEmail})
			}
			ui.Table([]string{"  NAME", "URL", "ORGANIZATION", "USER"}, rows)
			return nil
		},
	}
	ls.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	use := &cobra.Command{
		Use:               "use <name>",
		Short:             "Make a context the current one (local: this server's Serve)",
		Args:              exactArgs(1),
		ValidArgsFunction: a.completeContexts,
		RunE: func(cmd *cobra.Command, args []string) error {
			if args[0] == config.LocalContext {
				return a.useLocal(cmd.Context())
			}
			cfg, err := a.config()
			if err != nil {
				return err
			}
			if cfg.Get(args[0]) == nil {
				return fmt.Errorf("there is no context named %q. See `serve context ls`", args[0])
			}
			cfg.Current = args[0]
			if err := cfg.Save(); err != nil {
				return err
			}
			ui.Success("Now using %s.", args[0])
			return nil
		},
	}
	rm := &cobra.Command{
		Use:               "rm <name>",
		Aliases:           []string{"remove"},
		Short:             "Remove a context (the token keeps working; use logout to revoke it)",
		Args:              exactArgs(1),
		ValidArgsFunction: a.completeContexts,
		RunE: func(cmd *cobra.Command, args []string) error {
			if args[0] == config.LocalContext {
				return a.logoutLocal()
			}
			cfg, err := a.config()
			if err != nil {
				return err
			}
			if !cfg.Remove(args[0]) {
				return fmt.Errorf("there is no context named %q", args[0])
			}
			if err := cfg.Save(); err != nil {
				return err
			}
			ui.Success("Removed %s.", args[0])
			return nil
		},
	}
	cmd.AddCommand(ls, use, rm)
	return cmd
}

// Argument checks that count as usage errors (exit code 2).

func noArgs(cmd *cobra.Command, args []string) error {
	if len(args) > 0 {
		return usagef("%s takes no arguments, got %q", cmd.CommandPath(), args[0])
	}
	return nil
}

func exactArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) != n {
			return usagef("%s needs %d argument(s), got %d", cmd.CommandPath(), n, len(args))
		}
		return nil
	}
}

func maxArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) > n {
			return usagef("%s takes at most %d argument(s), got %d", cmd.CommandPath(), n, len(args))
		}
		return nil
	}
}

func minArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < n {
			return usagef("%s needs at least %d argument(s)", cmd.CommandPath(), n)
		}
		return nil
	}
}
