package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// LocalContext is the automatic login on a machine that runs Serve: the dashboard keeps a token
// for the CLI in <data dir>/cli.json, readable by root.
const LocalContext = "local"

// SystemHostFile is where a standard install keeps it. Tests point it elsewhere.
var SystemHostFile = "/data/serve/cli.json"

// HostFile is the content of cli.json.
type HostFile struct {
	URL          string `json:"url"`
	PublicURL    string `json:"publicUrl"`
	Token        string `json:"token"`
	Organization struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"organization"`
	User struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`

	Path string `json:"-"`
}

// HostState says what was found of cli.json on this machine.
type HostState int

const (
	HostNone       HostState = iota // no Serve on this machine
	HostReadable                    // found and read
	HostUnreadable                  // Serve runs here, but this user cannot read the file
)

// HostPaths lists where cli.json is looked for, in order: $SERVE_DATA_DIR (for several installs
// on one host, or a development checkout), then the standard place.
func HostPaths() []string {
	var out []string
	if d := os.Getenv("SERVE_DATA_DIR"); d != "" {
		out = append(out, filepath.Join(d, "cli.json"))
	}
	return append(out, SystemHostFile)
}

// ReadHost looks for cli.json. The first file that exists decides.
func ReadHost() (*HostFile, HostState) {
	for _, p := range HostPaths() {
		b, err := os.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return &HostFile{Path: p}, HostUnreadable
		}
		h := &HostFile{Path: p}
		if json.Unmarshal(b, h) != nil || h.URL == "" || h.Token == "" {
			// Half written or from another version: treat as not there.
			continue
		}
		return h, HostReadable
	}
	return nil, HostNone
}

// Context is the automatic login made from cli.json.
func (h *HostFile) Context() *Context {
	return &Context{
		Name: LocalContext, URL: h.URL, Token: h.Token,
		OrgID: h.Organization.ID, OrgName: h.Organization.Name,
		UserName: h.User.Name, UserEmail: h.User.Email,
		FromHost: true, PublicURL: h.PublicURL,
	}
}

// ErrHostUnreadable is said when Serve runs here but the file cannot be read.
var ErrHostUnreadable = errors.New("Serve runs on this machine. Run with sudo to sign in automatically, or use serve login")

// ErrNoHost is said for --local on a machine without Serve.
var ErrNoHost = errors.New("this machine has no readable Serve login file (" + SystemHostFile + "): it is not a Serve server, or the CLI needs sudo to read it")

// HostAutoLoginOn says whether cli.json may be used (it is unless serve logout turned it off).
func (c *Config) HostAutoLoginOn() bool { return c.HostAutoLogin == nil || *c.HostAutoLogin }

func (c *Config) SetHostAutoLogin(on bool) { c.HostAutoLogin = &on }
