package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// recorder is a small API that notes every request it gets.
type recorder struct {
	mu   sync.Mutex
	hits []string
}

func (rc *recorder) seen() []string {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return append([]string(nil), rc.hits...)
}

func (rc *recorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rc.mu.Lock()
	rc.hits = append(rc.hits, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
	rc.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/api/v1/me" {
		json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"name": "u", "email": "u@x"}, "organization": map[string]any{"id": "o", "name": "O"}, "token": map[string]any{"id": "t1", "name": "cli"}})
		return
	}
	w.Write([]byte("{}"))
}

func TestRedirectsNeverCarryTheToken(t *testing.T) {
	setup(t)
	plain := &recorder{}
	hs := httptest.NewServer(plain)
	defer hs.Close()
	to := hs.URL
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, to+r.URL.Path, http.StatusFound)
	}))
	defer tlsSrv.Close()
	t.Setenv("SERVE_URL", tlsSrv.URL)
	t.Setenv("SERVE_TOKEN", "srv_SECRET")

	// https to http on the same host.
	r := execute(t, "whoami", "--insecure")
	if r.code != 1 || !strings.Contains(r.errout, "without HTTPS") || len(plain.seen()) != 0 {
		t.Fatalf("downgrade: %+v, the http server saw %v", r, plain.seen())
	}

	// To another host, even over http.
	other := &recorder{}
	os2 := httptest.NewServer(other)
	defer os2.Close()
	to = strings.Replace(os2.URL, "127.0.0.1", "localhost", 1)
	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, to+r.URL.Path, http.StatusFound)
	}))
	defer httpSrv.Close()
	t.Setenv("SERVE_URL", httpSrv.URL)
	r = execute(t, "whoami")
	if r.code != 1 || !strings.Contains(r.errout, "another host") || len(other.seen()) != 0 {
		t.Fatalf("other host: %+v, it saw %v", r, other.seen())
	}
}

func TestEnvTokenOnlyGoesToServeURL(t *testing.T) {
	_, _, dir := setup(t)
	linked := &recorder{}
	ls := httptest.NewServer(linked)
	defer ls.Close()
	write(t, dir, map[string]string{".serve/project.json": `{"url":"` + ls.URL + `","serviceId":"s1"}`})
	t.Setenv("SERVE_TOKEN", "srv_CI_SECRET")
	r := execute(t, "whoami")
	if r.code != ExitUsage || !strings.Contains(r.errout, "Set SERVE_URL with SERVE_TOKEN") || len(linked.seen()) != 0 {
		t.Fatalf("%+v, the linked server saw %v", r, linked.seen())
	}
}

func TestTailMustBePositive(t *testing.T) {
	_, srv, _ := setup(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	for _, n := range []string{"-5", "0"} {
		if r := execute(t, "logs", "-s", "web", "--tail", n); r.code != ExitUsage {
			t.Fatalf("--tail %s: %+v", n, r)
		}
	}
	if r := execute(t, "deployments", "-s", "web", "--limit", "-1"); r.code != ExitUsage {
		t.Fatalf("--limit -1: %+v", r)
	}
}

func TestLogoutRevokes(t *testing.T) {
	setup(t)
	rc := &recorder{}
	s := httptest.NewTLSServer(rc)
	defer s.Close()
	cfgFile := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "serve", "config.json")

	// A login made with --insecure is revoked with --insecure too.
	if r := execute(t, "login", s.URL, "--token", "srv_T", "--insecure"); r.code != 0 {
		t.Fatalf("login: %+v", r)
	}
	r := execute(t, "logout")
	if r.code != 0 || !strings.Contains(r.errout, "revoked its token") || !strings.Contains(strings.Join(rc.seen(), "\n"), "DELETE /api/v1/tokens/t1 Bearer srv_T") {
		t.Fatalf("logout: %+v, the server saw %v", r, rc.seen())
	}

	// When the server cannot be reached the login is still removed, and the output says the
	// token was not revoked.
	if r := execute(t, "login", s.URL, "--token", "srv_T", "--insecure"); r.code != 0 {
		t.Fatalf("login: %+v", r)
	}
	url := s.URL
	s.Close()
	r = execute(t, "logout")
	if r.code != 0 || strings.Contains(r.errout, "revoked its token") || !strings.Contains(r.errout, "Could not revoke the token on "+url) {
		t.Fatalf("logout offline: %+v", r)
	}
	if b, _ := os.ReadFile(cfgFile); strings.Contains(string(b), "srv_T") {
		t.Fatalf("the login was not removed: %s", b)
	}
}
