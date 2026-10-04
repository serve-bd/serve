package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// teamFake mimics the organization and integration routes of /api/v1.
type teamFake struct {
	mu    sync.Mutex
	calls []string                  // "METHOD path?query"
	body  map[string]map[string]any // last body per "METHOD path"
}

func (f *teamFake) server(t *testing.T) *httptest.Server {
	f.body = map[string]map[string]any{}
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		f.mu.Lock()
		call := r.Method + " " + p
		if r.URL.RawQuery != "" {
			call += "?" + r.URL.RawQuery
		}
		f.calls = append(f.calls, call)
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			var m map[string]any
			json.Unmarshal(b, &m)
			f.body[r.Method+" "+p] = m
		}
		f.mu.Unlock()
		ok := map[string]any{"ok": true}
		switch r.Method + " " + p {
		case "GET /me":
			j(w, 200, map[string]any{"token": map[string]any{"id": "tk1", "name": "CLI"}, "user": map[string]any{"id": "u1", "name": "Ada", "email": "ada@example.com"}, "organization": map[string]any{"id": "o1", "name": "Acme"}})
		case "GET /organization":
			j(w, 200, map[string]any{"organization": map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "logo": "https://example.com/logo.png", "root": false, "createdAt": "2026-01-01T00:00:00Z"}})
		case "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}, map[string]any{"id": "p2", "name": "blog"}}})
		case "GET /members":
			j(w, 200, map[string]any{"members": []any{
				map[string]any{"id": "m1", "user": map[string]any{"id": "u1", "name": "Ada", "email": "ada@example.com"}, "roleId": "owner", "role": "Owner", "projectIds": nil, "joinedAt": "2026-01-01T00:00:00Z"},
				map[string]any{"id": "m2", "user": map[string]any{"id": "u2", "name": "Bob", "email": "bob@example.com"}, "roleId": "developer", "role": "Developer", "projectIds": []string{"p1"}, "joinedAt": "2026-01-01T00:00:00Z"},
			}})
		case "GET /roles":
			j(w, 200, map[string]any{"roles": []any{
				map[string]any{"id": "owner", "name": "Owner", "builtin": "owner", "permissions": []string{"projects.view", "logs.view"}},
				map[string]any{"id": "viewer", "name": "Viewer", "builtin": "viewer", "permissions": []string{"projects.view"}},
				map[string]any{"id": "r9", "name": "Deployer", "builtin": nil, "description": "ships", "permissions": []string{"projects.view", "services.deploy"}},
			}})
		case "GET /permissions":
			j(w, 200, map[string]any{"permissions": []any{map[string]any{"id": "projects.view"}, map[string]any{"id": "services.deploy"}, map[string]any{"id": "logs.view"}, map[string]any{"id": "admin"}}})
		case "GET /tokens":
			j(w, 200, map[string]any{"tokens": []any{
				map[string]any{"id": "tk1", "name": "CLI", "prefix": "srv_aaa", "userId": "u1", "granted": []string{"admin"}, "createdAt": "2026-01-01T00:00:00Z"},
				map[string]any{"id": "tk2", "name": "Old CI", "prefix": "srv_bbb", "userId": "u2", "granted": []string{"services.deploy"}, "createdAt": "2026-01-01T00:00:00Z"},
			}})
		case "GET /activity":
			n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			off, _ := strconv.Atoi(r.URL.Query().Get("offset"))
			var list []any
			for i := off; i < off+n && i < 230; i++ {
				list = append(list, map[string]any{"id": strconv.Itoa(i), "action": "x", "message": "event " + strconv.Itoa(i), "user": nil, "createdAt": "2026-01-01T00:00:00Z"})
			}
			j(w, 200, map[string]any{"activity": list})
		case "POST /invitations":
			j(w, 201, map[string]any{"id": "inv1", "added": false, "emailed": false, "emailError": nil})
		case "GET /registries":
			j(w, 200, map[string]any{"registries": []any{map[string]any{"id": "rg1", "name": "ghcr", "kind": "ghcr", "host": "ghcr.io", "username": "ada"}}})
		case "POST /registries/rg1/test":
			j(w, 400, map[string]any{"error": "unauthorized: bad credentials"})
		case "GET /cloudflare/accounts":
			j(w, 200, map[string]any{"accounts": []any{map[string]any{"id": "cf1", "name": "Ada's Account"}}})
		case "GET /cloudflare/accounts/cf1/zones":
			j(w, 200, map[string]any{"zones": []any{map[string]any{"id": "z1", "name": "example.com", "status": "active"}}})
		case "PUT /cloudflare/accounts/cf1/zones/z1/dns":
			j(w, 200, map[string]any{"id": "rec1", "type": "A", "name": "www.example.com", "content": "203.0.113.10"})
		case "GET /git/credentials":
			j(w, 200, map[string]any{"credentials": []any{
				map[string]any{"id": "g1", "name": "GitHub · ada", "provider": "github"},
				map[string]any{"id": "g2", "name": "GitHub · ada", "provider": "github"},
			}})
		case "GET /git/branches":
			j(w, 200, map[string]any{"branches": []string{"main", "dev"}})
		case "GET /notification-channels", "GET /secret-providers", "GET /s3-destinations":
			j(w, 200, map[string]any{"channels": []any{}, "providers": []any{}, "destinations": []any{}})
		default:
			if r.Method == "GET" {
				j(w, 404, map[string]any{"error": "No API route " + call})
				return
			}
			j(w, 200, ok)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *teamFake) called(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == call {
			return true
		}
	}
	return false
}

func (f *teamFake) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func teamSetup(t *testing.T) *teamFake {
	t.Helper()
	setup(t)
	f := &teamFake{}
	srv := f.server(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	old := secretStdin
	t.Cleanup(func() { secretStdin = old })
	return f
}

func TestOrgAndMembers(t *testing.T) {
	f := teamSetup(t)
	if r := execute(t, "org"); r.code != 0 || !strings.Contains(r.out, "Acme") || !strings.Contains(r.out, "acme") {
		t.Fatalf("org: %+v", r)
	}
	// The logo is sent back, so a rename keeps it.
	if r := execute(t, "org", "rename", "Acme Inc"); r.code != 0 || f.body["PATCH /organization"]["logo"] != "https://example.com/logo.png" || f.body["PATCH /organization"]["name"] != "Acme Inc" {
		t.Fatalf("rename: %+v %v", r, f.body["PATCH /organization"])
	}
	if r := execute(t, "org", "rename", "A"); r.code != ExitUsage {
		t.Fatalf("short name: %+v", r)
	}

	r := execute(t, "members")
	if r.code != 0 || !strings.Contains(r.out, "bob@example.com") || !strings.Contains(r.out, "shop") || !strings.Contains(r.out, "all") {
		t.Fatalf("members: %+v", r)
	}
	r = execute(t, "members", "ls", "--json")
	var list []map[string]any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &list) != nil || len(list) != 2 || list[1]["roleId"] != "developer" {
		t.Fatalf("members --json: %+v", r)
	}

	if r := execute(t, "members", "set", "bob@example.com", "--role", "deployer", "--projects", "shop,blog"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	b := f.body["PATCH /members/m2"]
	if b["roleId"] != "r9" || len(b["projectIds"].([]any)) != 2 {
		t.Fatalf("set body: %v", b)
	}
	if r := execute(t, "members", "set", "bob", "--all-projects"); r.code != 0 || f.body["PATCH /members/m2"]["projectIds"] != nil {
		t.Fatalf("all projects: %+v %v", r, f.body["PATCH /members/m2"])
	}
	if r := execute(t, "members", "set", "bob"); r.code != ExitUsage {
		t.Fatalf("nothing to set: %+v", r)
	}
	if r := execute(t, "members", "set", "bob", "--projects", "nope"); r.code != 1 || !strings.Contains(r.errout, `no project "nope"`) {
		t.Fatalf("unknown project: %+v", r)
	}

	// No terminal: removing needs --yes.
	if r := execute(t, "members", "rm", "bob"); r.code != ExitUsage || !strings.Contains(r.errout, "--yes") || f.called("DELETE /members/m2") {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "members", "rm", "bob", "--yes"); r.code != 0 || !f.called("DELETE /members/m2") {
		t.Fatalf("rm: %+v", r)
	}
	if r := execute(t, "members", "rm", "ada@example.com", "--yes"); !strings.Contains(r.errout, "This is you") {
		t.Fatalf("self: %+v", r)
	}
}

func TestInviteRolesTokens(t *testing.T) {
	f := teamSetup(t)
	r := execute(t, "invite", "Carol@Example.com", "--role", "viewer")
	if r.code != 0 || !strings.HasSuffix(strings.TrimSpace(r.out), "/invite/inv1") || f.body["POST /invitations"]["email"] != "carol@example.com" || f.body["POST /invitations"]["roleId"] != "viewer" {
		t.Fatalf("invite: %+v %v", r, f.body["POST /invitations"])
	}
	if r := execute(t, "invite", "nope"); r.code != ExitUsage {
		t.Fatalf("bad email: %+v", r)
	}

	if r := execute(t, "roles"); r.code != 0 || !strings.Contains(r.out, "everything") || !strings.Contains(r.out, "Deployer") {
		t.Fatalf("roles: %+v", r)
	}
	if r := execute(t, "roles", "create", "ops", "--permissions", "projects.view,nope"); r.code != ExitUsage || !strings.Contains(r.errout, `"nope" is not a permission`) {
		t.Fatalf("unknown permission: %+v", r)
	}
	if r := execute(t, "roles", "create", "ops", "--permissions", "projects.view,logs.view"); r.code != 0 || f.body["POST /roles"]["name"] != "ops" {
		t.Fatalf("create: %+v", r)
	}
	// Viewer only takes permissions; --add keeps the others.
	if r := execute(t, "roles", "set", "viewer", "--add", "logs.view"); r.code != 0 {
		t.Fatalf("set viewer: %+v", r)
	}
	if b := f.body["PUT /roles/viewer"]; len(b["permissions"].([]any)) != 2 || b["name"] != nil {
		t.Fatalf("set viewer body: %v", b)
	}
	if r := execute(t, "roles", "set", "viewer", "--name", "x"); r.code != ExitUsage {
		t.Fatalf("rename built-in: %+v", r)
	}
	if r := execute(t, "roles", "set", "owner", "--add", "logs.view"); r.code != 1 || !strings.Contains(r.errout, "cannot be changed") {
		t.Fatalf("owner: %+v", r)
	}
	if r := execute(t, "roles", "set", "deployer", "--remove", "services.deploy", "--description", "reads"); r.code != 0 {
		t.Fatalf("set custom: %+v", r)
	}
	if b := f.body["PUT /roles/r9"]; b["name"] != "Deployer" || b["description"] != "reads" || len(b["permissions"].([]any)) != 1 {
		t.Fatalf("set custom body: %v", b)
	}
	if r := execute(t, "roles", "rm", "deployer", "--yes"); r.code != 0 || !f.called("DELETE /roles/r9") {
		t.Fatalf("rm role: %+v", r)
	}

	r = execute(t, "tokens")
	if r.code != 0 || !strings.Contains(r.out, "(this login)") || !strings.Contains(r.out, "bob@example.com") {
		t.Fatalf("tokens: %+v", r)
	}
	if r := execute(t, "tokens", "rm", "srv_bbb"); r.code != ExitUsage || f.called("DELETE /tokens/tk2") {
		t.Fatalf("tokens rm without --yes: %+v", r)
	}
	if r := execute(t, "tokens", "rm", "srv_bbb…", "--yes"); r.code != 0 || !f.called("DELETE /tokens/tk2") {
		t.Fatalf("tokens rm by prefix: %+v", r)
	}
	if r := execute(t, "tokens", "rm", "CLI", "--yes"); r.code != 0 || !strings.Contains(r.errout, "logged out") || !strings.Contains(r.errout, "serve login") {
		t.Fatalf("tokens rm self: %+v", r)
	}
}

func TestActivityPages(t *testing.T) {
	f := teamSetup(t)
	r := execute(t, "activity", "--limit", "500", "--project", "shop", "--json")
	var list []any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &list) != nil || len(list) != 230 {
		t.Fatalf("activity: %d %s", len(list), r.errout)
	}
	if !f.called("GET /activity?limit=200&offset=0&projectId=p1") || !f.called("GET /activity?limit=200&offset=200&projectId=p1") || f.count("GET /activity") != 2 {
		t.Fatalf("pages: %v", f.calls)
	}
	if r := execute(t, "activity", "-n", "2"); r.code != 0 || !strings.Contains(r.out, "event 1") || strings.Contains(r.out, "event 2") {
		t.Fatalf("activity table: %+v", r)
	}
}

func TestIntegrationSecrets(t *testing.T) {
	f := teamSetup(t)
	secretStdin = strings.NewReader("s3cr3t-token\n")
	r := execute(t, "registries", "add", "mine", "--host", "registry.example.com", "--username", "ci", "--secret-stdin")
	if r.code != 0 || f.body["POST /registries"]["password"] != "s3cr3t-token" || f.body["POST /registries"]["kind"] != "generic" {
		t.Fatalf("registry add: %+v %v", r, f.body["POST /registries"])
	}
	if strings.Contains(r.out+r.errout, "s3cr3t") {
		t.Fatal("the secret was printed")
	}
	if r := execute(t, "registries", "add", "x", "--kind", "ghcr", "--username", "a", "--password", "p", "--secret-stdin"); r.code != ExitUsage {
		t.Fatalf("two sources: %+v", r)
	}
	// Without a terminal and without a source, the flags to use are named.
	if r := execute(t, "registries", "add", "x", "--kind", "ghcr", "--username", "a"); r.code != ExitUsage || !strings.Contains(r.errout, "--secret-stdin") {
		t.Fatalf("no source: %+v", r)
	}
	// An API error comes back as its message.
	if r := execute(t, "registries", "test", "ghcr"); r.code != 1 || !strings.Contains(r.errout, "bad credentials") {
		t.Fatalf("test error: %+v", r)
	}
	if r := execute(t, "registries", "rm", "ghcr"); r.code != ExitUsage {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "registries", "rm", "ghcr", "-y"); r.code != 0 || !f.called("DELETE /registries/rg1") {
		t.Fatalf("rm: %+v", r)
	}

	secretStdin = strings.NewReader("https://hooks.slack.com/services/x")
	if r := execute(t, "notifications", "add", "ops", "--type", "slack", "--secret-stdin"); r.code != 0 {
		t.Fatalf("notifications add: %+v", r)
	}
	b := f.body["POST /notification-channels"]
	if b["config"].(map[string]any)["webhookUrl"] != "https://hooks.slack.com/services/x" || len(b["events"].([]any)) == 0 || b["throttleMinutes"] != float64(0) {
		t.Fatalf("notification body: %v", b)
	}
	for _, e := range b["events"].([]any) {
		if e == "deploy.success" {
			t.Fatal("info events are not on by default")
		}
	}
	if r := execute(t, "notifications", "add", "ops", "--type", "slack", "--events", "deploy.nope"); r.code != ExitUsage {
		t.Fatalf("unknown event: %+v", r)
	}

	secretStdin = strings.NewReader("hvs.token")
	if r := execute(t, "secret-managers", "add", "prod-vault", "--type", "vault", "--set", "url=https://vault.example.com", "--set", "kvVersion=2", "--secret-stdin", "--projects", "shop"); r.code != 0 {
		t.Fatalf("secret manager: %+v", r)
	}
	b = f.body["POST /secret-providers"]
	if b["credentials"].(map[string]any)["token"] != "hvs.token" || b["config"].(map[string]any)["url"] != "https://vault.example.com" || b["config"].(map[string]any)["kvVersion"] != float64(2) {
		t.Fatalf("secret manager body: %v", b)
	}
	if ids := b["access"].(map[string]any)["projectIds"].([]any); len(ids) != 1 || ids[0] != "p1" {
		t.Fatalf("access: %v", b["access"])
	}
}

func TestCloudflareAndGit(t *testing.T) {
	f := teamSetup(t)
	if r := execute(t, "cloudflare", "zones"); r.code != 0 || !strings.Contains(r.out, "example.com") {
		t.Fatalf("zones: %+v", r)
	}
	r := execute(t, "cloudflare", "dns", "set", "https://Example.com/", "a", "www", "203.0.113.10", "--proxied")
	if r.code != 0 || !strings.Contains(r.errout, "rec1") {
		t.Fatalf("dns set: %+v", r)
	}
	if b := f.body["PUT /cloudflare/accounts/cf1/zones/z1/dns"]; b["type"] != "A" || b["proxied"] != true || b["recordId"] != nil || b["ttl"] != nil {
		t.Fatalf("dns body: %v", b)
	}
	if r := execute(t, "cloudflare", "dns", "set", "example.com", "TXT", "x", "y", "--proxied"); r.code != ExitUsage {
		t.Fatalf("proxied TXT: %+v", r)
	}
	if r := execute(t, "cloudflare", "dns", "set", "other.org", "A", "www", "1.2.3.4"); r.code != 1 || !strings.Contains(r.errout, "other.org") {
		t.Fatalf("unknown zone: %+v", r)
	}
	if r := execute(t, "cloudflare", "dns", "rm", "example.com", "rec1"); r.code != ExitUsage {
		t.Fatalf("dns rm without --yes: %+v", r)
	}
	if r := execute(t, "cloudflare", "dns", "rm", "example.com", "rec1", "--yes"); r.code != 0 || !f.called("DELETE /cloudflare/accounts/cf1/zones/z1/dns/rec1") {
		t.Fatalf("dns rm: %+v", r)
	}
	if r := execute(t, "cloudflare", "purge", "example.com"); r.code != 0 || !f.called("POST /cloudflare/accounts/cf1/zones/z1/purge-cache") {
		t.Fatalf("purge: %+v", r)
	}

	// Two connections with one name need the id.
	if r := execute(t, "git", "repos", "GitHub · ada"); r.code != 1 || !strings.Contains(r.errout, "use the id (g1, g2)") {
		t.Fatalf("ambiguous: %+v", r)
	}
	r = execute(t, "git", "branches", "https://github.com/ada/shop", "--connection", "g2", "--json")
	if r.code != 0 || !strings.Contains(r.out, `"dev"`) || !f.called("GET /git/branches?credentialId=g2&repository=https%3A%2F%2Fgithub.com%2Fada%2Fshop") {
		t.Fatalf("branches: %+v %v", r, f.calls)
	}
}
