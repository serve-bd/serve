package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/serve-bd/serve/cli/internal/config"
)

// hostFile writes this machine's cli.json (in SERVE_DATA_DIR) for the fake server.
func hostFile(t *testing.T, url string) string {
	t.Helper()
	data := t.TempDir()
	t.Setenv("SERVE_DATA_DIR", data)
	p := filepath.Join(data, "cli.json")
	b := `{"url":"` + url + `","publicUrl":null,"token":"tok","organization":{"id":"o1","name":"Root"},"user":{"name":"Ada","email":"ada@example.com"}}`
	if err := os.WriteFile(p, []byte(b), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLocalContext(t *testing.T) {
	_, srv, _ := setup(t)
	file := hostFile(t, srv.URL)
	before, _ := os.ReadFile(file)

	r := execute(t, "whoami", "--json")
	if r.code != 0 || !strings.Contains(r.out, "ada@example.com") || !strings.Contains(r.errout, "Using this server's Serve (signed in as ada@example.com)") {
		t.Fatalf("automatic login: %+v", r)
	}
	if r := execute(t, "context", "ls"); !strings.Contains(r.out, "* local  (this server's Serve, automatic)") {
		t.Fatalf("context ls: %q", r.out)
	}

	// Logging out of local turns the automatic login off, and leaves the file alone.
	if r := execute(t, "logout"); r.code != 0 {
		t.Fatalf("logout: %+v", r)
	}
	cfg, _ := config.Load()
	if cfg.HostAutoLoginOn() {
		t.Fatal("logout should turn hostAutoLogin off")
	}
	if after, err := os.ReadFile(file); err != nil || string(after) != string(before) {
		t.Fatal("cli.json must never change")
	}
	if r := execute(t, "whoami"); r.code != 1 || !strings.Contains(r.errout, "Not signed in. Run serve login <url>") {
		t.Fatalf("after logout: %+v", r)
	}

	// Logging in elsewhere makes that context current.
	if r := execute(t, "login", srv.URL, "--token", "tok", "--name", "other"); r.code != 0 {
		t.Fatalf("login elsewhere: %+v", r)
	}
	cfg, _ = config.Load()
	if cfg.Current != "other" {
		t.Fatalf("current %q", cfg.Current)
	}
	if r := execute(t, "whoami"); strings.Contains(r.errout, "Using this server's Serve") {
		t.Fatal("the other context should be used")
	}

	// context use local turns it back on.
	if r := execute(t, "context", "use", "local"); r.code != 0 {
		t.Fatalf("context use local: %+v", r)
	}
	cfg, _ = config.Load()
	if !cfg.HostAutoLoginOn() || cfg.Current != config.LocalContext {
		t.Fatalf("after use local: %+v", cfg)
	}
	if r := execute(t, "whoami"); !strings.Contains(r.errout, "Using this server's Serve") {
		t.Fatal("local should be used again")
	}

	// login --local does the same after another logout.
	execute(t, "logout")
	execute(t, "context", "use", "other")
	if r := execute(t, "login", "--local"); r.code != 0 {
		t.Fatalf("login --local: %+v", r)
	}
	cfg, _ = config.Load()
	if !cfg.HostAutoLoginOn() || cfg.Current != config.LocalContext {
		t.Fatalf("after login --local: %+v", cfg)
	}

	// Without a terminal, login with no URL on a Serve host names the flags to pass.
	if r := execute(t, "login"); r.code != ExitUsage || !strings.Contains(r.errout, "--local") {
		t.Fatalf("login without URL: %+v", r)
	}
	if r := execute(t, "login", "--name", "local", "--token", "tok", srv.URL); r.code != ExitUsage {
		t.Fatal("the name local is kept")
	}
}

func TestLocalContextMissingOrDown(t *testing.T) {
	setup(t)
	if r := execute(t, "login", "--local"); r.code != 1 || !strings.Contains(r.errout, "not a Serve server") {
		t.Fatalf("--local without a file: %+v", r)
	}
	hostFile(t, "http://127.0.0.1:1")
	if r := execute(t, "whoami"); r.code != 1 || !strings.Contains(r.errout, "Serve on this machine is not answering at http://127.0.0.1:1") {
		t.Fatalf("Serve down: %+v", r)
	}
	if os.Geteuid() != 0 {
		os.Chmod(filepath.Join(os.Getenv("SERVE_DATA_DIR"), "cli.json"), 0)
		if r := execute(t, "whoami"); r.code != 1 || !strings.Contains(r.errout, "Run with sudo to sign in automatically, or use serve login") {
			t.Fatalf("unreadable: %+v", r)
		}
	}
}

func TestDeployEdgeCases(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	write(t, dir, map[string]string{"package.json": "{}"})

	// Databases, compose stacks: a plain reason and a hint.
	if r := execute(t, "deploy", "-s", "pg"); r.code != 1 || !strings.Contains(r.errout, "serve redeploy") {
		t.Fatalf("database: %+v", r)
	}
	if r := execute(t, "deploy", "-s", "stack"); r.code != 1 || !strings.Contains(r.errout, "Docker Compose stack") {
		t.Fatalf("compose: %+v", r)
	}
	// A git app: warned that the upload is a one-off, and it goes on without a terminal.
	r := execute(t, "deploy", "-s", "api", "--no-wait")
	if r.code != 0 || !strings.Contains(r.errout, "one-off") || f.uploads != 1 {
		t.Fatalf("git app: %+v", r)
	}
	if r := execute(t, "deploy", "-s", "api", "--no-wait", "--yes"); strings.Contains(r.errout, "one-off") {
		t.Fatal("--yes skips the warning")
	}

	// A failed upload is tried again.
	f.uploads, f.uploadFailures = 0, 2
	if r := execute(t, "deploy", "-s", "web", "--no-wait"); r.code != 0 || f.uploads != 3 || !strings.Contains(r.errout, "Trying again") {
		t.Fatalf("retries: %+v uploads %d", r, f.uploads)
	}
	f.uploads, f.uploadFailures = 0, 5
	if r := execute(t, "deploy", "-s", "web", "--no-wait"); r.code != 1 || f.uploads != 3 {
		t.Fatalf("gives up after two retries: %+v uploads %d", r, f.uploads)
	}
	// A gateway error after the whole archive went out is not sent again: the server may have
	// started a deployment, and a second upload would deploy twice.
	f.uploads, f.uploadFailures, f.uploadFailStatus = 0, 2, 502
	if r := execute(t, "deploy", "-s", "web", "--no-wait"); r.code != 1 || f.uploads != 1 || !strings.Contains(r.errout, "check `serve deployments`") {
		t.Fatalf("no retry after a full send: %+v uploads %d", r, f.uploads)
	}
	f.uploadFailures, f.uploadFailStatus = 0, 0

	// Cancelled in the dashboard while streaming: exit 3.
	f.finalStatus = "cancelled"
	if r := execute(t, "deploy", "-s", "web"); r.code != ExitDeployed || !strings.Contains(r.errout, "cancelled") {
		t.Fatalf("cancelled: %+v", r)
	}
	f.finalStatus = "success"

	// The build log cannot drive the terminal.
	f.buildLog = "ok\x1b[2J\x1b]0;title\x07 done\n"
	if r := execute(t, "deploy", "-s", "web"); !strings.Contains(r.out, "ok done\n") || strings.Contains(r.out, "\x1b") {
		t.Fatalf("sanitized log: %q", r.out)
	}
	f.buildLog = ""

	// --root uploads a wider folder and compares with the service's base directory.
	write(t, dir, map[string]string{"apps/api/main.go": "package main", "apps/web/index.html": "x"})
	if r := execute(t, "deploy", "apps/web", "--root", ".", "-s", "api", "--no-wait", "--yes"); r.code != 0 || !strings.Contains(r.errout, "builds from apps/api, not apps/web") {
		t.Fatalf("--root: %+v", r)
	}
	if r := execute(t, "deploy", ".", "--root", "apps", "-s", "api"); r.code != ExitUsage {
		t.Fatal("--root must hold the folder")
	}
}

func TestBigFolderWithoutMarkers(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	for i := 0; i <= manyFiles; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), nil, 0o644)
	}
	if r := execute(t, "deploy", "-s", "web", "--no-wait"); r.code != ExitUsage || !strings.Contains(r.errout, "--yes") || f.uploads != 0 {
		t.Fatalf("refused without --yes: %+v", r)
	}
	if r := execute(t, "deploy", "-s", "web", "--no-wait", "--yes"); r.code != 0 || f.uploads != 1 {
		t.Fatalf("--yes: %+v", r)
	}
}

func TestConnectionErrors(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")

	f.rateLimited = 2
	if r := execute(t, "whoami"); r.code != 0 {
		t.Fatalf("429 is waited out: %+v", r)
	}
	f.apiOff = true
	if r := execute(t, "whoami"); r.code != 1 || !strings.Contains(r.errout, "The API is turned off in Settings → Security on "+srv.URL) {
		t.Fatalf("API off: %+v", r)
	}
	f.apiOff = false

	t.Setenv("SERVE_TOKEN", "")
	t.Setenv("SERVE_URL", "")
	f.noCLILogin = true
	if r := execute(t, "login", srv.URL, "--no-browser"); r.code != 1 || !strings.Contains(r.errout, "This Serve is older than the CLI login. Update it, or use serve login --token") {
		t.Fatalf("old Serve: %+v", r)
	}

	// A link to a dashboard without a login, with no terminal: say how to log in.
	os.MkdirAll(filepath.Join(dir, ".serve"), 0o755)
	os.WriteFile(filepath.Join(dir, ".serve", "project.json"), []byte(`{"url":"https://elsewhere.example.com","serviceId":"s1"}`), 0o644)
	if r := execute(t, "login", srv.URL, "--token", "tok"); r.code != 0 {
		t.Fatal(r)
	}
	if r := execute(t, "status"); r.code != 1 || !strings.Contains(r.errout, "serve login https://elsewhere.example.com") {
		t.Fatalf("link to another dashboard: %+v", r)
	}

	// A link whose service is gone, or belongs to another organization.
	link := func(org string) {
		os.WriteFile(filepath.Join(dir, ".serve", "project.json"), []byte(`{"url":"`+srv.URL+`","serviceId":"gone","serviceName":"old","organizationId":"`+org+`","organizationName":"Other"}`), 0o644)
	}
	link("o1")
	if r := execute(t, "status"); r.code != 1 || !strings.Contains(r.errout, "old no longer exists") || !strings.Contains(r.errout, "serve link") {
		t.Fatalf("deleted service: %+v", r)
	}
	link("o2")
	if r := execute(t, "status"); r.code != 1 || !strings.Contains(r.errout, "organization Other, but you are logged in to Acme") {
		t.Fatalf("other organization: %+v", r)
	}

	if r := execute(t, "whoami", "--insecure"); r.code != 0 || !strings.Contains(r.errout, "certificate checks are off") {
		t.Fatalf("--insecure warns: %+v", r)
	}
}

func TestLoginSlowDownAndLink(t *testing.T) {
	f, srv, _ := setup(t)
	f.slowDown = 1
	r := execute(t, "login", srv.URL, "--no-browser")
	if r.code != 0 {
		t.Fatalf("slow_down is not an error: %+v", r)
	}
	// The approval link is built on the address the CLI uses, not the server's verifyUrl.
	if !strings.Contains(r.errout, srv.URL+"/cli/login?code=ABCD-1234") || strings.Contains(r.errout, "http://x/") {
		t.Fatalf("link: %s", r.errout)
	}
	if f.polls != 2 {
		t.Fatalf("polls %d", f.polls)
	}
}

func TestUploadRefusedEarly(t *testing.T) {
	f, srv, dir := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	write(t, dir, map[string]string{"package.json": "{}"})
	// A large body the server never reads: it answers 409 at once.
	big := make([]byte, 8<<20)
	for i := range big {
		big[i] = byte(i*7 + i/13)
	}
	os.WriteFile(filepath.Join(dir, "blob.bin"), big, 0o644)
	f.refuseUpload = "Deploys of shop are frozen until Monday."
	r := execute(t, "deploy", "-s", "web")
	if r.code != 1 || !strings.Contains(r.errout, "frozen until Monday") || f.uploads != 1 {
		t.Fatalf("409: %+v uploads %d", r, f.uploads)
	}
	// Other 4xx answers are not tried again either.
	f.uploads, f.refuseUpload, f.refuseStatus = 0, "The upload is not a valid .tar.gz.", 400
	if r := execute(t, "deploy", "-s", "web"); r.code != 1 || f.uploads != 1 {
		t.Fatalf("400: %+v uploads %d", r, f.uploads)
	}
}
