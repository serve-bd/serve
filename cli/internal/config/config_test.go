package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSaveLoad(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Contexts) != 0 {
		t.Fatal("a missing file should be an empty config")
	}
	c.Put(Context{Name: "a.example.com", URL: "https://a.example.com", Token: "srv_a"})
	c.Put(Context{Name: "b.example.com", URL: "https://b.example.com", Token: "srv_b"})
	c.Current = "b.example.com"
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(c.Path())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, want 0600", info.Mode().Perm())
	}
	if !strings.HasSuffix(c.Path(), filepath.Join("serve", "config.json")) {
		t.Fatalf("path %s", c.Path())
	}
	again, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if again.Current != "b.example.com" || len(again.Contexts) != 2 || again.Get("a.example.com").Token != "srv_a" {
		t.Fatalf("loaded %+v", again)
	}
	again.Remove("b.example.com")
	if again.Current != "a.example.com" {
		t.Fatalf("removing the current context should pick another, got %q", again.Current)
	}
}

func TestNameFor(t *testing.T) {
	c := &Config{}
	if n := c.NameFor("https://serve.example.com", "org1", "Acme"); n != "serve.example.com" {
		t.Fatal(n)
	}
	c.Put(Context{Name: "serve.example.com", URL: "https://serve.example.com", OrgID: "org1"})
	if n := c.NameFor("https://serve.example.com", "org1", "Acme"); n != "serve.example.com" {
		t.Fatalf("same org should reuse the name, got %s", n)
	}
	if n := c.NameFor("https://serve.example.com", "org2", "Other Team"); n != "serve.example.com/other-team" {
		t.Fatalf("another org gets its own name, got %s", n)
	}
}

// noHost makes sure no cli.json of this machine takes part.
func noHost(t *testing.T) {
	old := SystemHostFile
	SystemHostFile = filepath.Join(t.TempDir(), "cli.json")
	t.Cleanup(func() { SystemHostFile = old })
	t.Setenv("SERVE_DATA_DIR", "")
}

func TestResolve(t *testing.T) {
	noHost(t)
	t.Setenv("SERVE_TOKEN", "")
	t.Setenv("SERVE_URL", "")
	t.Setenv("SERVE_CONTEXT", "")
	c := &Config{Current: "one"}
	c.Put(Context{Name: "one", URL: "https://one.example.com", Token: "t1"})
	c.Put(Context{Name: "two", URL: "https://two.example.com", Token: "t2"})

	got, err := c.Resolve("", "")
	if err != nil || got.Name != "one" {
		t.Fatalf("current: %v %v", got, err)
	}
	if got, _ = c.Resolve("two", ""); got.Name != "two" {
		t.Fatal("--context should win")
	}
	if _, err := c.Resolve("nope", ""); err == nil {
		t.Fatal("an unknown context is an error")
	}
	if got, _ = c.Resolve("", "https://two.example.com/"); got.Name != "two" {
		t.Fatal("the link's URL should pick its context")
	}
	t.Setenv("SERVE_CONTEXT", "two")
	if got, _ = c.Resolve("", ""); got.Name != "two" {
		t.Fatal("SERVE_CONTEXT should pick the context")
	}
	t.Setenv("SERVE_CONTEXT", "")

	// SERVE_TOKEN overrides every saved login.
	t.Setenv("SERVE_TOKEN", "srv_env")
	t.Setenv("SERVE_URL", "ci.example.com/")
	got, err = c.Resolve("two", "")
	if err != nil || !got.FromEnv || got.Token != "srv_env" || got.URL != "https://ci.example.com" {
		t.Fatalf("env: %+v %v", got, err)
	}
	t.Setenv("SERVE_URL", "")
	if got, _ = c.Resolve("", "https://linked.example.com"); got.URL != "https://linked.example.com" || got.Token != "srv_env" {
		t.Fatalf("SERVE_TOKEN without SERVE_URL should use the link's URL: %+v", got)
	}
	empty := &Config{}
	if _, err := empty.Resolve("", ""); err == nil {
		t.Fatal("SERVE_TOKEN without any URL is an error")
	}

	t.Setenv("SERVE_TOKEN", "")
	if _, err := empty.Resolve("", ""); err != ErrNoLogin {
		t.Fatalf("no login: %v", err)
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{
		"serve.example.com":          "https://serve.example.com",
		"https://serve.example.com/": "https://serve.example.com",
		"localhost:3000":             "http://localhost:3000",
		"http://10.0.0.1:3000/x/":    "http://10.0.0.1:3000/x",
	}
	for in, want := range cases {
		if got, err := NormalizeURL(in); err != nil || got != want {
			t.Errorf("%s: got %s %v, want %s", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://x", "https://"} {
		if _, err := NormalizeURL(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestLink(t *testing.T) {
	repo := t.TempDir()
	os.Mkdir(filepath.Join(repo, ".git"), 0o755)
	os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("node_modules"), 0o644)
	app := filepath.Join(repo, "app")
	os.MkdirAll(filepath.Join(app, "src"), 0o755)

	l := &Link{URL: "https://x", ProjectID: "p", EnvironmentID: "e", ServiceID: "s", ServiceName: "web"}
	changed, err := WriteLink(app, l)
	if err != nil || !changed {
		t.Fatalf("write: %v %v", changed, err)
	}
	b, _ := os.ReadFile(filepath.Join(app, ".gitignore"))
	if string(b) != ".serve/\n" {
		t.Fatalf(".gitignore: %q", b)
	}
	if changed, _ := WriteLink(app, l); changed {
		t.Fatal(".serve/ should be added only once")
	}
	found := FindLink(filepath.Join(app, "src"))
	if found == nil || found.ServiceID != "s" || found.Dir != app {
		t.Fatalf("find from a subfolder: %+v", found)
	}
	if err := RemoveLink(app); err != nil {
		t.Fatal(err)
	}
	if FindLink(app) != nil {
		t.Fatal("link still found")
	}

	// Outside a git repository .gitignore is left alone.
	plain := t.TempDir()
	if changed, err := WriteLink(plain, l); err != nil || changed {
		t.Fatalf("plain folder: %v %v", changed, err)
	}
	if _, err := os.Stat(filepath.Join(plain, ".gitignore")); err == nil {
		t.Fatal("no .gitignore should be made outside git")
	}
}

func writeHost(t *testing.T, dir, url string) string {
	t.Helper()
	p := filepath.Join(dir, "cli.json")
	b := `{"url":"` + url + `","publicUrl":"https://serve.example.com","token":"srv_host","organization":{"id":"o1","name":"Root"},"user":{"name":"Ada","email":"ada@example.com"}}`
	if err := os.WriteFile(p, []byte(b), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHostLookupOrder(t *testing.T) {
	for _, k := range []string{"SERVE_TOKEN", "SERVE_URL", "SERVE_CONTEXT"} {
		t.Setenv(k, "")
	}
	system := t.TempDir()
	old := SystemHostFile
	SystemHostFile = filepath.Join(system, "cli.json")
	defer func() { SystemHostFile = old }()
	data := t.TempDir()
	t.Setenv("SERVE_DATA_DIR", data)

	if _, state := ReadHost(); state != HostNone {
		t.Fatal("no file anywhere")
	}
	writeHost(t, system, "http://system:8000")
	if h, state := ReadHost(); state != HostReadable || h.URL != "http://system:8000" {
		t.Fatalf("the standard place: %+v", h)
	}
	writeHost(t, data, "http://dev:3000")
	if h, _ := ReadHost(); h.URL != "http://dev:3000" {
		t.Fatalf("SERVE_DATA_DIR comes first: %+v", h)
	}

	// With no saved login, the host file is the "local" context.
	c := &Config{}
	got, err := c.Resolve("", "")
	if err != nil || got.Name != LocalContext || !got.FromHost || got.Token != "srv_host" {
		t.Fatalf("host: %+v %v", got, err)
	}
	if !got.Matches("https://serve.example.com/") {
		t.Fatal("the local context matches its public URL too")
	}
	// A saved current context wins over the file.
	c.Put(Context{Name: "other", URL: "https://other.example.com", Token: "t"})
	c.Current = "other"
	if got, _ := c.Resolve("", ""); got.Name != "other" {
		t.Fatalf("current context should win: %s", got.Name)
	}
	// So does a link to the host's dashboard... and --context local.
	if got, _ := c.Resolve("", "https://serve.example.com"); got.Name != LocalContext {
		t.Fatalf("a link to the host should pick local: %s", got.Name)
	}
	if got, _ := c.Resolve(LocalContext, ""); got.Name != LocalContext || !got.Explicit {
		t.Fatal("--context local")
	}
	// SERVE_TOKEN wins over everything.
	t.Setenv("SERVE_TOKEN", "srv_env")
	t.Setenv("SERVE_URL", "https://ci.example.com")
	if got, _ := c.Resolve(LocalContext, ""); !got.FromEnv {
		t.Fatal("SERVE_TOKEN should win")
	}
	t.Setenv("SERVE_TOKEN", "")
	t.Setenv("SERVE_URL", "")

	// Logged out of local: the file is not used, even as the only choice.
	empty := &Config{}
	empty.SetHostAutoLogin(false)
	if _, err := empty.Resolve("", ""); err != ErrNoLogin {
		t.Fatalf("auto login off: %v", err)
	}
	empty.Current = LocalContext
	empty.SetHostAutoLogin(true)
	if got, _ := empty.Resolve("", ""); got.Name != LocalContext {
		t.Fatal("turned back on")
	}
}

func TestHostUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	for _, k := range []string{"SERVE_TOKEN", "SERVE_URL", "SERVE_CONTEXT"} {
		t.Setenv(k, "")
	}
	data := t.TempDir()
	t.Setenv("SERVE_DATA_DIR", data)
	os.Chmod(writeHost(t, data, "http://x"), 0)
	if _, err := (&Config{}).Resolve("", ""); err != ErrHostUnreadable {
		t.Fatalf("unreadable: %v", err)
	}
	if _, err := HostContext(); err != ErrHostUnreadable {
		t.Fatalf("--local: %v", err)
	}
}
