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

	"github.com/serve-bd/serve/cli/internal/config"
)

// coreFake answers the routes of projects, environments, services, templates and containers
// with the shapes of src/server/api/routes, and records what was sent.
type coreFake struct {
	mu    sync.Mutex
	calls []string                  // "METHOD /path"
	body  map[string]map[string]any // the last JSON body per "METHOD /path"
	fail  map[string]string         // "METHOD /path" -> error message (400)
}

func (f *coreFake) sent(key string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.body[key]
}

func (f *coreFake) called(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == key {
			return true
		}
	}
	return false
}

func (f *coreFake) handler() http.Handler {
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	web := map[string]any{"id": "s1", "name": "web", "slug": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1", "serverId": "srv1",
		"source": map[string]any{"type": "image", "image": "nginx"}, "runtime": map[string]any{"replicas": 1}, "maintenance": map[string]any{"enabled": true, "title": "Back soon", "message": "Upgrading", "allow": []string{"10.0.0.1"}}}
	stack := map[string]any{"id": "c1", "name": "stack", "type": "compose", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1", "serverId": "srv1"}
	pg := map[string]any{"id": "db1", "name": "pg", "type": "database", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e2", "serverId": "srv1", "database": map[string]any{"engine": "postgres"}}
	created := map[string]any{"id": "n1", "name": "nginx", "type": "app", "status": "idle", "projectId": "p1", "project": "shop", "environmentId": "e1", "serverId": "srv1",
		"source": map[string]any{"type": "image", "image": "nginx:latest"}, "runtime": map[string]any{"replicas": 1}}
	envs := []any{
		map[string]any{"id": "e1", "projectId": "p1", "name": "production"},
		map[string]any{"id": "e2", "projectId": "p1", "name": "staging"},
	}
	plausible := map[string]any{"id": "plausible", "name": "Plausible", "description": "Simple web analytics", "category": "Analytics", "website": "https://plausible.io",
		"vars": []any{map[string]any{"key": "SECRET_KEY_BASE", "generate": "secret"}, map[string]any{"key": "BASE_URL", "publicUrl": true}, map[string]any{"key": "ADMIN_EMAIL", "label": "Admin email"}}}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		key := r.Method + " " + p
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.calls = append(f.calls, key)
		if f.body == nil {
			f.body = map[string]map[string]any{}
		}
		f.body[key] = body
		msg, failing := f.fail[key]
		f.mu.Unlock()
		if failing {
			j(w, 400, map[string]any{"error": msg})
			return
		}
		switch key {
		case "GET /me":
			j(w, 200, map[string]any{"user": map[string]any{"name": "Ada"}, "organization": map[string]any{"id": "o1", "name": "Acme"}})
		case "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop", "createdAt": "2026-01-01T00:00:00Z"}, map[string]any{"id": "p2", "name": "blog"}}})
		case "POST /projects":
			j(w, 201, map[string]any{"project": map[string]any{"id": "p3", "name": body["name"]}, "environments": []any{map[string]any{"id": "e9", "projectId": "p3", "name": "production"}}})
		case "PATCH /projects/p1":
			j(w, 200, map[string]any{"project": map[string]any{"id": "p1", "name": body["name"]}})
		case "GET /projects/p1":
			j(w, 200, map[string]any{"project": map[string]any{"id": "p1", "name": "shop", "description": "The shop", "environments": envs, "services": []any{web, stack, pg}}})
		case "GET /projects/p1/environments":
			j(w, 200, map[string]any{"environments": envs})
		case "POST /projects/p1/environments":
			j(w, 201, map[string]any{"environment": map[string]any{"id": "e3", "projectId": "p1", "name": body["name"]}})
		case "DELETE /environments/e2":
			j(w, 200, map[string]any{"ok": true})
		case "POST /environments/e1/clone":
			j(w, 201, map[string]any{"environmentId": "e4", "services": []any{map[string]any{"id": "x1", "name": "web"}, map[string]any{"id": "x2", "name": "stack"}}, "variables": 5, "sharedVariables": 1, "domains": 2, "notes": []string{"Custom domains stay with the original."}, "copyingData": false})
		case "POST /environments/e2/deploy":
			j(w, 202, map[string]any{"count": 1})
		case "GET /servers":
			j(w, 200, map[string]any{"servers": []any{map[string]any{"id": "srv1", "name": "local", "status": "ready", "isLocal": true}, map[string]any{"id": "srv2", "name": "worker-2", "status": "ready"}}})
		case "GET /git/credentials":
			j(w, 200, map[string]any{"credentials": []any{map[string]any{"id": "g1", "name": "acme-github", "provider": "github"}}})
		case "GET /services":
			var out []any
			for _, s := range []map[string]any{web, stack, pg} {
				if e := r.URL.Query().Get("environmentId"); e == "" || s["environmentId"] == e {
					out = append(out, s)
				}
			}
			j(w, 200, map[string]any{"services": out})
		case "GET /services/s1":
			j(w, 200, map[string]any{"service": web})
		case "GET /services/c1":
			j(w, 200, map[string]any{"service": stack})
		case "GET /services/db1":
			j(w, 200, map[string]any{"service": pg})
		case "GET /services/n1":
			j(w, 200, map[string]any{"service": created})
		case "POST /services":
			j(w, 201, map[string]any{"id": "n1"})
		case "PATCH /services/s1", "PATCH /services/n1":
			j(w, 200, map[string]any{"service": map[string]any{"id": "s1", "name": orName(str(body["name"]), "web")}})
		case "POST /services/s1/clone":
			j(w, 201, map[string]any{"id": "s9", "name": "web-2", "notes": []string{}, "copyingData": false})
		case "POST /services/s1/move":
			j(w, 200, map[string]any{"deploymentId": "d7"})
		case "POST /services/db1/move":
			j(w, 400, map[string]any{"error": "Moving a database starts it empty on worker-2. Back it up and restore it after the move."})
		case "POST /services/move":
			j(w, 200, map[string]any{"projectId": "p1", "environmentName": "staging", "moved": 1, "warnings": []string{}})
		case "PUT /services/s1/maintenance":
			j(w, 200, map[string]any{"ok": true})
		case "GET /services/c1/compose":
			j(w, 200, map[string]any{"compose": map[string]any{"content": "services:\n  web:\n    image: nginx\n", "writtenAt": "2026-01-01T00:00:00Z"}})
		case "GET /services/c1/containers":
			j(w, 200, map[string]any{"containers": []any{
				map[string]any{"id": "aaaa11112222", "name": "stack-web-1", "image": "nginx", "state": "running", "status": "Up 2 hours", "composeService": "web"},
				map[string]any{"id": "bbbb11112222", "name": "stack-worker-1", "image": "app", "state": "running", "status": "Up 2 hours", "composeService": "worker"},
				map[string]any{"id": "cccc11112222", "name": "stack-worker-2", "image": "app", "state": "running", "status": "Up 2 hours", "composeService": "worker"},
			}})
		case "POST /services/c1/containers/aaaa11112222/restart":
			j(w, 200, map[string]any{"ok": true})
		case "GET /services/n1/deployments":
			j(w, 200, map[string]any{"deployments": []any{map[string]any{"id": "d1", "serviceId": "n1", "status": "queued"}}})
		case "GET /templates":
			j(w, 200, map[string]any{"templates": []any{plausible, map[string]any{"id": "n8n", "name": "n8n", "description": "Workflow automation", "category": "Automation"}}})
		case "GET /templates/plausible":
			t := map[string]any{"compose": "services:\n  plausible:\n    image: plausible\n", "note": "Create the first account right after deploying."}
			for k, v := range plausible {
				t[k] = v
			}
			j(w, 200, map[string]any{"template": t})
		default:
			j(w, 404, map[string]any{"error": "Not found"})
		}
	})
	return mux
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// coreSetup logs in to a coreFake and moves into an empty folder.
func coreSetup(t *testing.T) (*coreFake, string) {
	t.Helper()
	setup(t)
	f := &coreFake{fail: map[string]string{}}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	return f, srv.URL
}

// linkTo links the current folder to the web app (project shop, production).
func linkTo(t *testing.T, url string) {
	t.Helper()
	dir, _ := os.Getwd()
	l := &config.Link{URL: url, ProjectID: "p1", ProjectName: "shop", EnvironmentID: "e1", EnvironmentName: "production", ServiceID: "s1", ServiceName: "web"}
	if _, err := config.WriteLink(dir, l); err != nil {
		t.Fatal(err)
	}
}

func TestProjectsCreateRenameShow(t *testing.T) {
	f, _ := coreSetup(t)
	r := execute(t, "projects", "create", "store", "--description", "New shop")
	if r.code != 0 || !strings.Contains(r.errout, "Created the project store (environment production)") {
		t.Fatalf("create: %+v", r)
	}
	if b := f.sent("POST /projects"); b["name"] != "store" || b["description"] != "New shop" {
		t.Fatalf("create body %v", b)
	}
	if r := execute(t, "projects", "create", "store", "--json"); r.code != 0 || !strings.Contains(r.out, `"environments"`) {
		t.Fatalf("create --json: %+v", r)
	}
	if r := execute(t, "projects", "rename", "shop", "store"); r.code != 0 || f.sent("PATCH /projects/p1")["name"] != "store" {
		t.Fatalf("rename: %+v", r)
	}
	if r := execute(t, "projects", "rename", "nope", "x"); r.code != 1 || !strings.Contains(r.errout, `no project "nope"`) {
		t.Fatalf("rename unknown: %+v", r)
	}
	r = execute(t, "projects", "show", "shop")
	if r.code != 0 || !strings.Contains(r.out, "The shop") || !strings.Contains(r.out, "staging") {
		t.Fatalf("show: %+v", r)
	}
	// production has web and stack, staging has pg.
	for _, line := range strings.Split(r.out, "\n") {
		if strings.HasPrefix(line, "production") && !strings.Contains(line, " 2 ") {
			t.Fatalf("production should count 2 services: %q", line)
		}
	}
	if r := execute(t, "projects", "show", "shop", "--json"); r.code != 0 || !strings.Contains(r.out, `"services"`) {
		t.Fatalf("show --json: %+v", r)
	}
	// Without a link and with two projects, nobody can be asked which one.
	if r := execute(t, "projects", "show"); r.code != ExitUsage || !strings.Contains(r.errout, "--project") {
		t.Fatalf("show without a project: %+v", r)
	}
}

func TestEnvironments(t *testing.T) {
	f, url := coreSetup(t)
	linkTo(t, url)
	r := execute(t, "environments")
	if r.code != 0 || !strings.Contains(r.out, "production (linked)") || !strings.Contains(r.out, "staging") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "envs", "ls", "--json"); r.code != 0 || !strings.Contains(r.out, `"e2"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	if r := execute(t, "envs", "create", "qa"); r.code != 0 || f.sent("POST /projects/p1/environments")["name"] != "qa" {
		t.Fatalf("create: %+v", r)
	}
	r = execute(t, "envs", "clone", "production", "preview", "--no-domains")
	if r.code != 0 || !strings.Contains(r.errout, "2 service(s)") || !strings.Contains(r.errout, "Custom domains stay") {
		t.Fatalf("clone: %+v", r)
	}
	if b := f.sent("POST /environments/e1/clone"); b["name"] != "preview" || b["generatedDomains"] != false {
		t.Fatalf("clone body %v", b)
	}
	if r := execute(t, "envs", "deploy", "staging"); r.code != 0 || !strings.Contains(r.errout, "Queued 1 deployment") {
		t.Fatalf("deploy: %+v", r)
	}
	// Deleting needs --yes without a terminal, and says what goes with it.
	r = execute(t, "envs", "rm", "staging")
	if r.code != ExitUsage || !strings.Contains(r.errout, "--yes") || f.called("DELETE /environments/e2") {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if !strings.Contains(r.errout, "pg") {
		t.Fatalf("rm should name the services that go: %q", r.errout)
	}
	if r := execute(t, "envs", "rm", "staging", "--yes"); r.code != 0 || !f.called("DELETE /environments/e2") {
		t.Fatalf("rm --yes: %+v", r)
	}
	if r := execute(t, "envs", "rm", "nope", "--yes"); r.code != 1 || !strings.Contains(r.errout, "It has: production, staging") {
		t.Fatalf("rm unknown: %+v", r)
	}
	// --project picks another project than the linked one.
	f.fail["GET /projects/p2/environments"] = "Project not found"
	if r := execute(t, "envs", "-p", "blog"); r.code != 1 || !strings.Contains(r.errout, "Project not found") {
		t.Fatalf("api error: %+v", r)
	}
}

func TestServicesCreate(t *testing.T) {
	f, url := coreSetup(t)
	linkTo(t, url)
	r := execute(t, "services", "create", "--image", "nginx:latest", "--port", "80", "--env", "staging", "--server", "worker-2", "--start-command", "nginx -g 'daemon off;'")
	if r.code != 0 || !strings.Contains(r.errout, "Created the image app nginx in shop / staging") {
		t.Fatalf("create: %+v", r)
	}
	b := f.sent("POST /services")
	src, _ := b["source"].(map[string]any)
	if b["type"] != "app" || b["name"] != "nginx" || b["projectId"] != "p1" || b["environmentId"] != "e2" || b["serverId"] != "srv2" || b["port"] != float64(80) || src["image"] != "nginx:latest" || b["deploy"] != false {
		t.Fatalf("create body %v", b)
	}
	if rt, _ := f.sent("PATCH /services/n1")["runtime"].(map[string]any); rt["command"] != "nginx -g 'daemon off;'" {
		t.Fatalf("start command: %v", f.sent("PATCH /services/n1"))
	}

	r = execute(t, "services", "create", "--repo", "git@github.com:acme/api.git", "--branch", "dev", "--git-connection", "acme-github", "--deploy", "--no-wait")
	if r.code != 0 || strings.TrimSpace(r.out) != "d1" {
		t.Fatalf("create --deploy --no-wait prints the deployment: %+v", r)
	}
	b = f.sent("POST /services")
	src, _ = b["source"].(map[string]any)
	if b["name"] != "api" || src["type"] != "git" || src["branch"] != "dev" || src["credentialId"] != "g1" || b["deploy"] != true || b["environmentId"] != "e1" {
		t.Fatalf("git body %v", b)
	}
	if _, ok := b["serverId"]; ok {
		t.Fatalf("without --server and a terminal the dashboard picks the server: %v", b)
	}

	dir, _ := os.Getwd()
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine\n"), 0o644)
	if r := execute(t, "services", "create", "--dockerfile", "Dockerfile", "--name", "worker", "--json"); r.code != 0 || !strings.Contains(r.out, `"n1"`) {
		t.Fatalf("dockerfile --json: %+v", r)
	}
	if src, _ := f.sent("POST /services")["source"].(map[string]any); src["content"] != "FROM alpine\n" {
		t.Fatalf("dockerfile body %v", src)
	}

	for _, args := range [][]string{
		{"services", "create"},
		{"services", "create", "--image", "a", "--upload"},
		{"services", "create", "--upload"},
		{"services", "create", "--upload", "--name", "x", "--deploy"},
		{"services", "create", "--image", "a", "--branch", "x"},
	} {
		if r := execute(t, args...); r.code != ExitUsage {
			t.Fatalf("%v should be a usage error: %+v", args, r)
		}
	}
	if r := execute(t, "services", "create", "--repo", "https://x/y", "--git-connection", "nope"); r.code != 1 || !strings.Contains(r.errout, "acme-github") {
		t.Fatalf("unknown git connection: %+v", r)
	}
	f.fail["POST /services"] = "Enter an image"
	if r := execute(t, "services", "create", "--image", "x"); r.code != 1 || !strings.Contains(r.errout, "Enter an image") {
		t.Fatalf("api error: %+v", r)
	}
}

func TestServicesRenameCloneMoveSet(t *testing.T) {
	f, url := coreSetup(t)
	linkTo(t, url)
	if r := execute(t, "services", "rename", "frontend"); r.code != 0 || f.sent("PATCH /services/s1")["name"] != "frontend" {
		t.Fatalf("rename: %+v", r)
	}
	if l := config.FindLink("."); l == nil || l.ServiceName != "frontend" {
		t.Fatalf("the link should follow the new name: %+v", l)
	}
	if r := execute(t, "services", "rename", "web", "frontend", "--service", "pg"); r.code != ExitUsage {
		t.Fatalf("service named twice: %+v", r)
	}

	r := execute(t, "services", "clone", "--env", "staging")
	if r.code != 0 || !strings.Contains(r.errout, "Cloned web as web-2 in shop / staging") {
		t.Fatalf("clone: %+v", r)
	}
	if b := f.sent("POST /services/s1/clone"); b["environmentId"] != "e2" || b["serverId"] != "srv1" {
		t.Fatalf("clone body %v", b)
	}
	if r := execute(t, "services", "clone", "--env", "shop/staging", "--json"); r.code != 0 || !strings.Contains(r.out, `"web-2"`) {
		t.Fatalf("clone project/env --json: %+v", r)
	}

	if r := execute(t, "services", "move"); r.code != ExitUsage {
		t.Fatalf("move needs a target: %+v", r)
	}
	if r := execute(t, "services", "move", "--server", "worker-2", "--no-wait"); r.code != 0 || strings.TrimSpace(r.out) != "d7" || f.sent("POST /services/s1/move")["serverId"] != "srv2" {
		t.Fatalf("move --server: %+v", r)
	}
	if r := execute(t, "services", "move", "db1", "--server", "worker-2"); r.code != 1 || !strings.Contains(r.errout, "--force") {
		t.Fatalf("a database move needs --force: %+v", r)
	}
	r = execute(t, "services", "move", "--env", "staging")
	if r.code != 0 || !strings.Contains(r.errout, "Moved web to staging") {
		t.Fatalf("move --env: %+v", r)
	}
	if b := f.sent("POST /services/move"); b["environmentId"] != "e2" {
		t.Fatalf("move body %v", b)
	}
	if l := config.FindLink("."); l == nil || l.EnvironmentID != "e2" || l.EnvironmentName != "staging" {
		t.Fatalf("the link should follow the move: %+v", l)
	}
	linkTo(t, url)

	if r := execute(t, "services", "set"); r.code != ExitUsage {
		t.Fatalf("set without a setting: %+v", r)
	}
	r = execute(t, "services", "set", "--port", "8080", "--replicas", "3", "--healthcheck-path", "/health", "--start-command", "", "--auto-deploy=false")
	if r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	b := f.sent("PATCH /services/s1")
	rt, _ := b["runtime"].(map[string]any)
	if rt["port"] != float64(8080) || rt["replicas"] != float64(3) || rt["healthcheckPath"] != "/health" || rt["command"] != nil || b["autoDeploy"] != false {
		t.Fatalf("set body %v", b)
	}
	if _, ok := rt["command"]; !ok {
		t.Fatal("an empty --start-command should clear it")
	}
	if r := execute(t, "services", "set", "stack", "--port", "80"); r.code != 1 || !strings.Contains(r.errout, "compose file") {
		t.Fatalf("set on a stack: %+v", r)
	}
	if r := execute(t, "services", "set", "--replicas", "0"); r.code != ExitUsage {
		t.Fatalf("replicas 0: %+v", r)
	}
}

func TestMaintenanceComposeContainers(t *testing.T) {
	f, url := coreSetup(t)
	linkTo(t, url)
	r := execute(t, "maintenance")
	if r.code != 0 || !strings.Contains(r.out, "on") || !strings.Contains(r.out, "10.0.0.1") {
		t.Fatalf("maintenance: %+v", r)
	}
	if r := execute(t, "maintenance", "--json"); r.code != 0 || !strings.Contains(r.out, `"enabled": true`) {
		t.Fatalf("maintenance --json: %+v", r)
	}
	if r := execute(t, "maintenance", "on", "--message", "Back at 2"); r.code != 0 {
		t.Fatalf("on: %+v", r)
	}
	if b := f.sent("PUT /services/s1/maintenance"); b["enabled"] != true || b["message"] != "Back at 2" || b["title"] != nil {
		t.Fatalf("on body %v", b)
	}
	if r := execute(t, "maintenance", "off"); r.code != 0 || f.sent("PUT /services/s1/maintenance")["enabled"] != false {
		t.Fatalf("off: %+v", r)
	}
	if r := execute(t, "maintenance", "on", "db1"); r.code != 1 || !strings.Contains(r.errout, "database") {
		t.Fatalf("on a database: %+v", r)
	}

	if r := execute(t, "compose", "stack"); r.code != 0 || r.out != "services:\n  web:\n    image: nginx\n" {
		t.Fatalf("compose: %+v", r)
	}
	if r := execute(t, "compose"); r.code != 1 || !strings.Contains(r.errout, "not a compose stack") {
		t.Fatalf("compose on an app: %+v", r)
	}

	r = execute(t, "containers", "-s", "stack")
	if r.code != 0 || !strings.Contains(r.out, "stack-worker-2") {
		t.Fatalf("containers: %+v", r)
	}
	if r := execute(t, "containers", "ls", "-s", "stack", "--json"); r.code != 0 || !strings.Contains(r.out, `"aaaa11112222"`) {
		t.Fatalf("containers --json: %+v", r)
	}
	if r := execute(t, "containers", "restart", "web", "-s", "stack"); r.code != 0 || !f.called("POST /services/c1/containers/aaaa11112222/restart") {
		t.Fatalf("restart by compose service: %+v", r)
	}
	if r := execute(t, "containers", "restart", "worker", "-s", "stack"); r.code != ExitUsage || !strings.Contains(r.errout, "2 containers match") {
		t.Fatalf("ambiguous: %+v", r)
	}
	if r := execute(t, "containers", "restart", "nope", "-s", "stack"); r.code != 1 || !strings.Contains(r.errout, "stack-web-1") {
		t.Fatalf("unknown container: %+v", r)
	}
}

func TestTemplates(t *testing.T) {
	f, url := coreSetup(t)
	r := execute(t, "templates", "analytics")
	if r.code != 0 || !strings.Contains(r.out, "plausible") || strings.Contains(r.out, "n8n") {
		t.Fatalf("search: %+v", r)
	}
	if r := execute(t, "templates", "ls", "--json"); r.code != 0 || !strings.Contains(r.out, `"n8n"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	r = execute(t, "templates", "show", "plausible")
	if r.code != 0 || !strings.Contains(r.out, "SECRET_KEY_BASE") || !strings.Contains(r.out, "the service's URL") || !strings.Contains(r.out, "first account") {
		t.Fatalf("show: %+v", r)
	}
	if r := execute(t, "templates", "show", "plausible", "--compose"); r.code != 0 || !strings.HasPrefix(r.out, "services:") {
		t.Fatalf("show --compose: %+v", r)
	}
	if r := execute(t, "templates", "show", "nope"); r.code != 1 || !strings.Contains(r.errout, `no template "nope"`) {
		t.Fatalf("show unknown: %+v", r)
	}
	if r := execute(t, "templates", "deploy", "plausible", "--set", "NOPE=1", "-p", "shop"); r.code != ExitUsage || !strings.Contains(r.errout, "ADMIN_EMAIL") {
		t.Fatalf("unknown value: %+v", r)
	}

	linkTo(t, url)
	r = execute(t, "templates", "deploy", "plausible", "--name", "stats", "--env", "staging", "--set", "ADMIN_EMAIL=a@b.c", "--no-wait")
	if r.code != 0 || strings.TrimSpace(r.out) != "d1" || !strings.Contains(r.errout, "from the Plausible template in shop / staging") {
		t.Fatalf("deploy: %+v", r)
	}
	b := f.sent("POST /services")
	vars, _ := b["vars"].(map[string]any)
	if b["type"] != "compose" || b["mode"] != "inline" || b["template"] != "plausible" || b["name"] != "stats" || b["environmentId"] != "e2" || b["deploy"] != true || vars["ADMIN_EMAIL"] != "a@b.c" {
		t.Fatalf("deploy body %v", b)
	}
	if _, ok := vars["SECRET_KEY_BASE"]; ok {
		t.Fatal("generated values are left to the server")
	}
}
