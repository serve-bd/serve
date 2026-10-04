package cmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/serve-bd/serve/cli/internal/api"
)

// gapsFake mimics the routes of approve, exec, ssh, tailscale, tunnels, networks and log drains
// (src/server/api/routes/projects.ts, console.ts, networking.ts, log-drains.ts).
type gapsFake struct {
	mu        sync.Mutex
	calls     []string
	bodies    map[string]map[string]any
	forbid    map[string]string // path -> 403 message
	waiting   int               // waiting deployments of s1
	exitCode  int
	moveNeed  bool
	shellExit int
}

func (f *gapsFake) start(t *testing.T) *httptest.Server {
	t.Helper()
	f.bodies = map[string]map[string]any{}
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	service := map[string]any{"id": "s1", "name": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		f.mu.Lock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		key := r.Method + " " + p
		f.calls = append(f.calls, key)
		var body map[string]any
		if r.Method == "POST" || r.Method == "PUT" {
			json.NewDecoder(r.Body).Decode(&body)
			f.bodies[key] = body
		}
		if msg, ok := f.forbid[p]; ok {
			f.mu.Unlock()
			j(w, 403, map[string]any{"error": msg})
			return
		}
		f.mu.Unlock()
		switch {
		case key == "GET /services":
			j(w, 200, map[string]any{"services": []any{service}})
		case key == "GET /services/s1":
			j(w, 200, map[string]any{"service": service})
		case key == "GET /services/s1/deployments":
			var list []any
			for i := 0; i < f.waiting; i++ {
				list = append(list, map[string]any{"id": fmt.Sprintf("d%d", i+1), "serviceId": "s1", "status": "waiting", "trigger": "webhook", "createdAt": "2026-10-01T00:00:00Z"})
			}
			list = append(list, map[string]any{"id": "d0", "serviceId": "s1", "status": "success", "trigger": "webhook", "createdAt": "2026-09-01T00:00:00Z"})
			j(w, 200, map[string]any{"deployments": list})
		case key == "POST /deployments/d1/approve":
			j(w, 200, map[string]any{"deployment": map[string]any{"id": "d1", "serviceId": "s1", "status": "queued"}})
		case key == "POST /deployments/d1/reject":
			j(w, 200, map[string]any{"deployment": map[string]any{"id": "d1", "serviceId": "s1", "status": "cancelled"}})
		case key == "POST /services/s1/exec":
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprintf(w, "line 1\nline 2\n\n\x00%d", f.exitCode)
		case key == "GET /servers":
			j(w, 200, map[string]any{"servers": []any{
				map[string]any{"id": "srv1", "name": "web-1", "status": "ready"},
				map[string]any{"id": "srv2", "name": "db-1", "status": "ready"},
			}})
		case key == "POST /servers/srv1/terminal":
			j(w, 201, map[string]any{"id": "t1", "server": "web-1"})
		case key == "GET /servers/srv1/terminal/t1":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, ": ping\n\nid: 1\ndata: %s\n\nevent: exit\ndata: {\"code\": %d}\n\n", base64.StdEncoding.EncodeToString([]byte("up 3 days\r\n")), f.shellExit)
		case key == "DELETE /servers/srv1/terminal/t1":
			w.WriteHeader(204)
		case key == "GET /tailscale/tailnets":
			j(w, 200, map[string]any{"tailnets": []any{map[string]any{"id": "tn1", "name": "corp", "tailnet": "-", "servers": []any{map[string]any{"id": "srv1", "name": "web-1", "address": "100.64.0.2", "online": true}}}}})
		case key == "POST /servers/srv1/tailscale/connect":
			if f.moveNeed && body["force"] != true {
				j(w, 200, map[string]any{"address": nil, "moveNeeded": true, "message": "web-1 is already in another tailnet."})
				return
			}
			j(w, 200, map[string]any{"address": "100.64.0.2", "moveNeeded": false})
		case key == "POST /servers/srv1/tailscale/join-command":
			j(w, 200, map[string]any{"command": "curl -fsSL https://serve.example.com/api/servers/join/tailscale/abc | sh", "expiresAt": "2026-10-06T00:00:00Z"})
		case key == "GET /cloudflare/accounts":
			j(w, 200, map[string]any{"accounts": []any{map[string]any{"id": "cf1", "name": "Mine"}}})
		case key == "GET /cloudflare/accounts/cf1/tunnels":
			j(w, 200, map[string]any{"tunnels": []any{map[string]any{"id": "tun1", "accountId": "cf1", "serverId": "srv1", "serverName": "web-1", "name": "serve-web-1", "status": "healthy",
				"domains": []any{map[string]any{"hostname": "app.example.com", "serviceId": "s1", "serviceName": "web"}}, "otherDomains": 0}}})
		case key == "POST /cloudflare/accounts/cf1/tunnels":
			j(w, 201, map[string]any{"tunnel": map[string]any{"id": "tun2", "name": "serve-db-1", "status": "pending"}, "reconnected": []string{"db.example.com"}, "failed": []any{}})
		case key == "DELETE /cloudflare/accounts/cf1/tunnels/tun1":
			j(w, 200, map[string]any{"ok": true})
		case key == "GET /private-networks":
			j(w, 200, map[string]any{
				"networks": []any{map[string]any{"id": "n1", "name": "backend", "servers": []any{map[string]any{"id": "srv1", "name": "web-1", "joined": true}}}},
				"servers":  []any{map[string]any{"id": "srv1", "name": "web-1", "joined": true}, map[string]any{"id": "srv2", "name": "db-1", "joined": false}, map[string]any{"id": "srv3", "name": "cache-1", "joined": true}},
			})
		case key == "POST /private-networks", key == "PUT /private-networks/n1/members", key == "DELETE /private-networks/n1":
			j(w, 200, map[string]any{"ok": true})
		case key == "GET /log-drains":
			j(w, 200, map[string]any{"drains": []any{map[string]any{"id": "ld1", "name": "axiom", "kind": "http", "url": "https://api.axiom.co/ingest", "enabled": true, "headerName": "Authorization", "hasSecret": true, "projectIds": []string{"p1"}}}})
		case key == "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}}})
		case key == "POST /log-drains":
			j(w, 201, map[string]any{"id": "ld2"})
		case key == "POST /log-drains/ld1/test":
			j(w, 400, map[string]any{"error": "api.axiom.co answered 401: invalid token"})
		case key == "DELETE /log-drains/ld1":
			j(w, 200, map[string]any{"ok": true})
		default:
			j(w, 404, map[string]any{"error": "No API route " + key})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *gapsFake) called(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == key {
			return true
		}
	}
	return false
}

func gapsSetup(t *testing.T) *gapsFake {
	t.Helper()
	setup(t)
	f := &gapsFake{forbid: map[string]string{}}
	srv := f.start(t)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	return f
}

func TestApproveAndReject(t *testing.T) {
	f := gapsSetup(t)
	f.waiting = 1
	r := execute(t, "approve", "-s", "web")
	if r.code != 0 || !strings.Contains(r.errout, "Approved the deployment d1 of web") || !f.called("POST /deployments/d1/approve") {
		t.Fatalf("approve: %+v", r)
	}
	r = execute(t, "reject", "-s", "web", "--reason", "Not on Friday", "--json")
	if r.code != 0 || !strings.Contains(r.out, `"cancelled"`) || f.bodies["POST /deployments/d1/reject"]["reason"] != "Not on Friday" {
		t.Fatalf("reject: %+v %v", r, f.bodies)
	}
	// Two waiting and nobody to ask: say which ones.
	f.waiting = 2
	if r := execute(t, "approve", "-s", "web"); r.code != ExitUsage || !strings.Contains(r.errout, "d1, d2") {
		t.Fatalf("several waiting: %+v", r)
	}
	f.waiting = 0
	if r := execute(t, "approve", "-s", "web"); r.code != ExitError || !strings.Contains(r.errout, "no deployment of web waits for approval") {
		t.Fatalf("none waiting: %+v", r)
	}
	f.waiting = 1
	f.forbid["/deployments/d1/approve"] = "This token cannot do this. It needs: deploys.approve (Approve deploys)."
	if r := execute(t, "approve", "-s", "web"); r.code != ExitError || !strings.Contains(r.errout, "deploys.approve") {
		t.Fatalf("403: %+v", r)
	}
}

func TestExecRunsACommand(t *testing.T) {
	f := gapsSetup(t)
	r := execute(t, "exec", "-s", "web", "--replica", "2", "--", "sh", "-c", "echo $HOME")
	if r.code != 0 || r.out != "line 1\nline 2\n" {
		t.Fatalf("exec: %+v", r)
	}
	b := f.bodies["POST /services/s1/exec"]
	if b["command"] != `sh -c 'echo $HOME'` || b["replica"] != float64(2) {
		t.Fatalf("body: %v", b)
	}
	f.exitCode = 7
	if r := execute(t, "exec", "-s", "web", "false"); r.code != 7 {
		t.Fatalf("exit code: %+v", r)
	}
	// No command and no terminal: a shell cannot open.
	if r := execute(t, "exec", "-s", "web"); r.code != ExitUsage || !strings.Contains(r.errout, "needs a terminal") {
		t.Fatalf("no terminal: %+v", r)
	}
	f.forbid["/services/s1/exec"] = "This token cannot do this. It needs: console.access (Console)."
	if r := execute(t, "exec", "-s", "web", "ls"); r.code != ExitError || !strings.Contains(r.errout, "console.access") {
		t.Fatalf("403: %+v", r)
	}
}

func TestSSHRunsACommandOnAServer(t *testing.T) {
	f := gapsSetup(t)
	f.shellExit = 0
	r := execute(t, "ssh", "web-1", "--", "uptime")
	if r.code != 0 || r.out != "up 3 days\n" || f.bodies["POST /servers/srv1/terminal"]["command"] != "uptime" || !f.called("DELETE /servers/srv1/terminal/t1") {
		t.Fatalf("ssh: %+v %v", r, f.calls)
	}
	f.shellExit = 3
	if r := execute(t, "ssh", "web-1", "false"); r.code != 3 {
		t.Fatalf("exit code: %+v", r)
	}
	if r := execute(t, "ssh", "web-1"); r.code != ExitUsage || !strings.Contains(r.errout, "needs a terminal") {
		t.Fatalf("no terminal: %+v", r)
	}
	if r := execute(t, "ssh", "nope", "--", "ls"); r.code != ExitError || !strings.Contains(r.errout, `no server named "nope"`) {
		t.Fatalf("unknown server: %+v", r)
	}
	f.forbid["/servers/srv1/terminal"] = "Only admins who manage this server can open a shell on it."
	if r := execute(t, "ssh", "web-1", "ls"); r.code != ExitError || !strings.Contains(r.errout, "Only admins who manage this server") {
		t.Fatalf("403: %+v", r)
	}
}

func TestTailscale(t *testing.T) {
	f := gapsSetup(t)
	if r := execute(t, "tailscale"); r.code != 0 || !strings.Contains(r.out, "100.64.0.2") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "tailscale", "ls", "--json"); r.code != 0 || !strings.Contains(r.out, `"tailnet": "-"`) {
		t.Fatalf("ls --json: %+v", r)
	}
	if r := execute(t, "tailscale", "join", "web-1", "--tailnet", "corp"); r.code != 0 || f.bodies["POST /servers/srv1/tailscale/connect"]["tailnetId"] != "tn1" {
		t.Fatalf("join: %+v", r)
	}
	f.moveNeed = true
	if r := execute(t, "tailscale", "join", "web-1"); r.code != ExitError || !strings.Contains(r.errout, "--force") {
		t.Fatalf("move needed: %+v", r)
	}
	if r := execute(t, "tailscale", "join", "web-1", "--force"); r.code != 0 {
		t.Fatalf("force: %+v", r)
	}
	r := execute(t, "tailscale", "join", "web-1", "--command")
	if r.code != 0 || !strings.HasPrefix(r.out, "curl -fsSL") {
		t.Fatalf("--command: %+v", r)
	}
	f.forbid["/tailscale/tailnets"] = "This token cannot do this. It needs: admin, with an owner who is an admin of the Root organization."
	if r := execute(t, "tailscale"); r.code != ExitError || !strings.Contains(r.errout, "Root organization") {
		t.Fatalf("403: %+v", r)
	}
}

func TestCloudflareTunnels(t *testing.T) {
	f := gapsSetup(t)
	if r := execute(t, "cloudflare", "tunnels"); r.code != 0 || !strings.Contains(r.out, "app.example.com") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "cloudflare", "tunnels", "create", "db-1"); r.code != 0 || f.bodies["POST /cloudflare/accounts/cf1/tunnels"]["serverId"] != "srv2" || !strings.Contains(r.errout, "db.example.com") {
		t.Fatalf("create: %+v", r)
	}
	if r := execute(t, "cloudflare", "tunnels", "rm", "web-1"); r.code != ExitUsage || f.called("DELETE /cloudflare/accounts/cf1/tunnels/tun1") {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "cloudflare", "tunnels", "rm", "web-1", "--yes"); r.code != 0 || !f.called("DELETE /cloudflare/accounts/cf1/tunnels/tun1") || !strings.Contains(r.errout, "app.example.com") {
		t.Fatalf("rm: %+v", r)
	}
}

func TestPrivateNetworks(t *testing.T) {
	f := gapsSetup(t)
	if r := execute(t, "networks"); r.code != 0 || !strings.Contains(r.out, "backend") || !strings.Contains(r.errout, "Not joined yet: db-1") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "networks", "join", "db-1"); r.code != ExitError || !strings.Contains(r.errout, "has not joined the private network") {
		t.Fatalf("join a server that did not join: %+v", r)
	}
	if r := execute(t, "networks", "join", "cache-1"); r.code != 0 || f.bodies["PUT /private-networks/n1/members"]["member"] != true {
		t.Fatalf("join: %+v", r)
	}
	if r := execute(t, "networks", "leave", "web-1", "--network", "backend"); r.code != 0 || f.bodies["PUT /private-networks/n1/members"]["member"] != false {
		t.Fatalf("leave: %+v", r)
	}
	if r := execute(t, "networks", "create", "edge", "--server", "web-1"); r.code != 0 {
		t.Fatalf("create: %+v", r)
	}
	if ids, _ := f.bodies["POST /private-networks"]["serverIds"].([]any); len(ids) != 1 || ids[0] != "srv1" {
		t.Fatalf("create body: %v", f.bodies["POST /private-networks"])
	}
	if r := execute(t, "networks", "rm", "backend"); r.code != ExitUsage {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "networks", "rm", "backend", "-y"); r.code != 0 || !f.called("DELETE /private-networks/n1") {
		t.Fatalf("rm: %+v", r)
	}
}

func TestLogDrains(t *testing.T) {
	f := gapsSetup(t)
	if r := execute(t, "log-drains"); r.code != 0 || !strings.Contains(r.out, "axiom") || !strings.Contains(r.out, "1 project") {
		t.Fatalf("ls: %+v", r)
	}
	if r := execute(t, "log-drains", "add", "loki", "--kind", "loki", "--url", "https://loki.example.com"); r.code != ExitUsage || !strings.Contains(r.errout, "--all-projects") {
		t.Fatalf("nothing picked: %+v", r)
	}
	if r := execute(t, "log-drains", "add", "pt", "--kind", "syslog", "--url", "https://x.example.com", "--all-projects"); r.code != ExitUsage {
		t.Fatalf("bad syslog url: %+v", r)
	}
	r := execute(t, "log-drains", "add", "loki", "--kind", "loki", "--url", "https://loki.example.com", "--username", "serve", "--secret", "pw", "--projects", "shop")
	b := f.bodies["POST /log-drains"]
	if r.code != 0 || b["password"] != "pw" || b["username"] != "serve" || fmt.Sprint(b["projectIds"]) != "[p1]" {
		t.Fatalf("add: %+v %v", r, b)
	}
	if r := execute(t, "log-drains", "test", "axiom"); r.code != ExitError || !strings.Contains(r.errout, "answered 401") {
		t.Fatalf("test: %+v", r)
	}
	if r := execute(t, "log-drains", "rm", "axiom", "--yes"); r.code != 0 || !f.called("DELETE /log-drains/ld1") {
		t.Fatalf("rm: %+v", r)
	}
}

func TestCopyExecOutput(t *testing.T) {
	for _, chunks := range [][]string{{"a\nb\n\n\x0042"}, {"a\nb\n", "\n", "\x00", "42"}, {"a\nb\n\n\x004", "2"}} {
		var out bytes.Buffer
		code, err := api.CopyExecOutput(&chunked{parts: chunks}, &out)
		if err != nil || code != 42 || out.String() != "a\nb\n" {
			t.Fatalf("%q: %d %v %q", chunks, code, err, out.String())
		}
	}
	var out bytes.Buffer
	if _, err := api.CopyExecOutput(strings.NewReader("cut off\n"), &out); err != api.ErrNoExitCode || out.String() != "cut off\n" {
		t.Fatalf("no exit code: %v %q", err, out.String())
	}
}

type chunked struct{ parts []string }

func (c *chunked) Read(p []byte) (int, error) {
	if len(c.parts) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.parts[0])
	c.parts = c.parts[1:]
	return n, nil
}

func TestShellLineAndCRLF(t *testing.T) {
	if got := shellLine([]string{"ls | wc -l"}); got != "ls | wc -l" {
		t.Fatal(got)
	}
	if got := shellLine([]string{"echo", "it's", "a/b"}); got != `echo 'it'\''s' a/b` {
		t.Fatal(got)
	}
	var out bytes.Buffer
	w := &crlfWriter{w: &out}
	w.Write([]byte("a\r"))
	w.Write([]byte("\nb\r\n"))
	w.flush()
	if out.String() != "a\nb\n" {
		t.Fatalf("%q", out.String())
	}
}
