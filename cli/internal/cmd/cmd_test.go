package cmd

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
)

// fake is a small Serve API: one project, one upload app (s1) and one database.
type fake struct {
	mu               sync.Mutex
	uploadFailures   int // answer uploadFailStatus (503 by default) to this many uploads first
	uploadFailStatus int
	rateLimited      int  // answer 429 to this many GET /me first
	apiOff           bool // answer 503 as an instance with the API turned off
	noCLILogin       bool // an older Serve without /api/cli
	uploads          int
	slowDown         int    // answer slow_down to this many polls first
	refuseUpload     string // answer the upload with this reason before reading it
	refuseStatus     int
	buildLog         string
	finalStatus      string
	uploaded         []string
	query            url.Values
	vars             map[string]string
	polls            int
	created          map[string]any
}

func (f *fake) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	service := map[string]any{"id": "s1", "name": "web", "slug": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"source": map[string]any{"type": "upload"}, "runtime": map[string]any{"replicas": 1}, "currentDeploymentId": nil, "domains": []string{"https://web.example.com"}}
	gitApp := map[string]any{"id": "s2", "name": "api", "slug": "api", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"source": map[string]any{"type": "git", "repository": "https://example.com/r.git"}, "runtime": map[string]any{"replicas": 1}, "build": map[string]any{"rootDir": "apps/api"}}
	stack := map[string]any{"id": "c1", "name": "stack", "type": "compose", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1"}
	db := map[string]any{"id": "db1", "name": "pg", "type": "database", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1", "database": map[string]any{"engine": "postgres"}}

	mux.HandleFunc("POST /api/cli/login", func(w http.ResponseWriter, r *http.Request) {
		if f.noCLILogin {
			j(w, 404, map[string]any{"error": "Not found"})
			return
		}
		j(w, 201, map[string]any{"deviceCode": strings.Repeat("d", 40), "userCode": "ABCD-1234", "verifyUrl": "http://x/cli/login?code=ABCD-1234", "interval": 0, "expiresIn": 600})
	})
	mux.HandleFunc("POST /api/cli/login/poll", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.polls++
		if f.slowDown > 0 {
			f.slowDown--
			j(w, 429, map[string]any{"status": "slow_down", "interval": 1, "error": "Slow down"})
			return
		}
		if f.polls < 2 {
			j(w, 202, map[string]any{"status": "pending"})
			return
		}
		j(w, 200, map[string]any{"status": "approved", "token": "srv_new", "user": map[string]any{"name": "Ada"}, "organization": map[string]any{"id": "o1", "name": "Acme"}})
	})
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer tok" && auth != "Bearer srv_new" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.apiOff {
			j(w, 503, map[string]any{"error": "The API is turned off. An admin of this Serve instance can turn it on in Settings → Security."})
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		if p == "/me" && f.rateLimited > 0 {
			f.rateLimited--
			w.Header().Set("Retry-After", "0")
			j(w, 429, map[string]any{"error": "Too many requests"})
			return
		}
		switch r.Method + " " + p {
		case "GET /me":
			j(w, 200, map[string]any{"token": map[string]any{"id": "t1", "name": "CLI"}, "user": map[string]any{"name": "Ada", "email": "ada@example.com"}, "organization": map[string]any{"id": "o1", "name": "Acme"}})
		case "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}}})
		case "GET /projects/p1/environments":
			j(w, 200, map[string]any{"environments": []any{map[string]any{"id": "e1", "projectId": "p1", "name": "production"}}})
		case "GET /servers":
			j(w, 200, map[string]any{"servers": []any{map[string]any{"id": "srv1", "name": "local", "status": "ready", "isLocal": true}}})
		case "GET /services":
			j(w, 200, map[string]any{"services": []any{service, gitApp, stack, db}})
		case "GET /services/s2":
			j(w, 200, map[string]any{"service": gitApp})
		case "GET /services/c1":
			j(w, 200, map[string]any{"service": stack})
		case "POST /services/s2/deploy/upload":
			f.uploads++
			j(w, 202, map[string]any{"deploymentId": "d1"})
		case "POST /services":
			json.NewDecoder(r.Body).Decode(&f.created)
			j(w, 201, map[string]any{"id": "s1"})
		case "GET /services/s1":
			j(w, 200, map[string]any{"service": service})
		case "GET /services/db1":
			j(w, 200, map[string]any{"service": db})
		case "GET /services/db1/connection":
			j(w, 200, map[string]any{"connection": map[string]any{"engine": "postgres", "variables": map[string]any{"HOST": "pg", "DATABASE_URL": "postgres://u:p@pg:5432/app"}}})
		case "GET /services/s1/domains":
			j(w, 200, map[string]any{"domains": []any{map[string]any{"id": "dm1", "hostname": "web.example.com", "url": "https://web.example.com", "primary": true}}})
		case "POST /services/s1/deploy/upload":
			f.uploads++
			if f.refuseUpload != "" {
				status := f.refuseStatus
				if status == 0 {
					status = 409
				}
				j(w, status, map[string]any{"error": f.refuseUpload})
				return
			}
			if f.uploadFailures > 0 {
				f.uploadFailures--
				io.Copy(io.Discard, r.Body)
				status := f.uploadFailStatus
				if status == 0 {
					status = 503
				}
				j(w, status, map[string]any{"error": http.StatusText(status)})
				return
			}
			if r.Header.Get("Content-Type") != "application/gzip" {
				j(w, 400, map[string]any{"error": "not gzip"})
				return
			}
			f.query = r.URL.Query()
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				j(w, 400, map[string]any{"error": err.Error()})
				return
			}
			tr := tar.NewReader(gz)
			for {
				h, err := tr.Next()
				if err != nil {
					break
				}
				if h.Typeflag == tar.TypeReg {
					f.uploaded = append(f.uploaded, h.Name)
				}
			}
			j(w, 202, map[string]any{"deploymentId": "d1"})
		case "GET /deployments/d1/logs":
			log := "Building...\nDone.\n"
			if f.buildLog != "" {
				log = f.buildLog
			}
			off := 0
			if o := r.URL.Query().Get("offset"); o != "" {
				off = len(log)
			}
			j(w, 200, map[string]any{"status": f.finalStatus, "logs": log[off:], "offset": len(log)})
		case "GET /deployments/d1":
			j(w, 200, map[string]any{"deployment": map[string]any{"id": "d1", "serviceId": "s1", "status": f.finalStatus, "error": "Build failed: exit code 1"}})
		case "GET /services/s1/variables":
			var out []any
			for k, v := range f.vars {
				out = append(out, map[string]any{"key": k, "value": v, "buildTime": true, "runtime": true})
			}
			j(w, 200, map[string]any{"variables": out})
		case "PATCH /services/s1/variables":
			var body struct{ Variables map[string]*string }
			json.NewDecoder(r.Body).Decode(&body)
			for k, v := range body.Variables {
				if v == nil {
					delete(f.vars, k)
				} else {
					f.vars[k] = *v
				}
			}
			j(w, 200, map[string]any{"ok": true})
		default:
			j(w, 404, map[string]any{"error": "No API route " + r.Method + " " + p + ". See /api/v1/openapi.json."})
		}
	})
	return mux
}

type run struct {
	code        int
	out, errout string
}

// setup makes a project folder, a config folder and a fake server, and moves into the folder.
func setup(t *testing.T) (*fake, *httptest.Server, string) {
	t.Helper()
	f := &fake{finalStatus: "success", vars: map[string]string{"A": "1"}}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("SERVE_TOKEN", "")
	t.Setenv("SERVE_URL", "")
	t.Setenv("SERVE_CONTEXT", "")
	t.Setenv("SERVE_NO_UPDATE_CHECK", "1")
	t.Setenv("SERVE_INSECURE", "")
	t.Setenv("SERVE_DATA_DIR", "")
	old := config.SystemHostFile
	config.SystemHostFile = filepath.Join(t.TempDir(), "cli.json")
	t.Cleanup(func() { config.SystemHostFile = old })
	UploadBackoff = time.Millisecond
	dir := t.TempDir()
	t.Chdir(dir)
	return f, srv, dir
}

func execute(t *testing.T, args ...string) run {
	t.Helper()
	var out, errout bytes.Buffer
	ui.Out, ui.Err = &out, &errout
	defer func() { ui.Out, ui.Err = os.Stdout, os.Stderr }()
	code := Execute(Build{Version: "v1.0.0"}, args)
	return run{code, out.String(), errout.String()}
}

func write(t *testing.T, dir string, files map[string]string) {
	for p, c := range files {
		full := filepath.Join(dir, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExitCodes(t *testing.T) {
	_, srv, _ := setup(t)
	if r := execute(t, "nonsense"); r.code != ExitUsage {
		t.Fatalf("unknown command: %d %s", r.code, r.errout)
	}
	if r := execute(t, "status", "--bogus"); r.code != ExitUsage {
		t.Fatalf("unknown flag: %d", r.code)
	}
	if r := execute(t, "env", "get"); r.code != ExitUsage {
		t.Fatalf("missing argument: %d", r.code)
	}
	if r := execute(t, "status"); r.code != ExitError || !strings.Contains(r.errout, "serve login") {
		t.Fatalf("not logged in: %d %s", r.code, r.errout)
	}
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "wrong")
	if r := execute(t, "whoami"); r.code != ExitError || !strings.Contains(r.errout, "Run `serve login`") {
		t.Fatalf("401: %d %s", r.code, r.errout)
	}
	t.Setenv("SERVE_TOKEN", "tok")
	if r := execute(t, "status"); r.code != ExitUsage || !strings.Contains(r.errout, "not linked") {
		t.Fatalf("no link without a terminal is a usage error: %d %s", r.code, r.errout)
	}
	if r := execute(t, "version", "--no-check"); r.code != 0 || !strings.Contains(r.errout, "v1.0.0") {
		t.Fatalf("version: %+v", r)
	}
	if ExitCode(errors.New("x")) != 1 || ExitCode(nil) != 0 || ExitCode(exit(ExitDeployed, "failed")) != 3 {
		t.Fatal("ExitCode mapping")
	}
}

func TestLoginWithDeviceFlow(t *testing.T) {
	_, srv, _ := setup(t)
	r := execute(t, "login", srv.URL, "--no-browser")
	if r.code != 0 {
		t.Fatalf("login: %+v", r)
	}
	if !strings.Contains(r.errout, "ABCD-1234") || !strings.Contains(r.errout, "Logged in") {
		t.Fatalf("output: %s", r.errout)
	}
	cfg, _ := config.Load()
	ctx := cfg.Get(cfg.Current)
	if ctx == nil || ctx.Token != "srv_new" || ctx.OrgName != "Acme" || ctx.URL != srv.URL {
		t.Fatalf("saved: %+v", cfg)
	}
	if r := execute(t, "whoami", "--json"); r.code != 0 || !strings.Contains(r.out, "ada@example.com") {
		t.Fatalf("whoami: %+v", r)
	}
	if r := execute(t, "context", "ls"); !strings.Contains(r.out, "* "+config.HostOf(srv.URL)) {
		t.Fatalf("context ls: %q", r.out)
	}
}

func TestDeploy(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	write(t, dir, map[string]string{"index.js": "x", ".env": "SECRET=1", ".gitignore": "dist\n", "dist/out.js": "x", "node_modules/a/b.js": "x"})

	r := execute(t, "link", "--service", "web")
	if r.code != 0 {
		t.Fatalf("link: %+v", r)
	}
	l, err := config.ReadLink(dir)
	if err != nil || l.ServiceID != "s1" || l.EnvironmentName != "production" || l.URL != srv.URL {
		t.Fatalf("link file: %+v %v", l, err)
	}

	r = execute(t, "deploy", "-m", "hello")
	if r.code != 0 {
		t.Fatalf("deploy: %+v", r)
	}
	sort.Strings(f.uploaded)
	if strings.Join(f.uploaded, ",") != ".gitignore,index.js" {
		t.Fatalf("uploaded %v", f.uploaded)
	}
	if f.query.Get("message") != "hello" {
		t.Fatalf("query %v", f.query)
	}
	if !strings.Contains(r.out, "Building...\nDone.\n") || !strings.Contains(r.errout, "https://web.example.com") || !strings.Contains(r.errout, "Deployed") {
		t.Fatalf("output:\n%s\n%s", r.out, r.errout)
	}

	f.finalStatus = "failed"
	r = execute(t, "deploy")
	if r.code != ExitDeployed || !strings.Contains(r.errout, "exit code 1") {
		t.Fatalf("a failed deployment exits 3: %+v", r)
	}

	r = execute(t, "deploy", "--no-wait")
	if r.code != 0 || strings.TrimSpace(r.out) != "d1" {
		t.Fatalf("--no-wait prints the id: %+v", r)
	}
}

func TestEnvAndDB(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	if r := execute(t, "env", "set", "B=two words", "C=3", "--service", "s1"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if r := execute(t, "env", "unset", "C", "-s", "s1"); r.code != 0 || f.vars["C"] != "" {
		t.Fatalf("unset: %+v %v", r, f.vars)
	}
	r := execute(t, "env", "ls", "-s", "s1")
	if strings.Contains(r.out, "two words") || !strings.Contains(r.out, "B") {
		t.Fatalf("ls should mask values: %q", r.out)
	}
	if r := execute(t, "env", "ls", "-s", "s1", "--reveal"); !strings.Contains(r.out, "two words") {
		t.Fatalf("--reveal: %q", r.out)
	}
	if r := execute(t, "env", "get", "B", "-s", "s1"); strings.TrimSpace(r.out) != "two words" {
		t.Fatalf("get: %+v", r)
	}
	if r := execute(t, "env", "pull", "-s", "s1"); r.code != 0 {
		t.Fatalf("pull: %+v", r)
	}
	b, _ := os.ReadFile(filepath.Join(dir, ".env"))
	if string(b) != "A=1\nB='two words'\n" {
		t.Fatalf(".env: %q", b)
	}
	if r := execute(t, "env", "pull", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "--force") {
		t.Fatalf("pull must not overwrite: %+v", r)
	}
	write(t, dir, map[string]string{"prod.env": "X=\"a\\nb\"\n"})
	if r := execute(t, "env", "push", "prod.env", "-s", "s1"); r.code != 0 || f.vars["X"] != "a\nb" {
		t.Fatalf("push: %+v %v", r, f.vars)
	}
	if r := execute(t, "db", "url", "-s", "pg"); strings.TrimSpace(r.out) != "postgres://u:p@pg:5432/app" {
		t.Fatalf("db url: %+v", r)
	}
	if r := execute(t, "services", "ls", "--json"); r.code != 0 || !strings.Contains(r.out, `"db1"`) {
		t.Fatalf("services --json: %+v", r)
	}
}

func TestInit(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	r := execute(t, "init", "--project", "shop", "--name", "my-app", "--port", "8080")
	if r.code != 0 {
		t.Fatalf("init: %+v", r)
	}
	src, _ := f.created["source"].(map[string]any)
	if f.created["name"] != "my-app" || src["type"] != "upload" || f.created["port"] != float64(8080) || f.created["serverId"] != "srv1" || f.created["environmentId"] != "e1" {
		t.Fatalf("created %v", f.created)
	}
	if _, err := config.ReadLink(dir); err != nil {
		t.Fatal("init should link the folder")
	}
}

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.3.2", "v0.3.1", true},
		{"v0.3.1", "v0.3.1", false},
		{"v0.3.1", "v0.10.0", false},
		{"v1.0.0", "v1.0.0-rc.1", true},
		{"v1.0.0", "dev", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%s, %s) = %v", c.a, c.b, got)
		}
	}
}

func TestVersionCheckIsCached(t *testing.T) {
	setup(t)
	t.Setenv("SERVE_NO_UPDATE_CHECK", "")
	hits := 0
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"tag_name":"v9.0.0"}`))
	}))
	defer gh.Close()
	old := ReleasesURL
	ReleasesURL = gh.URL
	defer func() { ReleasesURL = old }()
	for i := 0; i < 2; i++ {
		r := execute(t, "version")
		if !strings.Contains(r.errout, "v9.0.0") {
			t.Fatalf("should tell about the newer version: %q", r.errout)
		}
	}
	if hits != 1 {
		t.Fatalf("GitHub was asked %d times, want once a day", hits)
	}
}
