package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// opsFake mimics the routes of domains, tasks, previews, tags, uptime, shared variables and the
// deploy hook, and records what was sent.
type opsFake struct {
	mu       sync.Mutex
	calls    []string
	bodies   map[string]map[string]any
	domains  []map[string]any
	tasks    []map[string]any
	runs     []map[string]any
	tags     []map[string]any
	shared   map[string][]map[string]any // by path
	dns      map[string]any
	check    map[string]any
	noValues bool
	failTags bool
}

func (f *opsFake) server(t *testing.T) *httptest.Server {
	t.Helper()
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	app := map[string]any{"id": "s1", "name": "web", "slug": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"source": map[string]any{"type": "git"}}
	img := map[string]any{"id": "s3", "name": "img", "slug": "img", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"source": map[string]any{"type": "image"}}
	preview := map[string]any{"id": "pv1", "name": "web-pr-42", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"parentServiceId": "s1", "previewPr": 42}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		key := r.Method + " " + p
		f.calls = append(f.calls, key)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body != nil {
			f.bodies[key] = body
		}
		switch key {
		case "GET /services":
			j(w, 200, map[string]any{"services": []any{app, img, preview}})
		case "GET /services/s1":
			j(w, 200, map[string]any{"service": app})
		case "GET /services/s3":
			j(w, 200, map[string]any{"service": img})
		case "GET /services/pv1":
			j(w, 200, map[string]any{"service": preview})
		case "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}}})
		case "GET /projects/p1/environments":
			j(w, 200, map[string]any{"environments": []any{map[string]any{"id": "e1", "projectId": "p1", "name": "production"}}})

		case "GET /services/s1/domains":
			j(w, 200, map[string]any{"domains": f.domains})
		case "GET /services/pv1/domains":
			j(w, 200, map[string]any{"domains": []any{map[string]any{"id": "dp", "hostname": "pr-42.example.com", "url": "https://pr-42.example.com", "primary": true}}})
		case "POST /services/s1/domains/generate":
			f.domains = append(f.domains, map[string]any{"id": "dm2", "hostname": "web-1.sslip.io", "url": "https://web-1.sslip.io", "generated": true, "https": true})
			j(w, 201, map[string]any{"ok": true})
		case "POST /domains/dm1/check-dns":
			j(w, 200, map[string]any{"dns": f.dns})
		case "POST /domains/dm1/retry-certificate":
			j(w, 200, map[string]any{"ok": true})
		case "PATCH /domains/dm1":
			j(w, 200, map[string]any{"domain": f.domains[0]})

		case "GET /services/s1/tasks":
			j(w, 200, map[string]any{"tasks": f.tasks})
		case "POST /services/s1/tasks":
			j(w, 201, map[string]any{"id": "t2"})
		case "PATCH /tasks/t1":
			j(w, 200, map[string]any{"task": f.tasks[0]})
		case "DELETE /tasks/t1":
			j(w, 200, map[string]any{"ok": true})
		case "POST /tasks/t1/run":
			j(w, 202, map[string]any{"id": "r1"})
		case "GET /tasks/t1/runs":
			j(w, 200, map[string]any{"runs": f.runs})

		case "GET /services/s1/pull-requests":
			j(w, 200, map[string]any{"pullRequests": []any{
				map[string]any{"number": 42, "title": "New header", "branch": "header", "author": "ada", "fork": false, "url": "https://git/pr/42", "previewId": "pv1"},
				map[string]any{"number": 43, "title": "From a fork", "branch": "x", "fork": true, "url": "https://git/pr/43", "previewId": nil},
			}})
		case "POST /services/s1/pull-requests/43/preview":
			j(w, 400, map[string]any{"error": "Pull requests from forks are not deployed: they would run outside code with this app's variables."})
		case "POST /services/s1/pull-requests/42/preview":
			j(w, 200, map[string]any{"previewId": "pv1", "deploymentId": "d9"})
		case "POST /services/s3/previews":
			j(w, 200, map[string]any{"previewId": "pv2", "deploymentId": "d10"})
		case "DELETE /previews/pv1":
			j(w, 200, map[string]any{"ok": true})

		case "GET /tags":
			if f.failTags {
				j(w, 403, map[string]any{"error": "Missing permission: projects.view"})
				return
			}
			j(w, 200, map[string]any{"tags": f.tags})
		case "POST /tags":
			j(w, 201, map[string]any{"id": "tg2"})
		case "DELETE /tags/tg1":
			j(w, 200, map[string]any{"ok": true})
		case "POST /tags/tg1/deploy":
			j(w, 200, map[string]any{"queued": []any{map[string]any{"serviceId": "s1", "deploymentId": "d1"}}, "skipped": []any{map[string]any{"service": "img", "reason": "Deploys are frozen"}}})
		case "PUT /services/s1/tags":
			j(w, 200, nil)

		case "PUT /services/s1/monitor":
			j(w, 200, map[string]any{"ok": true})
		case "POST /services/s1/monitor/check":
			j(w, 200, map[string]any{"result": f.check})

		case "POST /services/s1/webhook-secret":
			j(w, 200, map[string]any{"ok": true, "webhookSecret": "newsecret"})

		case "GET /variables", "GET /projects/p1/variables", "GET /environments/e1/variables":
			vars := f.shared[p]
			if f.noValues {
				var keys []map[string]any
				for _, v := range vars {
					keys = append(keys, map[string]any{"key": v["key"]})
				}
				vars = keys
			}
			j(w, 200, map[string]any{"variables": vars})
		case "PUT /variables", "PUT /projects/p1/variables", "PUT /environments/e1/variables":
			var list []map[string]any
			for _, v := range body["variables"].([]any) {
				list = append(list, v.(map[string]any))
			}
			f.shared[p] = list
			j(w, 200, map[string]any{"ok": true, "redeployed": 2})
		default:
			j(w, 404, map[string]any{"error": "No API route " + key})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func opsSetup(t *testing.T) *opsFake {
	t.Helper()
	setup(t)
	f := &opsFake{
		bodies:  map[string]map[string]any{},
		domains: []map[string]any{{"id": "dm1", "hostname": "shop.example.com", "url": "https://shop.example.com", "https": true, "primary": true}},
		tasks:   []map[string]any{{"id": "t1", "serviceId": "s1", "name": "cleanup", "schedule": "0 3 * * *", "command": "npm run cleanup", "enabled": false, "timeoutSeconds": 3600}},
		tags:    []map[string]any{{"id": "tg1", "name": "prod", "color": "red", "serviceIds": []string{"s1"}}},
		shared: map[string][]map[string]any{
			"/variables":             {{"key": "ORG", "value": "o"}},
			"/projects/p1/variables": {{"key": "A", "value": "secret-a"}, {"key": "B", "value": "b"}},
		},
	}
	srv := f.server(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	return f
}

func (f *opsFake) body(key string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[key]
}

func (f *opsFake) called(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == key {
			return true
		}
	}
	return false
}

func TestDomainsMore(t *testing.T) {
	f := opsSetup(t)
	if r := execute(t, "domains", "generate", "-s", "s1"); r.code != 0 || !strings.Contains(r.errout, "web-1.sslip.io") {
		t.Fatalf("generate: %+v", r)
	}
	f.dns = map[string]any{"status": "ok", "records": []string{"203.0.113.5"}}
	if r := execute(t, "domains", "check", "https://shop.example.com/", "-s", "s1"); r.code != 0 || !strings.Contains(r.errout, "203.0.113.5") {
		t.Fatalf("check ok: %+v", r)
	}
	f.dns = map[string]any{"status": "wrong", "records": []string{"198.51.100.1"}}
	if r := execute(t, "domains", "check", "shop.example.com", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "198.51.100.1") {
		t.Fatalf("check wrong exits 1: %+v", r)
	}
	if r := execute(t, "domains", "check", "shop.example.com", "-s", "s1", "--json"); !strings.Contains(r.out, `"wrong"`) {
		t.Fatalf("check --json: %+v", r)
	}
	if r := execute(t, "domains", "check", "nope.example.com", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "It has: shop.example.com") {
		t.Fatalf("unknown domain: %+v", r)
	}
	if r := execute(t, "domains", "retry-cert", "shop.example.com", "-s", "s1"); r.code != 0 || !f.called("POST /domains/dm1/retry-certificate") {
		t.Fatalf("retry-cert: %+v", r)
	}
	if r := execute(t, "domains", "set", "shop.example.com", "-s", "s1"); r.code != ExitUsage {
		t.Fatalf("set without flags: %+v", r)
	}
	if r := execute(t, "domains", "set", "shop.example.com", "-s", "s1", "--redirect", "https://x.example.com", "--port", "0", "--primary", "--https=false"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	b := f.body("PATCH /domains/dm1")
	if b["redirectTo"] != "https://x.example.com" || b["port"] != nil || b["primary"] != true || b["https"] != false {
		t.Fatalf("set body: %v", b)
	}
	if _, ok := b["port"]; !ok {
		t.Fatalf("--port 0 must send null: %v", b)
	}
	if _, ok := b["forceHttps"]; ok {
		t.Fatalf("flags not passed must not be sent: %v", b)
	}
}

func TestTasks(t *testing.T) {
	f := opsSetup(t)
	TaskPoll = time.Millisecond
	r := execute(t, "tasks", "-s", "s1")
	if r.code != 0 || !strings.Contains(r.out, "cleanup") || !strings.Contains(r.out, "0 3 * * *") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "tasks", "ls", "-s", "s1", "--json"); !strings.Contains(r.out, `"t1"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	if r := execute(t, "tasks", "create", "report", "-s", "s1", "--schedule", "0 3 * *"); r.code != ExitUsage {
		t.Fatalf("a short cron is a usage error: %+v", r)
	}
	if r := execute(t, "tasks", "create", "report", "-s", "s1", "--schedule", "*/15 * * * *", "--timeout", "30m", "--", "node", "report.js"); r.code != 0 {
		t.Fatalf("create: %+v", r)
	}
	if b := f.body("POST /services/s1/tasks"); b["command"] != "node report.js" || b["timeoutSeconds"] != float64(1800) || b["name"] != "report" {
		t.Fatalf("create body: %v", b)
	}
	// Changing a task that is off keeps it off.
	if r := execute(t, "tasks", "set", "cleanup", "-s", "s1", "--schedule", "30 4 * * *"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if b := f.body("PATCH /tasks/t1"); b["enabled"] != false || b["schedule"] != "30 4 * * *" {
		t.Fatalf("set body: %v", b)
	}
	if r := execute(t, "tasks", "set", "cleanup", "-s", "s1", "--enable"); r.code != 0 || !strings.Contains(r.errout, "on") {
		t.Fatalf("enable: %+v", r)
	}
	f.runs = []map[string]any{{"id": "r1", "trigger": "manual", "status": "failed", "exitCode": 2, "output": "boom\n", "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:00:05Z"}}
	if r := execute(t, "tasks", "run", "cleanup", "-s", "s1", "--wait"); r.code != 1 || !strings.Contains(r.out, "boom") || !strings.Contains(r.errout, "exit code 2") {
		t.Fatalf("run --wait: %+v", r)
	}
	if r := execute(t, "tasks", "runs", "cleanup", "-s", "s1"); !strings.Contains(r.out, "5s") || !strings.Contains(r.out, "failed") {
		t.Fatalf("runs: %+v", r)
	}
	if r := execute(t, "tasks", "runs", "cleanup", "-s", "s1", "--last"); strings.TrimSpace(r.out) != "boom" {
		t.Fatalf("runs --last: %+v", r)
	}
	if r := execute(t, "tasks", "rm", "cleanup", "-s", "s1"); r.code != ExitUsage || f.called("DELETE /tasks/t1") {
		t.Fatalf("rm without a terminal needs --yes: %+v", r)
	}
	if r := execute(t, "tasks", "rm", "cleanup", "-s", "s1", "--yes"); r.code != 0 || !f.called("DELETE /tasks/t1") {
		t.Fatalf("rm --yes: %+v", r)
	}
	if r := execute(t, "tasks", "run", "nightly", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "no task") {
		t.Fatalf("unknown task: %+v", r)
	}
}

func TestPreviews(t *testing.T) {
	f := opsSetup(t)
	r := execute(t, "previews", "-s", "s1")
	if r.code != 0 || !strings.Contains(r.out, "#42") || !strings.Contains(r.out, "https://pr-42.example.com") || !strings.Contains(r.out, "fork") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "previews", "-s", "s1", "--json"); !strings.Contains(r.out, `"previewId": "pv1"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	if r := execute(t, "previews", "deploy", "#43", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "forks") {
		t.Fatalf("fork refused: %+v", r)
	}
	if r := execute(t, "previews", "deploy", "42", "-s", "s1"); r.code != 0 || !strings.Contains(r.errout, "serve logs --build d9") {
		t.Fatalf("deploy: %+v", r)
	}
	if r := execute(t, "previews", "deploy", "7", "-s", "s3"); r.code != ExitUsage || !strings.Contains(r.errout, "--tag") {
		t.Fatalf("image app needs --tag: %+v", r)
	}
	if r := execute(t, "previews", "deploy", "7", "-s", "s3", "--tag", "pr-7"); r.code != 0 || f.body("POST /services/s3/previews")["tag"] != "pr-7" {
		t.Fatalf("image deploy: %+v", r)
	}
	if r := execute(t, "previews", "rm", "42", "-s", "s1"); r.code != ExitUsage {
		t.Fatalf("rm needs --yes: %+v", r)
	}
	if r := execute(t, "previews", "rm", "42", "-s", "s1", "-y"); r.code != 0 || !f.called("DELETE /previews/pv1") {
		t.Fatalf("rm: %+v", r)
	}
	if r := execute(t, "previews", "rm", "99", "-s", "s1", "-y"); r.code != 1 || !strings.Contains(r.errout, "#99") {
		t.Fatalf("rm unknown: %+v", r)
	}
}

func TestTags(t *testing.T) {
	f := opsSetup(t)
	if r := execute(t, "tags"); r.code != 0 || !strings.Contains(r.out, "prod") || !strings.Contains(r.out, "web") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "tags", "--json"); !strings.Contains(r.out, `"tg1"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	if r := execute(t, "tags", "set", "prod,api", "api", "-s", "s1"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	if b := f.body("PUT /services/s1/tags"); len(b["tags"].([]any)) != 2 {
		t.Fatalf("set body: %v", b)
	}
	if r := execute(t, "tags", "set", "-s", "s1"); r.code != ExitUsage {
		t.Fatalf("set without tags: %+v", r)
	}
	if r := execute(t, "tags", "set", "--none", "-s", "s1"); r.code != 0 || len(f.body("PUT /services/s1/tags")["tags"].([]any)) != 0 {
		t.Fatalf("set --none: %+v", r)
	}
	if r := execute(t, "tags", "create", "qa", "--color", "pink"); r.code != ExitUsage {
		t.Fatalf("bad color: %+v", r)
	}
	if r := execute(t, "tags", "create", "qa", "--color", "blue"); r.code != 0 {
		t.Fatalf("create: %+v", r)
	}
	if r := execute(t, "tags", "deploy", "PROD"); r.code != 0 || !strings.Contains(r.errout, "Deploying 1") || !strings.Contains(r.errout, "frozen") {
		t.Fatalf("deploy: %+v", r)
	}
	if r := execute(t, "tags", "rm", "prod"); r.code != ExitUsage {
		t.Fatalf("rm needs --yes: %+v", r)
	}
	if r := execute(t, "tags", "rm", "prod", "--yes"); r.code != 0 || !f.called("DELETE /tags/tg1") {
		t.Fatalf("rm: %+v", r)
	}
	f.failTags = true
	if r := execute(t, "tags"); r.code != 1 || !strings.Contains(r.errout, "Missing permission") {
		t.Fatalf("API error: %+v", r)
	}
}

func TestUptime(t *testing.T) {
	f := opsSetup(t)
	if r := execute(t, "uptime", "set", "/health", "-s", "s1", "--interval", "5m", "--keyword", "ok"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	b := f.body("PUT /services/s1/monitor")
	if b["path"] != "/health" || b["intervalSeconds"] != float64(300) || b["enabled"] != true || b["kind"] != "http" || b["timeoutMs"] != float64(10000) || b["keyword"] != "ok" {
		t.Fatalf("set body: %v", b)
	}
	if r := execute(t, "uptime", "set", "/health", "-s", "s1", "--interval", "45s"); r.code != ExitUsage {
		t.Fatalf("bad interval: %+v", r)
	}
	if r := execute(t, "uptime", "set", "health", "-s", "s1"); r.code != ExitUsage {
		t.Fatalf("not a path: %+v", r)
	}
	if r := execute(t, "uptime", "set", "--off", "-s", "s1"); r.code != 0 || f.body("PUT /services/s1/monitor")["enabled"] != false {
		t.Fatalf("off: %+v", r)
	}
	f.check = map[string]any{"ok": true, "latencyMs": 42, "statusCode": 200, "error": nil}
	if r := execute(t, "uptime", "check", "-s", "s1"); r.code != 0 || !strings.Contains(r.errout, "42 ms") {
		t.Fatalf("check up: %+v", r)
	}
	f.check = map[string]any{"ok": false, "latencyMs": nil, "statusCode": 502, "error": "Status 502"}
	if r := execute(t, "uptime", "check", "-s", "s1"); r.code != 1 || !strings.Contains(r.errout, "down") {
		t.Fatalf("check down: %+v", r)
	}
	if r := execute(t, "uptime", "check", "-s", "s1", "--json"); r.code != 1 || !strings.Contains(r.out, `"statusCode": 502`) {
		t.Fatalf("check --json: %+v", r)
	}
}

func TestWebhookRotate(t *testing.T) {
	f := opsSetup(t)
	if r := execute(t, "webhook", "rotate", "-s", "s1"); r.code != ExitUsage || f.called("POST /services/s1/webhook-secret") {
		t.Fatalf("rotate needs --yes without a terminal: %+v", r)
	}
	r := execute(t, "webhook", "rotate", "-s", "s1", "--yes")
	if r.code != 0 || !strings.Contains(r.out, "/api/deploy-hooks/s1?token=newsecret") {
		t.Fatalf("rotate: %+v", r)
	}
}

func TestSharedVars(t *testing.T) {
	f := opsSetup(t)
	r := execute(t, "vars", "-p", "shop", "--env", "production")
	if r.code != 0 || !strings.Contains(r.out, "ORG") || !strings.Contains(r.out, "${{project.A}}") || strings.Contains(r.out, "secret-a") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "vars", "ls", "--scope", "project", "-p", "shop", "--reveal"); !strings.Contains(r.out, "secret-a") || strings.Contains(r.out, "ORG") {
		t.Fatalf("ls --reveal: %+v", r)
	}
	if r := execute(t, "vars", "ls", "--scope", "project", "-p", "shop", "--json"); strings.Contains(r.out, "secret-a") || !strings.Contains(r.out, `"A"`) {
		t.Fatalf("--json hides values: %+v", r)
	}
	if r := execute(t, "vars", "set", "C=3", "-p", "shop"); r.code != ExitUsage {
		t.Fatalf("set needs --scope: %+v", r)
	}
	if r := execute(t, "vars", "set", "C=3", "A=new", "--scope", "project", "-p", "shop"); r.code != 0 {
		t.Fatalf("set: %+v", r)
	}
	got := map[string]any{}
	for _, v := range f.shared["/projects/p1/variables"] {
		got[v["key"].(string)] = v["value"]
	}
	if got["A"] != "new" || got["B"] != "b" || got["C"] != "3" {
		t.Fatalf("set keeps the others: %v", got)
	}
	if r := execute(t, "vars", "unset", "B", "NOPE", "--scope", "project", "-p", "shop"); r.code != 0 || !strings.Contains(r.errout, "NOPE") {
		t.Fatalf("unset: %+v", r)
	}
	if len(f.shared["/projects/p1/variables"]) != 2 {
		t.Fatalf("unset left: %v", f.shared)
	}
	if r := execute(t, "vars", "set", "X=1", "--scope", "env", "-p", "shop", "--env", "production", "--redeploy"); r.code != 0 || f.body("PUT /environments/e1/variables")["redeploy"] != true {
		t.Fatalf("env set --redeploy: %+v", r)
	}
	if r := execute(t, "vars", "set", "X=1", "--scope", "project", "-p", "shop", "--redeploy"); r.code != ExitUsage {
		t.Fatalf("--redeploy is for environments: %+v", r)
	}
	// Without the values, a write would drop the others: refused.
	f.noValues = true
	before := len(f.shared["/projects/p1/variables"])
	if r := execute(t, "vars", "set", "Y=1", "--scope", "project", "-p", "shop"); r.code != 1 || !strings.Contains(r.errout, "view-secrets") || len(f.shared["/projects/p1/variables"]) != before {
		t.Fatalf("no values: %+v", r)
	}
	if r := execute(t, "env", "--help"); strings.Contains(r.out, "vars,") {
		t.Fatalf("env must not keep the vars alias: %s", r.out)
	}
}
