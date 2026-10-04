// Package config keeps the logins (contexts) in the user's config folder and the project link
// in .serve/project.json of a project folder.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Context is one login: a Serve instance, a token and the organization the token belongs to.
type Context struct {
	Name      string `json:"name"`
	URL       string `json:"url"`
	Token     string `json:"token"`
	OrgID     string `json:"orgId,omitempty"`
	OrgName   string `json:"orgName,omitempty"`
	UserName  string `json:"userName,omitempty"`
	UserEmail string `json:"userEmail,omitempty"`
	// Insecure skips TLS certificate checks (a self-signed dashboard), set by login --insecure.
	Insecure bool `json:"insecure,omitempty"`
	// FromEnv is true for a context made from SERVE_URL and SERVE_TOKEN; it is never saved.
	FromEnv bool `json:"-"`
	// FromHost is true for the automatic "local" context of a Serve host; it is never saved.
	FromHost  bool   `json:"-"`
	PublicURL string `json:"-"`
	// Explicit is true when --context, SERVE_CONTEXT or SERVE_TOKEN chose the login.
	Explicit bool `json:"-"`
}

// Matches says whether the context is for this dashboard address.
func (x *Context) Matches(rawURL string) bool {
	return SameURL(x.URL, rawURL) || (x.PublicURL != "" && SameURL(x.PublicURL, rawURL))
}

type Config struct {
	Current  string    `json:"current,omitempty"`
	Contexts []Context `json:"contexts"`
	// HostAutoLogin false stops the use of the host's cli.json (after serve logout of "local").
	HostAutoLogin *bool `json:"hostAutoLogin,omitempty"`

	path string
}

// Dir is the config folder: $XDG_CONFIG_HOME/serve, else ~/.config/serve (%AppData%\serve on Windows).
func Dir() (string, error) {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "serve"), nil
	}
	if runtime.GOOS == "windows" {
		d, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(d, "serve"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "serve"), nil
}

// CacheDir is where the update check is remembered.
func CacheDir() (string, error) {
	if x := os.Getenv("XDG_CACHE_HOME"); x != "" {
		return filepath.Join(x, "serve"), nil
	}
	d, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "serve"), nil
}

// Load reads the config file. A missing file is an empty config.
func Load() (*Config, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	return LoadFile(filepath.Join(dir, "config.json"))
}

func LoadFile(path string) (*Config, error) {
	c := &Config{path: path}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("the config file %s is not valid JSON: %w", path, err)
	}
	return c, nil
}

// Save writes the config with mode 0600, through a temporary file so a crash never leaves half a file.
func (c *Config) Save() error {
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), ".config-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), c.path)
}

func (c *Config) Path() string { return c.path }

func (c *Config) Get(name string) *Context {
	for i := range c.Contexts {
		if c.Contexts[i].Name == name {
			return &c.Contexts[i]
		}
	}
	return nil
}

// Put adds the context or replaces the one of the same name.
func (c *Config) Put(ctx Context) {
	if old := c.Get(ctx.Name); old != nil {
		*old = ctx
		return
	}
	c.Contexts = append(c.Contexts, ctx)
	sort.Slice(c.Contexts, func(i, j int) bool { return c.Contexts[i].Name < c.Contexts[j].Name })
}

// Remove deletes a context. When it was the current one, another one (if any) becomes current.
func (c *Config) Remove(name string) bool {
	for i := range c.Contexts {
		if c.Contexts[i].Name == name {
			c.Contexts = append(c.Contexts[:i], c.Contexts[i+1:]...)
			if c.Current == name {
				c.Current = ""
				if len(c.Contexts) > 0 {
					c.Current = c.Contexts[0].Name
				}
			}
			return true
		}
	}
	return false
}

// NameFor picks a context name for a login: the host, or host/org when the host is already
// used by a login to another organization.
func (c *Config) NameFor(rawURL, orgID, orgName string) string {
	host := HostOf(rawURL)
	for _, x := range c.Contexts {
		if SameURL(x.URL, rawURL) && x.OrgID == orgID {
			return x.Name
		}
	}
	if c.Get(host) == nil {
		return host
	}
	slug := strings.ToLower(strings.Join(strings.Fields(orgName), "-"))
	if slug == "" {
		slug = orgID
	}
	name := host + "/" + slug
	for i := 2; c.Get(name) != nil; i++ {
		name = fmt.Sprintf("%s/%s-%d", host, slug, i)
	}
	return name
}

// ErrNoLogin means there is no login to use.
var ErrNoLogin = errors.New("Not signed in. Run serve login <url>")

// Resolve picks the login to use. In order: SERVE_TOKEN (with SERVE_URL, the link's URL or the
// current context's URL), the --context flag, SERVE_CONTEXT, a context for the linked project's
// URL, the current context, the only context, and last the host's cli.json (the "local"
// context) unless serve logout turned that off.
func (c *Config) Resolve(flagContext, linkURL string) (*Context, error) {
	if token := os.Getenv("SERVE_TOKEN"); token != "" {
		u := os.Getenv("SERVE_URL")
		if u == "" {
			u = linkURL
		}
		if u == "" {
			if cur := c.Get(c.Current); cur != nil {
				u = cur.URL
			}
		}
		if u == "" {
			return nil, errors.New("SERVE_TOKEN is set but SERVE_URL is not. Set SERVE_URL to the address of your Serve dashboard")
		}
		u, err := NormalizeURL(u)
		if err != nil {
			return nil, err
		}
		return &Context{Name: "env", URL: u, Token: token, FromEnv: true, Explicit: true}, nil
	}
	name := flagContext
	if name == "" {
		name = os.Getenv("SERVE_CONTEXT")
	}
	if name == LocalContext {
		ctx, err := HostContext()
		if err != nil {
			return nil, err
		}
		ctx.Explicit = true
		return ctx, nil
	}
	if name != "" {
		ctx := c.Get(name)
		if ctx == nil {
			return nil, fmt.Errorf("there is no context named %q. See `serve context ls`", name)
		}
		x := *ctx
		x.Explicit = true
		return &x, nil
	}

	var host *Context
	hostState := HostNone
	if c.HostAutoLoginOn() {
		var h *HostFile
		h, hostState = ReadHost()
		if hostState == HostReadable {
			host = h.Context()
		}
	}
	if c.Current == LocalContext && host != nil {
		if linkURL == "" || host.Matches(linkURL) {
			return host, nil
		}
	}
	cur := c.Get(c.Current)
	if linkURL != "" && (cur == nil || !cur.Matches(linkURL)) {
		for i := range c.Contexts {
			if c.Contexts[i].Matches(linkURL) {
				return &c.Contexts[i], nil
			}
		}
		if host != nil && host.Matches(linkURL) {
			return host, nil
		}
	}
	if cur != nil {
		return cur, nil
	}
	if c.Current == LocalContext && host != nil {
		return host, nil
	}
	if len(c.Contexts) == 1 {
		return &c.Contexts[0], nil
	}
	if host != nil {
		return host, nil
	}
	if hostState == HostUnreadable {
		return nil, ErrHostUnreadable
	}
	return nil, ErrNoLogin
}

// HostContext is the "local" context, or why there is none.
func HostContext() (*Context, error) {
	h, state := ReadHost()
	switch state {
	case HostReadable:
		return h.Context(), nil
	case HostUnreadable:
		return nil, ErrHostUnreadable
	}
	return nil, ErrNoHost
}

// NormalizeURL adds a scheme (http for localhost, https elsewhere) and drops a trailing slash.
func NormalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("the URL is empty")
	}
	if !strings.Contains(raw, "://") {
		host := raw
		if i := strings.IndexAny(host, ":/"); i >= 0 {
			host = host[:i]
		}
		if host == "localhost" || host == "127.0.0.1" || strings.HasSuffix(host, ".localhost") {
			raw = "http://" + raw
		} else {
			raw = "https://" + raw
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("%q is not a valid address. Use one like https://serve.example.com", raw)
	}
	u.RawQuery, u.Fragment = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

func HostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Host
}

func SameURL(a, b string) bool {
	return strings.TrimRight(strings.ToLower(a), "/") == strings.TrimRight(strings.ToLower(b), "/")
}
