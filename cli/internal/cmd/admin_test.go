package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/serve-bd/serve/cli/internal/ui"
)

// adminFake mimics the admin routes of the API (src/server/api/routes/infra.ts).
type adminFake struct {
	mu          sync.Mutex
	server      map[string]any // GET /servers/srv2 "server"
	setupPolls  int            // answers "validating" this many times after a validate
	deleteQuery url.Values
	deleted     []string
	posted      map[string]map[string]any
	put         map[string]map[string]any
	certStatus  string
	updateRun   map[string]any
	forbid      string // answer 403 with this message to every write
}

func (f *adminFake) start(t *testing.T) *httptest.Server {
	t.Helper()
	f.posted = map[string]map[string]any{}
	f.put = map[string]map[string]any{}
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		var body map[string]any
		if r.Method != "GET" && r.Method != "DELETE" {
			json.NewDecoder(r.Body).Decode(&body)
			if f.forbid != "" {
				j(w, 403, map[string]any{"error": f.forbid})
				return
			}
		}
		switch r.Method + " " + p {
		case "GET /servers":
			j(w, 200, map[string]any{"servers": []any{
				map[string]any{"id": "local", "name": "main", "isLocal": true, "status": "ready"},
				map[string]any{"id": "srv2", "name": f.server["name"], "isLocal": false, "host": "203.0.113.5", "status": f.server["status"]},
			}})
		case "GET /servers/srv2":
			if f.setupPolls > 0 {
				f.setupPolls--
				s := map[string]any{}
				for k, v := range f.server {
					s[k] = v
				}
				s["status"], s["statusMessage"] = "validating", "Checking Docker"
				j(w, 200, map[string]any{"server": s})
				return
			}
			j(w, 200, map[string]any{"server": f.server})
		case "POST /servers":
			f.posted[p] = body
			f.server["name"] = body["name"]
			j(w, 201, map[string]any{"id": "srv2"})
		case "POST /servers/srv2/validate", "POST /servers/srv2/cleanup", "POST /servers/srv2/reset-host-key":
			f.posted[p] = body
			j(w, 202, map[string]any{"ok": true})
		case "DELETE /servers/srv2":
			f.deleteQuery = r.URL.Query()
			if len(f.server["services"].([]any)) > 0 && f.deleteQuery.Get("services") == "" {
				j(w, 400, map[string]any{"error": "1 service runs on this server. Choose whether to stop them or keep them running."})
				return
			}
			f.deleted = append(f.deleted, p)
			j(w, 200, map[string]any{"ok": true})
		case "PUT /servers/srv2/alerts", "PUT /servers/srv2/proxy/kind":
			f.put[p] = body
			if k, ok := body["kind"].(string); ok {
				f.server["proxyKind"] = k
			}
			j(w, 200, map[string]any{"ok": true})
		case "GET /ssh-keys":
			j(w, 200, map[string]any{"keys": []any{map[string]any{"id": "k1", "name": "deploy", "publicKey": "ssh-ed25519 AAAA deploy", "fingerprint": "SHA256:abc", "createdAt": "2026-01-01T00:00:00.000Z"}}})
		case "POST /ssh-keys":
			f.posted[p] = body
			j(w, 201, map[string]any{"id": "k2", "publicKey": "ssh-ed25519 BBBB new", "fingerprint": "SHA256:def"})
		case "DELETE /ssh-keys/k1":
			j(w, 400, map[string]any{"error": "This key is used by 1 server. Give them another key first."})
		case "GET /cloudflare/accounts":
			j(w, 200, map[string]any{"accounts": []any{map[string]any{"id": "cf1", "name": "main"}}})
		case "GET /certificates":
			j(w, 200, map[string]any{"certificates": []any{map[string]any{"id": "c1", "name": "example.com", "domains": []string{"example.com", "*.example.com"}, "provider": "letsencrypt-cloudflare", "status": f.certStatus, "expiresAt": "2099-01-01T00:00:00.000Z", "autoRenew": true, "createdAt": "2026-01-01T00:00:00.000Z"}}})
		case "POST /certificates":
			f.posted[p] = body
			f.certStatus = "issuing"
			j(w, 202, map[string]any{"id": "c1"})
		case "DELETE /certificates/c1":
			f.deleted = append(f.deleted, p)
			j(w, 200, map[string]any{"ok": true})
		case "POST /certificates/c1/renew":
			f.certStatus = "active"
			j(w, 202, map[string]any{"ok": true})
		case "GET /instance/updates":
			j(w, 200, map[string]any{"version": "0.3.4", "check": map[string]any{"checkedAt": "2026-01-01T00:00:00.000Z", "latest": "0.3.5"}, "run": f.updateRun})
		case "POST /instance/updates/check":
			j(w, 200, map[string]any{"check": map[string]any{"checkedAt": "2026-01-01T00:00:00.000Z", "latest": "0.3.5", "url": "https://example.com/r"}})
		case "POST /instance/updates/install":
			f.posted[p] = body
			f.updateRun = map[string]any{"id": "u1", "state": "success", "from": "0.3.4", "to": "0.3.5", "startedAt": "2026-01-01T00:00:00.000Z", "log": ""}
			j(w, 202, map[string]any{"ok": true})
		case "GET /instance/backups":
			j(w, 200, map[string]any{"backups": []any{map[string]any{"id": "b1", "createdAt": "2026-01-01T00:00:00.000Z", "status": "success", "trigger": "manual", "filename": "serve-b1.tar.gz.enc", "size": 2048, "version": "0.3.4"}}})
		case "POST /instance/backups":
			j(w, 202, map[string]any{"backupId": "b1"})
		default:
			j(w, 404, map[string]any{"error": "No API route " + r.Method + " " + p})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func adminSetup(t *testing.T) *adminFake {
	t.Helper()
	setup(t)
	f := &adminFake{server: map[string]any{
		"id": "srv2", "name": "eu-1", "isLocal": false, "host": "203.0.113.5", "port": 22, "username": "root", "status": "ready",
		"proxyKind": "nginx", "proxyHttpPort": 80, "proxyHttpsPort": 443, "createdAt": "2026-01-01T00:00:00.000Z",
		"services": []any{map[string]any{"id": "s9", "name": "shop", "type": "app", "status": "running"}},
	}, certStatus: "active"}
	srv := f.start(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	old, oldPoll := ui.Interactive, adminPoll
	ui.Interactive, adminPoll = false, time.Millisecond
	t.Cleanup(func() { ui.Interactive, adminPoll = old, oldPoll })
	return f
}

func TestServersShowAndJSON(t *testing.T) {
	adminSetup(t)
	r := execute(t, "servers", "show", "eu-1")
	if r.code != 0 || !strings.Contains(r.out, "root@203.0.113.5") || !strings.Contains(r.out, "nginx (HTTP 80, HTTPS 443)") || !strings.Contains(r.out, "shop") {
		t.Fatalf("show: %+v", r)
	}
	r = execute(t, "servers", "show", "srv2", "--json")
	var v map[string]any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &v) != nil || v["name"] != "eu-1" {
		t.Fatalf("--json: %+v", r)
	}
	if r := execute(t, "servers", "show", "nope"); r.code != 1 || !strings.Contains(r.errout, `no server named "nope"`) {
		t.Fatalf("unknown server: %+v", r)
	}
}

func TestServersAddWaits(t *testing.T) {
	f := adminSetup(t)
	f.server["status"] = "ready"
	f.setupPolls = 2
	r := execute(t, "servers", "add", "--host", "203.0.113.5", "--name", "eu-1", "--wait")
	if r.code != 0 || !strings.Contains(r.errout, "eu-1 is ready") {
		t.Fatalf("add: %+v", r)
	}
	b := f.posted["/servers"]
	if b["privateKeyId"] != "k1" || b["username"] != "root" || b["port"].(float64) != 22 {
		t.Fatalf("body: %v", b)
	}
	if _, ok := f.posted["/servers/srv2/validate"]; !ok {
		t.Fatal("setup was not started")
	}
	// A failed setup says why and what to run.
	f.server["status"], f.server["statusMessage"] = "error", "Docker is not installed."
	r = execute(t, "servers", "validate", "eu-1", "--wait")
	if r.code != 1 || !strings.Contains(r.errout, "--install-docker") {
		t.Fatalf("failed setup: %+v", r)
	}
	if r := execute(t, "servers", "add"); r.code != ExitUsage {
		t.Fatalf("no --host: %+v", r)
	}
}

func TestServersRm(t *testing.T) {
	f := adminSetup(t)
	// Services run there: without a terminal, the choice must be passed.
	if r := execute(t, "servers", "rm", "eu-1", "--yes"); r.code != ExitUsage || !strings.Contains(r.errout, "--stop-services or --keep-services") {
		t.Fatalf("no choice: %+v", r)
	}
	// Without --yes and without a terminal, nothing is deleted.
	if r := execute(t, "servers", "rm", "eu-1", "--stop-services"); r.code != ExitUsage || len(f.deleted) != 0 {
		t.Fatalf("no --yes: %+v", r)
	}
	if r := execute(t, "servers", "rm", "eu-1", "--keep-services", "--delete-data"); r.code != ExitUsage {
		t.Fatalf("conflicting flags: %+v", r)
	}
	r := execute(t, "servers", "rm", "eu-1", "--stop-services", "--delete-data", "--yes")
	if r.code != 0 || f.deleteQuery.Get("services") != "stop" || f.deleteQuery.Get("removeData") != "true" {
		t.Fatalf("stop: %+v %v", r, f.deleteQuery)
	}
	r = execute(t, "servers", "rm", "eu-1", "--keep-services", "--keep-proxy", "--yes")
	if r.code != 0 || f.deleteQuery.Get("services") != "keep" || f.deleteQuery.Get("removeProxy") != "false" || f.deleteQuery.Get("removeTunnels") != "true" {
		t.Fatalf("keep: %+v %v", r, f.deleteQuery)
	}
	if r := execute(t, "servers", "rm", "main", "--yes"); r.code != 1 || !strings.Contains(r.errout, "cannot be removed") {
		t.Fatalf("local: %+v", r)
	}
}

func TestServersAlerts(t *testing.T) {
	f := adminSetup(t)
	// An older dashboard does not send the current alerts: a partial change is refused.
	if r := execute(t, "servers", "alerts", "eu-1", "--cpu", "80"); r.code != ExitUsage || !strings.Contains(r.errout, "--memory") {
		t.Fatalf("partial without current: %+v", r)
	}
	f.server["alerts"] = map[string]any{"enabled": true, "diskWarn": 85, "diskCritical": 95, "memory": 90, "cpu": 90, "cpuMinutes": 10}
	r := execute(t, "servers", "alerts", "eu-1", "--cpu", "80")
	b := f.put["/servers/srv2/alerts"]
	if r.code != 0 || b["cpu"].(float64) != 80 || b["memory"].(float64) != 90 || b["enabled"] != true {
		t.Fatalf("partial: %+v %v", r, b)
	}
	if r := execute(t, "servers", "alerts", "eu-1", "--disk", "99"); r.code != ExitUsage {
		t.Fatalf("disk above critical: %+v", r)
	}
	if r := execute(t, "servers", "alerts", "eu-1"); r.code != 0 || !strings.Contains(r.out, "above 90% for 10 minutes") {
		t.Fatalf("show: %+v", r)
	}
}

func TestServersProxy(t *testing.T) {
	f := adminSetup(t)
	if r := execute(t, "servers", "proxy", "eu-1"); r.code != 0 || !strings.Contains(r.out, "nginx") {
		t.Fatalf("show: %+v", r)
	}
	if r := execute(t, "servers", "proxy", "eu-1", "caddy"); r.code != ExitUsage || f.put["/servers/srv2/proxy/kind"] != nil {
		t.Fatalf("no --yes: %+v", r)
	}
	if r := execute(t, "servers", "proxy", "eu-1", "apache", "--yes"); r.code != ExitUsage {
		t.Fatalf("bad kind: %+v", r)
	}
	r := execute(t, "servers", "proxy", "eu-1", "caddy", "--yes", "--wait")
	if r.code != 0 || f.put["/servers/srv2/proxy/kind"]["kind"] != "caddy" || !strings.Contains(r.errout, "runs caddy") {
		t.Fatalf("switch: %+v", r)
	}
}

func TestAdminForbiddenSaysWhatIsNeeded(t *testing.T) {
	f := adminSetup(t)
	f.forbid = "Only admins of the organization that owns this server, or Root admins, can change it."
	if r := execute(t, "servers", "cleanup", "eu-1"); r.code != 1 || !strings.Contains(r.errout, "This needs an admin of the organization") {
		t.Fatalf("server: %+v", r)
	}
	// The API's own message for a token already names what it needs: kept as it is.
	f.forbid = "This token cannot do this. It needs: admin, with an owner who is an admin of the Root organization."
	if r := execute(t, "instance", "backups", "create"); r.code != 1 || strings.Contains(r.errout, "This needs") || !strings.Contains(r.errout, "It needs: admin") {
		t.Fatalf("instance: %+v", r)
	}
}

func TestSSHKeys(t *testing.T) {
	f := adminSetup(t)
	r := execute(t, "ssh-keys")
	if r.code != 0 || !strings.Contains(r.out, "SHA256:abc") || strings.Contains(r.out, "AAAA") {
		t.Fatalf("ls: %+v", r)
	}
	r = execute(t, "ssh-keys", "add", "laptop")
	if r.code != 0 || strings.TrimSpace(r.out) != "ssh-ed25519 BBBB new" || f.posted["/ssh-keys"]["privateKey"] != nil {
		t.Fatalf("add: %+v", r)
	}
	write(t, ".", map[string]string{"id.pub": "ssh-ed25519 AAAA x", "id": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n"})
	if r := execute(t, "ssh-keys", "add", "laptop", "--file", "id.pub"); r.code != ExitUsage {
		t.Fatalf("public key file: %+v", r)
	}
	if r := execute(t, "ssh-keys", "add", "laptop", "--file", "id"); r.code != 0 || !strings.Contains(f.posted["/ssh-keys"]["privateKey"].(string), "OPENSSH PRIVATE KEY") {
		t.Fatalf("own key: %+v", r)
	}
	if r := execute(t, "ssh-keys", "rm", "deploy"); r.code != ExitUsage {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "ssh-keys", "rm", "deploy", "--yes"); r.code != 1 || !strings.Contains(r.errout, "Give them another key first") {
		t.Fatalf("rm in use: %+v", r)
	}
}

func TestCertificates(t *testing.T) {
	f := adminSetup(t)
	r := execute(t, "certificates")
	if r.code != 0 || !strings.Contains(r.out, "*.example.com") || !strings.Contains(r.out, "2099-01-01") {
		t.Fatalf("ls: %+v", r)
	}
	r = execute(t, "certificates", "request", "example.com", "*.example.com")
	b := f.posted["/certificates"]
	if r.code != 0 || b["provider"] != "letsencrypt-cloudflare" || b["cloudflareAccountId"] != "cf1" {
		t.Fatalf("request: %+v %v", r, b)
	}
	if r := execute(t, "certificates", "renew", "*.example.com", "--wait"); r.code != 0 || !strings.Contains(r.errout, "is active") {
		t.Fatalf("renew by domain: %+v", r)
	}
	if r := execute(t, "certificates", "request", "a.com", "--provider", "nope"); r.code != ExitUsage {
		t.Fatalf("bad provider: %+v", r)
	}
	if r := execute(t, "certificates", "rm", "example.com"); r.code != ExitUsage || len(f.deleted) != 0 {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "certificates", "rm", "example.com", "--yes"); r.code != 0 || len(f.deleted) != 1 {
		t.Fatalf("rm: %+v", r)
	}
	if r := execute(t, "certificates", "auto-renew", "maybe", "c1"); r.code != ExitUsage {
		t.Fatalf("auto-renew word: %+v", r)
	}
}

func TestInstance(t *testing.T) {
	f := adminSetup(t)
	if r := execute(t, "instance", "version"); r.code != 0 || !strings.Contains(r.out, "0.3.5 is out") {
		t.Fatalf("version: %+v", r)
	}
	if r := execute(t, "instance", "update", "--check"); r.code != 0 || f.posted["/instance/updates/install"] != nil || !strings.Contains(r.errout, "0.3.5") {
		t.Fatalf("--check: %+v", r)
	}
	if r := execute(t, "instance", "update"); r.code != ExitUsage || f.posted["/instance/updates/install"] != nil {
		t.Fatalf("update without --yes: %+v", r)
	}
	if r := execute(t, "instance", "update", "--yes", "--wait"); r.code != 0 || !strings.Contains(r.errout, "Serve runs") {
		t.Fatalf("update: %+v", r)
	}
	r := execute(t, "instance", "backups", "--json")
	var v []map[string]any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &v) != nil || len(v) != 1 {
		t.Fatalf("backups --json: %+v", r)
	}
	if r := execute(t, "instance", "backups", "create", "--wait"); r.code != 0 || !strings.Contains(r.errout, "serve-b1.tar.gz.enc") {
		t.Fatalf("backup: %+v", r)
	}
}
