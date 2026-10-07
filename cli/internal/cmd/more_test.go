package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/serve-bd/serve/cli/internal/ui"
)

// recFake answers the routes it is given and records every call, with its raw body and query.
// Keys are "METHOD /path", the path as it was sent (still escaped).
type recFake struct {
	mu      sync.Mutex
	routes  map[string]func(body map[string]any, q url.Values) (int, any)
	calls   []string
	bodies  map[string]string
	queries map[string][]url.Values
}

func (f *recFake) on(key string, status int, answer any) {
	f.routes[key] = func(map[string]any, url.Values) (int, any) { return status, answer }
}

func (f *recFake) body(t *testing.T, key string) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, ok := f.bodies[key]
	if !ok {
		t.Fatalf("%s was not called; calls: %v", key, f.calls)
	}
	var m map[string]any
	json.Unmarshal([]byte(raw), &m)
	return m
}

func (f *recFake) called(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == key {
			return true
		}
	}
	return false
}

func (f *recFake) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls, f.bodies, f.queries = nil, map[string]string{}, map[string][]url.Values{}
}

func recSetup(t *testing.T) *recFake {
	t.Helper()
	setup(t)
	old := ui.Interactive
	ui.Interactive = false
	t.Cleanup(func() { ui.Interactive = old })
	f := &recFake{routes: map[string]func(map[string]any, url.Values) (int, any){}}
	f.reset()
	svc := func(id, name, typ string, extra map[string]any) map[string]any {
		m := map[string]any{"id": id, "name": name, "slug": name, "type": typ, "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1"}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	web := svc("s1", "web", "app", map[string]any{"source": map[string]any{"type": "git"}})
	stack := svc("c1", "stack", "compose", nil)
	pg := svc("pg1", "pg", "database", map[string]any{"database": map[string]any{"engine": "postgres", "database": "app", "publicPort": nil, "domain": nil}})
	f.on("GET /services", 200, map[string]any{"services": []any{web, stack, pg}})
	f.on("GET /services/s1", 200, map[string]any{"service": web})
	f.on("GET /services/c1", 200, map[string]any{"service": stack})
	f.on("GET /services/pg1", 200, map[string]any{"service": pg})
	f.on("GET /projects", 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}}})
	f.on("GET /servers", 200, map[string]any{"servers": []any{map[string]any{"id": "srv1", "name": "local", "status": "ready"}, map[string]any{"id": "srv2", "name": "eu", "status": "ready"}}})
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
		raw, _ := io.ReadAll(r.Body)
		key := r.Method + " " + strings.TrimPrefix(r.URL.EscapedPath(), "/api/v1")
		f.mu.Lock()
		f.calls = append(f.calls, key)
		f.bodies[key] = string(raw)
		f.queries[key] = append(f.queries[key], r.URL.Query())
		route := f.routes[key]
		f.mu.Unlock()
		if route == nil {
			j(w, 404, map[string]any{"error": "No API route " + key})
			return
		}
		var body map[string]any
		json.Unmarshal(raw, &body)
		status, answer := route(body, r.URL.Query())
		j(w, status, answer)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	return f
}

func mustRun(t *testing.T, args ...string) run {
	t.Helper()
	r := execute(t, args...)
	if r.code != 0 {
		t.Fatalf("%v: %+v", args, r)
	}
	return r
}

func mustFail(t *testing.T, code int, want string, args ...string) {
	t.Helper()
	r := execute(t, args...)
	if r.code != code || !strings.Contains(r.errout, want) {
		t.Fatalf("%v: want exit %d and %q, got %+v", args, code, want, r)
	}
}

func TestDbReplicasAddAndRm(t *testing.T) {
	f := recSetup(t)
	f.on("GET /services/pg1/database/replicas", 200, map[string]any{"replicas": []any{}})
	r := mustRun(t, "db", "replicas", "pg")
	if !strings.Contains(r.errout, "serve db replicas add <server> -s pg") {
		t.Fatalf("hint: %+v", r)
	}
	f.on("GET /services/pg1/database/replicas", 200, map[string]any{"replicas": []any{map[string]any{"id": "1", "serverId": "srv2", "state": "following"}}})
	f.on("PUT /services/pg1/database/replicas", 200, nil)
	mustRun(t, "db", "replicas", "add", "local", "eu", "-s", "pg")
	b, _ := json.Marshal(f.body(t, "PUT /services/pg1/database/replicas"))
	if string(b) != `{"replicas":[{"id":"1","serverId":"srv2"},{"serverId":"srv1"},{"serverId":"srv2"}]}` {
		t.Fatalf("add body: %s", b)
	}
	mustFail(t, ExitError, `no server named "mars"`, "db", "replicas", "add", "mars", "-s", "pg")

	f.reset()
	mustFail(t, ExitUsage, "--yes", "db", "replicas", "rm", "eu", "-s", "pg")
	if f.called("PUT /services/pg1/database/replicas") {
		t.Fatal("removed without asking")
	}
	mustRun(t, "db", "replicas", "rm", "eu", "-s", "pg", "--yes")
	b, _ = json.Marshal(f.body(t, "PUT /services/pg1/database/replicas"))
	if string(b) != `{"replicas":[]}` {
		t.Fatalf("rm body: %s", b)
	}
	mustFail(t, ExitError, `no replica "9"`, "db", "replicas", "rm", "9", "-s", "pg", "--yes")
}

func TestDbConfigAndApply(t *testing.T) {
	f := recSetup(t)
	f.on("PATCH /services/pg1/database", 200, map[string]any{"restart": true, "changed": []string{"image"}})
	r := mustRun(t, "db", "config", "pg", "--image", "postgis/postgis:17", "--tls", "require", "--charset", "")
	body := f.body(t, "PATCH /services/pg1/database")
	tls, _ := body["tls"].(map[string]any)
	if body["image"] != "postgis/postgis:17" || body["charset"] != "" || tls["mode"] != "require" || tls["enabled"] != true || body["apply"] != nil {
		t.Fatalf("body: %v", body)
	}
	if !strings.Contains(r.errout, "serve db apply -s pg") {
		t.Fatalf("restart hint: %+v", r)
	}
	mustRun(t, "db", "config", "-s", "pg", "--tls", "off", "--auth-method", "", "--apply")
	body = f.body(t, "PATCH /services/pg1/database")
	if v, ok := body["tls"]; !ok || v != nil || body["hostAuthMethod"] != nil || body["apply"] != true {
		t.Fatalf("off body: %v", body)
	}
	dir := t.TempDir()
	conf := filepath.Join(dir, "pg.conf")
	os.WriteFile(conf, []byte("max_connections = 200\n"), 0o600)
	mustRun(t, "db", "config", "-s", "pg", "--custom-config", conf)
	if f.body(t, "PATCH /services/pg1/database")["customConfig"] != "max_connections = 200\n" {
		t.Fatal("custom config not sent")
	}
	mustFail(t, ExitUsage, "pass a setting", "db", "config", "-s", "pg")
	mustFail(t, ExitUsage, "--auth-method", "db", "config", "-s", "pg", "--auth-method", "password")
	mustFail(t, ExitUsage, "--tls", "db", "config", "-s", "pg", "--tls", "on")
	mustFail(t, ExitError, "web is not a database", "db", "config", "-s", "web", "--image", "x")

	f.on("POST /services/pg1/database/apply", 202, map[string]any{"id": "d7"})
	if r := mustRun(t, "db", "apply", "pg"); !strings.Contains(r.errout, "serve logs --build d7 -f") {
		t.Fatalf("apply: %+v", r)
	}
}

func TestDbPublicAndDomain(t *testing.T) {
	f := recSetup(t)
	if r := mustRun(t, "db", "public", "pg"); !strings.Contains(r.out, "pg has no public port") {
		t.Fatalf("show: %+v", r)
	}
	f.on("PATCH /services/pg1", 200, map[string]any{"service": map[string]any{"database": map[string]any{"publicPort": 5433}}})
	f.on("POST /services/pg1/database/apply", 202, map[string]any{"id": "d1"})
	r := mustRun(t, "db", "public", "pg", "on", "--port", "5433", "--allow", "203.0.113.7,10.0.0.0/8")
	b, _ := json.Marshal(f.body(t, "PATCH /services/pg1"))
	if string(b) != `{"database":{"publicAllow":["203.0.113.7","10.0.0.0/8"],"publicBind":"0.0.0.0","publicPort":5433}}` {
		t.Fatalf("on body: %s", b)
	}
	if !f.called("POST /services/pg1/database/apply") || !strings.Contains(r.errout, "Opened public port 5433") {
		t.Fatalf("on: %+v", r)
	}
	mustRun(t, "db", "public", "on", "-s", "pg")
	if b, _ := json.Marshal(f.body(t, "PATCH /services/pg1")); string(b) != `{"database":{"publicBind":"0.0.0.0","publicPort":"auto"}}` {
		t.Fatalf("auto body: %s", b)
	}
	mustFail(t, ExitUsage, "--port and --allow go with on", "db", "public", "pg", "--port", "5433")
	mustFail(t, ExitUsage, "1024 to 65535", "db", "public", "pg", "on", "--port", "80")

	// Open, on a domain: off asks to take the domain off first.
	f.on("GET /services/pg1", 200, map[string]any{"service": map[string]any{"id": "pg1", "name": "pg", "type": "database", "database": map[string]any{"publicPort": 5433, "publicAllow": []string{"203.0.113.7"}, "domain": "db.example.com"}}})
	if r := mustRun(t, "db", "public", "-s", "pg"); !strings.Contains(r.out, "5433") || !strings.Contains(r.out, "203.0.113.7") || !strings.Contains(r.out, "db.example.com") {
		t.Fatalf("show open: %+v", r)
	}
	mustFail(t, ExitError, "serve db domain --remove -s pg", "db", "public", "pg", "off")
	if r := mustRun(t, "db", "domain", "-s", "pg"); strings.TrimSpace(r.out) != "db.example.com" {
		t.Fatalf("domain show: %+v", r)
	}

	f.on("PUT /services/pg1/database/domain", 200, map[string]any{"warnings": []string{"Point db2.example.com at this server's IP with an A record."}, "port": 5433})
	r = mustRun(t, "db", "domain", "db2.example.com", "-s", "pg", "--allow", "10.0.0.0/8")
	if b, _ := json.Marshal(f.body(t, "PUT /services/pg1/database/domain")); string(b) != `{"allow":["10.0.0.0/8"],"hostname":"db2.example.com","via":"direct"}` {
		t.Fatalf("domain body: %s", b)
	}
	if !strings.Contains(r.errout, "(port 5433)") || !strings.Contains(r.errout, "A record") {
		t.Fatalf("domain: %+v", r)
	}
	mustRun(t, "db", "domain", "--remove", "-s", "pg")
	if b, _ := json.Marshal(f.body(t, "PUT /services/pg1/database/domain")); string(b) != `{"hostname":null,"via":"direct"}` {
		t.Fatalf("remove body: %s", b)
	}
	mustFail(t, ExitUsage, "not both", "db", "domain", "x.example.com", "--remove", "-s", "pg")

	// db url --public: no way in says how to open one; a port without the secrets permission says that.
	f.on("GET /services/pg1/connection", 200, map[string]any{"connection": map[string]any{"variables": map[string]any{}, "publicPort": nil, "publicUrl": nil}})
	mustFail(t, ExitError, "serve db public on -s pg", "db", "url", "pg", "--public")
	f.on("GET /services/pg1/connection", 200, map[string]any{"connection": map[string]any{"variables": map[string]any{}, "publicPort": 5433, "publicUrl": nil}})
	mustFail(t, ExitError, "variables.view-secrets", "db", "url", "pg", "--public")
}

func TestEnvPreviewAndReplicaVariables(t *testing.T) {
	f := recSetup(t)
	f.on("PUT /services/s1/preview-variables", 200, map[string]any{"ok": true})
	f.on("PUT /services/s1/replicas/2/variables", 200, map[string]any{"deploymentId": "d5"})
	dir := t.TempDir()
	file := filepath.Join(dir, "p.env")
	os.WriteFile(file, []byte("A=1\nB=two\nA=3\n"), 0o600)

	mustFail(t, ExitUsage, "--yes", "env", "push", file, "--preview", "-s", "web")
	if f.called("PUT /services/s1/preview-variables") {
		t.Fatal("replaced without asking")
	}
	r := mustRun(t, "env", "push", file, "--preview", "-s", "web", "--yes")
	if b, _ := json.Marshal(f.body(t, "PUT /services/s1/preview-variables")); string(b) != `{"variables":[{"key":"A","value":"3"},{"key":"B","value":"two"}]}` {
		t.Fatalf("preview body: %s", b)
	}
	if strings.Contains(r.out+r.errout, "two") {
		t.Fatalf("a value was printed: %+v", r)
	}
	r = mustRun(t, "env", "push", file, "--replica", "2", "--redeploy", "-y", "-s", "web")
	if b, _ := json.Marshal(f.body(t, "PUT /services/s1/replicas/2/variables")); string(b) != `{"redeploy":true,"variables":[{"key":"A","value":"3"},{"key":"B","value":"two"}]}` {
		t.Fatalf("replica body: %s", b)
	}
	if !strings.Contains(r.errout, "serve logs --build d5 -f") {
		t.Fatalf("redeploy hint: %+v", r)
	}
	mustRun(t, "env", "unset", "--preview", "--yes", "-s", "web")
	if b, _ := json.Marshal(f.body(t, "PUT /services/s1/preview-variables")); string(b) != `{"variables":[]}` {
		t.Fatalf("unset body: %s", b)
	}
	mustFail(t, ExitUsage, "all at once", "env", "unset", "A", "--preview", "-s", "web")
	mustFail(t, ExitUsage, "not both", "env", "push", file, "--preview", "--replica", "1", "-s", "web")
	mustFail(t, ExitUsage, "--redeploy does not go with --preview", "env", "push", file, "--preview", "--redeploy", "-s", "web")
	mustFail(t, ExitUsage, "--replica is the number", "env", "push", file, "--replica", "0", "-s", "web")
	mustFail(t, ExitUsage, "--yes goes with", "env", "unset", "A", "--yes", "-s", "web")
	mustFail(t, ExitUsage, "needs at least 1 argument", "env", "unset", "-s", "web")
}

func TestTokensCreate(t *testing.T) {
	f := recSetup(t)
	f.on("GET /permissions", 200, map[string]any{"permissions": []any{map[string]any{"id": "admin"}, map[string]any{"id": "projects.view"}, map[string]any{"id": "services.deploy"}}})
	f.on("POST /tokens", 201, map[string]any{"token": "srv_secret123", "id": "t9", "name": "CI", "granted": []string{"services.deploy"}, "projectIds": []string{"p1"}, "expiresAt": "2099-01-01T00:00:00.000Z"})
	r := mustRun(t, "tokens", "create", "CI", "--access", "services.deploy,projects.view", "--projects", "shop", "--expires", "90")
	if r.out != "srv_secret123\n" || !strings.Contains(r.errout, "only this once") {
		t.Fatalf("create: %+v", r)
	}
	if b, _ := json.Marshal(f.body(t, "POST /tokens")); string(b) != `{"expiresInDays":90,"name":"CI","projectIds":["p1"],"scopes":["services.deploy","projects.view"]}` {
		t.Fatalf("body: %s", b)
	}
	mustRun(t, "tokens", "create", "CI", "--access", "admin", "--no-expiry")
	if b, _ := json.Marshal(f.body(t, "POST /tokens")); string(b) != `{"expiresInDays":null,"name":"CI","scopes":["admin"]}` {
		t.Fatalf("admin body: %s", b)
	}
	r = mustRun(t, "tokens", "create", "CI", "--access", "projects.view", "--json")
	var v map[string]any
	if json.Unmarshal([]byte(r.out), &v) != nil || v["token"] != "srv_secret123" {
		t.Fatalf("json: %+v", r)
	}
	f.reset()
	mustFail(t, ExitUsage, `"deploy" is not a permission`, "tokens", "create", "CI", "--access", "deploy")
	mustFail(t, ExitUsage, "--access", "tokens", "create", "CI")
	mustFail(t, ExitUsage, "admin alone", "tokens", "create", "CI", "--access", "admin,projects.view")
	mustFail(t, ExitUsage, "1 to 3650", "tokens", "create", "CI", "--access", "admin", "--expires", "0")
	mustFail(t, ExitUsage, "not both", "tokens", "create", "CI", "--access", "admin", "--expires", "5", "--no-expiry")
	if f.called("POST /tokens") {
		t.Fatal("a refused token was made")
	}
}

func TestBranchCleanupSQL(t *testing.T) {
	f := recSetup(t)
	f.on("PUT /services/pg1/branches/cleanup-sql", 200, map[string]any{"ok": true})
	mustRun(t, "db", "branches", "cleanup-sql", "UPDATE users SET email = id || '@example.com';", "-s", "pg")
	if f.body(t, "PUT /services/pg1/branches/cleanup-sql")["sql"] != "UPDATE users SET email = id || '@example.com';" {
		t.Fatal("sql not sent")
	}
	mustRun(t, "db", "branches", "cleanup-sql", "--clear", "-s", "pg")
	if b := f.body(t, "PUT /services/pg1/branches/cleanup-sql"); b["sql"] != nil {
		t.Fatalf("clear: %v", b)
	}
	mustFail(t, ExitUsage, "takes no arguments", "db", "branches", "cleanup-sql", "x", "--clear", "-s", "pg")
	mustFail(t, ExitUsage, "needs 1 argument", "db", "branches", "cleanup-sql", "-s", "pg")
	mustFail(t, ExitUsage, "--clear", "db", "branches", "cleanup-sql", " ", "-s", "pg")
}

func TestServerProxyActionsAndTrustedProxies(t *testing.T) {
	f := recSetup(t)
	for _, a := range []string{"reload", "restart", "rebuild", "stop", "start"} {
		f.on("POST /servers/srv2/proxy/"+a, 200, nil)
	}
	mustRun(t, "servers", "proxy-reload", "eu")
	mustRun(t, "servers", "proxy-start", "eu")
	f.reset()
	mustFail(t, ExitUsage, "--yes", "servers", "proxy-stop", "eu")
	if f.called("POST /servers/srv2/proxy/stop") {
		t.Fatal("stopped without asking")
	}
	mustRun(t, "servers", "proxy-stop", "eu", "--yes")
	mustRun(t, "servers", "proxy-restart", "eu", "-y")
	if !f.called("POST /servers/srv2/proxy/stop") || !f.called("POST /servers/srv2/proxy/restart") {
		t.Fatalf("calls: %v", f.calls)
	}

	f.on("POST /servers/srv2/proxy/test", 200, map[string]any{"ok": false, "output": "nginx: [emerg] unknown directive \"x\"", "state": "failed"})
	r := execute(t, "servers", "proxy-test", "eu")
	if r.code != ExitError || !strings.Contains(r.out, "unknown directive") || !strings.Contains(r.errout, "did not pass") {
		t.Fatalf("test failed: %+v", r)
	}
	f.on("POST /servers/srv2/proxy/test", 200, map[string]any{"ok": true, "output": "syntax is ok", "state": "ok"})
	if r := mustRun(t, "servers", "proxy-test", "eu", "--json"); !strings.Contains(r.out, `"ok": true`) {
		t.Fatalf("test json: %+v", r)
	}

	f.on("PUT /servers/srv2/proxy/trusted-proxies", 200, nil)
	mustRun(t, "servers", "trusted-proxies", "eu", "--cloudflare")
	if b, _ := json.Marshal(f.body(t, "PUT /servers/srv2/proxy/trusted-proxies")); string(b) != `{"cloudflare":true,"header":"cf-connecting-ip","machine":false,"ranges":[]}` {
		t.Fatalf("cloudflare body: %s", b)
	}
	mustRun(t, "servers", "trusted-proxies", "eu", "--range", "10.0.0.0/8,192.168.0.0/16", "--range", "203.0.113.7", "--header", "x-real-ip")
	if b, _ := json.Marshal(f.body(t, "PUT /servers/srv2/proxy/trusted-proxies")); string(b) != `{"cloudflare":false,"header":"x-real-ip","machine":false,"ranges":["10.0.0.0/8","192.168.0.0/16","203.0.113.7"]}` {
		t.Fatalf("ranges body: %s", b)
	}
	mustRun(t, "servers", "trusted-proxies", "eu", "--off")
	f.mu.Lock()
	raw := f.bodies["PUT /servers/srv2/proxy/trusted-proxies"]
	f.mu.Unlock()
	if raw != "null" {
		t.Fatalf("off body: %q", raw)
	}
	mustFail(t, ExitUsage, "say which proxies", "servers", "trusted-proxies", "eu")
	mustFail(t, ExitUsage, "--off goes alone", "servers", "trusted-proxies", "eu", "--off", "--cloudflare")
	mustFail(t, ExitUsage, "--header is one of", "servers", "trusted-proxies", "eu", "--machine", "--header", "via")
}

func TestRequestLog(t *testing.T) {
	f := recSetup(t)
	page := 0
	f.routes["GET /services/s1/request-log"] = func(_ map[string]any, q url.Values) (int, any) {
		page++
		req := func(path string, status int) map[string]any {
			return map[string]any{"id": page, "time": "2026-01-01T00:00:00.000Z", "hostname": "web.example.com", "method": "GET", "path": path, "status": status, "durationMs": 12, "ip": "203.0.113.7", "answeredBy": "local"}
		}
		if q.Get("before") == "" {
			return 200, map[string]any{"requests": []any{req("/a", 502), req("/b", 500)}, "next": "cursor1"}
		}
		return 200, map[string]any{"requests": []any{req("/c", 503)}, "next": "cursor2"}
	}
	r := mustRun(t, "requests", "web", "--status", "5xx", "--path", "/a", "--limit", "3", "--since", "1h")
	if !strings.Contains(r.out, "web.example.com/a") || !strings.Contains(r.out, "web.example.com/c") || !strings.Contains(r.out, "502") {
		t.Fatalf("out: %+v", r)
	}
	f.mu.Lock()
	qs := f.queries["GET /services/s1/request-log"]
	f.mu.Unlock()
	if len(qs) != 2 || qs[0].Get("limit") != "3" || qs[0].Get("status") != "5xx" || qs[0].Get("path") != "/a" || qs[0].Get("from") == "" ||
		qs[1].Get("limit") != "1" || qs[1].Get("before") != "cursor1" {
		t.Fatalf("queries: %v", qs)
	}
	r = mustRun(t, "requests", "-s", "web", "--json", "-n", "2")
	var list []map[string]any
	if json.Unmarshal([]byte(r.out), &list) != nil || len(list) != 2 {
		t.Fatalf("json: %+v", r)
	}
	mustFail(t, ExitUsage, "not both", "requests", "-s", "web", "--since", "1h", "--from", "1700000000")
	mustFail(t, ExitUsage, "--limit", "requests", "-s", "web", "--limit", "0")
}

func TestComposeBackups(t *testing.T) {
	f := recSetup(t)
	f.on("GET /services/c1/compose-backups", 200, map[string]any{"backups": map[string]any{
		"db:postgres":    map[string]any{"schedule": "0 3 * * *", "retention": 7, "s3DestinationId": "s3a", "retentionS3": 30, "encrypted": true},
		"volume:uploads": map[string]any{"schedule": nil, "retention": 3},
	}})
	f.on("GET /s3-destinations", 200, map[string]any{"destinations": []any{map[string]any{"id": "s3a", "name": "Backups", "bucket": "acme"}}})
	r := mustRun(t, "compose-backups", "stack")
	if !strings.Contains(r.out, "db:postgres") || !strings.Contains(r.out, "7 (30 in S3)") || !strings.Contains(r.out, "Backups") || !strings.Contains(r.out, "manual") {
		t.Fatalf("ls: %+v", r)
	}
	if r := mustRun(t, "compose-backups", "ls", "-s", "stack", "--json"); !strings.Contains(r.out, `"volume:uploads"`) {
		t.Fatalf("json: %+v", r)
	}

	dirKey := "PUT /services/c1/compose-backups/dir:%2Fsrv%2Fdata"
	f.on(dirKey, 200, map[string]any{"ok": true})
	f.on("PUT /services/c1/compose-backups/db:postgres", 200, map[string]any{"ok": true})
	mustRun(t, "compose-backups", "set", "dir:/srv/data", "-s", "stack", "--schedule", "0 4 * * *", "--retention", "5", "--bucket", "acme", "--local=false", "--timeout", "0")
	if b, _ := json.Marshal(f.body(t, dirKey)); string(b) != `{"local":false,"retention":5,"s3DestinationId":"s3a","schedule":"0 4 * * *","timeoutMinutes":null}` {
		t.Fatalf("dir body: %s", b)
	}
	t.Setenv("SERVE_BACKUP_PASSPHRASE", "long enough phrase")
	mustRun(t, "compose-backups", "set", "db:postgres", "-s", "stack", "--no-schedule", "--encrypt", "--copy-to", "Backups")
	if b, _ := json.Marshal(f.body(t, "PUT /services/c1/compose-backups/db:postgres")); string(b) != `{"copyDestinationIds":["s3a"],"passphrase":"long enough phrase","schedule":null}` {
		t.Fatalf("db body: %s", b)
	}
	mustFail(t, ExitUsage, "is not a backup", "compose-backups", "set", "postgres", "-s", "stack")
	mustFail(t, ExitUsage, "not both", "compose-backups", "set", "db:postgres", "-s", "stack", "--schedule", "x", "--no-schedule")
	mustFail(t, ExitError, "these backups are for compose stacks and apps", "compose-backups", "-s", "pg")

	f.on("DELETE /services/c1/compose-backups/volume:uploads", 200, map[string]any{"ok": true})
	f.reset()
	mustFail(t, ExitUsage, "--yes", "compose-backups", "rm", "volume:uploads", "-s", "stack")
	if f.called("DELETE /services/c1/compose-backups/volume:uploads") {
		t.Fatal("removed without asking")
	}
	mustRun(t, "compose-backups", "rm", "volume:uploads", "-s", "stack", "--yes")
	if !f.called("DELETE /services/c1/compose-backups/volume:uploads") {
		t.Fatalf("calls: %v", f.calls)
	}
}

func TestIncidents(t *testing.T) {
	f := recSetup(t)
	pages := []any{map[string]any{"id": "sp1", "name": "Acme status", "slug": "acme"}}
	f.routes["GET /status-pages"] = func(map[string]any, url.Values) (int, any) { return 200, map[string]any{"statusPages": pages} }
	f.on("GET /status-pages/sp1/components", 200, map[string]any{"components": []any{map[string]any{"id": "cp1", "name": "Checkout"}}})
	f.on("GET /status-pages/sp1/incidents", 200, map[string]any{"incidents": []any{
		map[string]any{"id": "i1", "kind": "incident", "title": "Checkout errors", "impact": "major", "state": "investigating", "createdAt": "2026-01-01T00:00:00.000Z", "updates": []any{}},
		map[string]any{"id": "m1", "kind": "maintenance", "title": "DB upgrade", "impact": "minor", "state": nil, "startsAt": "2099-01-01T00:00:00.000Z", "createdAt": "2026-01-01T00:00:00.000Z", "updates": []any{map[string]any{"state": "scheduled", "body": "", "createdAt": "2026-01-01T00:00:00.000Z"}}},
	}})
	r := mustRun(t, "incidents", "--open")
	if !strings.Contains(r.out, "Checkout errors") || !strings.Contains(r.out, "scheduled") {
		t.Fatalf("ls: %+v", r)
	}
	f.mu.Lock()
	q := f.queries["GET /status-pages/sp1/incidents"][0]
	f.mu.Unlock()
	if q.Get("open") != "true" || q.Get("limit") != "50" {
		t.Fatalf("query: %v", q)
	}

	f.on("POST /status-pages/sp1/incidents", 201, map[string]any{"id": "i2"})
	mustRun(t, "incidents", "create", "Login down", "-m", "Looking into it", "--impact", "critical", "--component", "checkout")
	if b, _ := json.Marshal(f.body(t, "POST /status-pages/sp1/incidents")); string(b) != `{"body":"Looking into it","componentIds":["cp1"],"impact":"critical","kind":"incident","notify":true,"state":"investigating","title":"Login down"}` {
		t.Fatalf("create body: %s", b)
	}
	mustRun(t, "incidents", "create", "DB upgrade", "--maintenance", "--starts", "2026-10-06T22:00:00+02:00", "--ends", "2026-10-06T23:00:00Z", "--impact", "minor", "--no-notify")
	if b, _ := json.Marshal(f.body(t, "POST /status-pages/sp1/incidents")); string(b) != `{"body":"","endsAt":"2026-10-06T23:00:00Z","impact":"minor","kind":"maintenance","notify":false,"startsAt":"2026-10-06T20:00:00Z","title":"DB upgrade"}` {
		t.Fatalf("maintenance body: %s", b)
	}
	mustFail(t, ExitUsage, "--message", "incidents", "create", "X")
	mustFail(t, ExitUsage, "--starts and --ends", "incidents", "create", "X", "--maintenance", "--starts", "2026-10-06T22:00:00Z")
	mustFail(t, ExitUsage, "2026-10-06T22:00:00Z", "incidents", "create", "X", "--maintenance", "--starts", "tomorrow", "--ends", "2026-10-06T22:00:00Z")
	mustFail(t, ExitError, `no component "api"`, "incidents", "create", "X", "-m", "y", "--component", "api")

	f.on("POST /status-pages/sp1/incidents/i1/updates", 201, map[string]any{"id": "i1"})
	mustRun(t, "incidents", "update", "checkout errors", "Fixed", "--state", "resolved")
	if b, _ := json.Marshal(f.body(t, "POST /status-pages/sp1/incidents/i1/updates")); string(b) != `{"body":"Fixed","notify":true,"state":"resolved"}` {
		t.Fatalf("update body: %s", b)
	}
	mustFail(t, ExitUsage, "scheduled, in-progress, completed", "incidents", "update", "m1", "Starting", "--state", "resolved")
	mustFail(t, ExitUsage, "--state", "incidents", "update", "i1", "Fixed")

	f.on("PATCH /status-pages/sp1/incidents/i1", 200, map[string]any{"id": "i1"})
	mustRun(t, "incidents", "edit", "i1", "--impact", "minor", "--postmortem", "")
	if b, _ := json.Marshal(f.body(t, "PATCH /status-pages/sp1/incidents/i1")); string(b) != `{"impact":"minor","postmortem":null}` {
		t.Fatalf("edit body: %s", b)
	}
	mustFail(t, ExitUsage, "say what to change", "incidents", "edit", "i1")

	f.on("DELETE /status-pages/sp1/incidents/i1", 200, map[string]any{"deleted": true})
	mustFail(t, ExitUsage, "--yes", "incidents", "rm", "i1")
	mustRun(t, "incidents", "rm", "i1", "--yes")
	if !f.called("DELETE /status-pages/sp1/incidents/i1") {
		t.Fatal("not deleted")
	}

	pages = append(pages, map[string]any{"id": "sp2", "name": "Internal", "slug": "internal"})
	mustFail(t, ExitUsage, "--page (Acme status, Internal)", "incidents")
	mustRun(t, "incidents", "--page", "acme")
	mustFail(t, ExitError, `no status page "nope"`, "incidents", "--page", "nope")
}
