package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// dbFake is the database part of the Serve API: a project with a PostgreSQL (pg), a Redis
// (cache) and a MongoDB (mongo) database, with routes shaped like src/server/api/routes.
type dbFake struct {
	mu       sync.Mutex
	calls    []string
	bodies   map[string]map[string]any
	backups  []map[string]any
	branches []map[string]any
	polls    int    // GETs of backups or branches seen, to move running work along
	refuse   string // answer this route ("POST /services/pg1/backups") with a 403
	created  map[string]any
	version  string // the version a created database gets
	queryErr string
}

func (f *dbFake) seen(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == call {
			return true
		}
	}
	return false
}

func dbService(id, name, engine, database string) map[string]any {
	return map[string]any{"id": id, "name": name, "slug": name, "type": "database", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1",
		"database": map[string]any{"engine": engine, "version": "18-alpine", "username": "postgres", "database": database}}
}

func (f *dbFake) handler() http.Handler {
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	pg := dbService("pg1", "pg", "postgres", "app")
	cache := dbService("rd1", "cache", "redis", "0")
	mongo := dbService("mg1", "mongo", "mongodb", "app")
	web := map[string]any{"id": "s1", "name": "web", "slug": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1"}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			j(w, 401, map[string]any{"error": "Invalid or missing API token"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		call := r.Method + " " + p
		f.calls = append(f.calls, call)
		var body map[string]any
		if r.Body != nil {
			json.NewDecoder(r.Body).Decode(&body)
		}
		if f.bodies == nil {
			f.bodies = map[string]map[string]any{}
		}
		f.bodies[call] = body
		if call == f.refuse {
			j(w, 403, map[string]any{"error": "You do not have permission to manage backups."})
			return
		}
		switch call {
		case "GET /projects":
			j(w, 200, map[string]any{"projects": []any{map[string]any{"id": "p1", "name": "shop"}}})
		case "GET /projects/p1/environments":
			j(w, 200, map[string]any{"environments": []any{map[string]any{"id": "e1", "projectId": "p1", "name": "production"}}})
		case "GET /servers":
			j(w, 200, map[string]any{"servers": []any{map[string]any{"id": "srv1", "name": "local", "status": "ready", "isLocal": true}, map[string]any{"id": "srv2", "name": "eu", "status": "ready"}}})
		case "GET /services":
			j(w, 200, map[string]any{"services": []any{web, pg, cache, mongo}})
		case "GET /services/pg1":
			j(w, 200, map[string]any{"service": pg})
		case "GET /services/rd1":
			j(w, 200, map[string]any{"service": cache})
		case "GET /services/mg1":
			j(w, 200, map[string]any{"service": mongo})
		case "GET /services/s1":
			j(w, 200, map[string]any{"service": web})
		case "POST /services":
			f.created = body
			j(w, 201, map[string]any{"id": "new1"})
		case "GET /services/new1":
			v := f.version
			if v == "" {
				v = "18-alpine"
			}
			if s, ok := f.created["version"].(string); ok && s == v {
				v = s
			}
			j(w, 200, map[string]any{"service": map[string]any{"id": "new1", "name": f.created["name"], "type": "database", "status": "idle", "projectId": "p1", "project": "shop", "environmentId": "e1",
				"database": map[string]any{"engine": f.created["engine"], "version": v, "username": "postgres", "database": "app"}}})
		case "DELETE /services/new1", "POST /services/new1/deploy":
			j(w, 200, map[string]any{"ok": true})
		case "GET /services/pg1/connection":
			j(w, 200, map[string]any{"connection": map[string]any{"engine": "postgres", "variables": map[string]any{"HOST": "pg", "DATABASE_URL": "postgres://postgres:new@pg:5432/app"}}})
		case "GET /services/pg1/backups":
			f.polls++
			// Running work finishes on the second look.
			if f.polls > 1 {
				for _, b := range f.backups {
					if b["status"] == "running" {
						b["status"], b["size"] = "success", 2048
					}
					if b["restoreStatus"] == "running" {
						b["restoreStatus"] = "success"
					}
				}
			}
			j(w, 200, map[string]any{"backups": f.backups})
		case "POST /services/pg1/backups":
			f.backups = append([]map[string]any{{"id": "b9", "status": "running", "trigger": "manual", "databases": nil, "createdAt": time.Now().UTC().Format(time.RFC3339)}}, f.backups...)
			f.polls = 0
			j(w, 202, map[string]any{"id": "b9"})
		case "POST /backups/b1/restore":
			f.backups[len(f.backups)-1]["restoreStatus"] = "running"
			f.polls = 0
			j(w, 202, nil)
		case "DELETE /backups/b1":
			j(w, 200, map[string]any{"ok": true})
		case "POST /services/pg1/database/import":
			f.backups = append([]map[string]any{{"id": "imp", "status": "running", "trigger": "import", "restoreStatus": "running", "createdAt": "2026-01-01T00:00:00Z"}}, f.backups...)
			f.polls = 0
			j(w, 202, map[string]any{"id": "imp"})
		case "GET /s3-destinations":
			j(w, 200, map[string]any{"destinations": []any{map[string]any{"id": "s3a", "name": "Backups", "bucket": "acme-dumps"}}})
		case "POST /services/pg1/data/query":
			if f.queryErr != "" {
				j(w, 200, map[string]any{"result": nil, "error": f.queryErr, "ms": 3})
				return
			}
			j(w, 200, map[string]any{"result": map[string]any{"kind": "rows", "columns": []string{"id", "email"}, "rows": [][]any{{"1", "ada@example.com"}, {"2", nil}}, "truncated": false, "rowCount": 2}, "error": nil, "ms": 4})
		case "POST /services/rd1/data/query":
			j(w, 200, map[string]any{"result": map[string]any{"kind": "text", "text": "PONG"}, "error": nil, "ms": 1})
		case "POST /services/mg1/data/query":
			j(w, 200, map[string]any{"result": map[string]any{"kind": "documents", "documents": []string{`{"_id": 1}`}, "truncated": false}, "error": nil, "ms": 2})
		case "GET /services/pg1/data":
			j(w, 200, map[string]any{"engine": "postgres", "family": "sql", "databases": []any{map[string]any{"name": "app", "size": 12000}, map[string]any{"name": "postgres", "size": 7000}},
				"database": "app", "schemas": []string{"public"}, "tables": []any{map[string]any{"schema": "public", "name": "users", "kind": "table", "rows": 2, "bytes": 8192}}})
		case "GET /services/pg1/users":
			j(w, 200, map[string]any{"users": []any{
				map[string]any{"username": "reporting", "managed": true, "knowsPassword": true, "protectedReason": nil, "access": "read", "databases": []string{"app"}},
				map[string]any{"username": "postgres", "managed": false, "knowsPassword": false, "protectedReason": "Serve's own login", "access": nil, "databases": []string{}},
			}, "databases": []string{"app"}, "mainDatabase": "app"})
		case "POST /services/pg1/users":
			j(w, 201, map[string]any{"user": map[string]any{"username": body["username"], "password": "s3cret-pass", "privateUrl": "postgres://x:s3cret-pass@pg/app"}})
		case "POST /services/pg1/users/reporting/password", "GET /services/pg1/users/reporting/connection":
			j(w, 200, map[string]any{"user": map[string]any{"username": "reporting", "password": "n3w-pass", "privateUrl": "postgres://reporting:n3w-pass@pg/app", "publicUrl": nil}})
		case "DELETE /services/pg1/users/reporting":
			j(w, 200, map[string]any{"ok": true})
		case "POST /services/pg1/database/password":
			j(w, 200, map[string]any{"dependents": []any{map[string]any{"id": "s1", "name": "web", "status": "running"}}})
		case "GET /services/pg1/database/dependents":
			j(w, 200, map[string]any{"dependents": []any{map[string]any{"id": "s1", "name": "web", "status": "running"}}})
		case "GET /services/pg1/branches":
			f.polls++
			if f.polls > 1 {
				for _, b := range f.branches {
					if b["status"] == "creating" || b["status"] == "resetting" {
						b["status"] = "ready"
					}
				}
			}
			j(w, 200, map[string]any{"branches": f.branches})
		case "POST /services/pg1/branches":
			f.branches = append(f.branches, map[string]any{"id": "br2", "name": body["name"], "database": "app__x", "status": "creating", "sourceBranchId": body["sourceBranchId"], "createdAt": "2026-01-01T00:00:00Z"})
			f.polls = 0
			j(w, 202, map[string]any{"id": "br2"})
		case "POST /branches/br1/reset":
			f.branches[0]["status"] = "resetting"
			f.polls = 0
			j(w, 202, nil)
		case "DELETE /branches/br1":
			j(w, 200, map[string]any{"ok": true})
		case "GET /services/pg1/database/replicas":
			j(w, 200, map[string]any{"replicas": []any{map[string]any{"id": "r1", "serverId": "srv2", "state": "following", "lagSeconds": 1.5, "error": nil}}})
		case "POST /services/pg1/database/replicas/r1/promote":
			j(w, 200, nil)
		default:
			j(w, 404, map[string]any{"error": "No API route " + call})
		}
	})
}

func dbSetup(t *testing.T) *dbFake {
	t.Helper()
	setup(t)
	f := &dbFake{
		backups: []map[string]any{
			{"id": "b2", "status": "failed", "trigger": "schedule", "error": "disk full", "createdAt": "2026-01-02T00:00:00Z"},
			{"id": "b1", "status": "success", "trigger": "manual", "size": 1024, "databases": []string{"app"}, "createdAt": "2026-01-01T00:00:00Z"},
		},
		branches: []map[string]any{{"id": "br1", "name": "staging", "database": "app__staging", "status": "ready", "personalDataHidden": true, "createdAt": "2026-01-01T00:00:00Z"}},
	}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	old := dbPoll
	dbPoll = time.Millisecond
	t.Cleanup(func() { dbPoll = old })
	return f
}

func TestDbCreate(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "create", "postgresql", "--project", "shop", "--server", "eu")
	if r.code != 0 || !strings.Contains(r.errout, "Created the PostgreSQL 18-alpine database") || !strings.Contains(r.errout, "shop / production") {
		t.Fatalf("create: %+v", r)
	}
	if f.created["engine"] != "postgres" || f.created["name"] != "postgres" || f.created["deploy"] != true || f.created["serverId"] != "srv2" || f.created["environmentId"] != "e1" {
		t.Fatalf("body: %v", f.created)
	}

	// A version Serve does not offer: nothing is left behind.
	r = execute(t, "db", "create", "postgres", "--project", "shop", "--version", "9", "--name", "old", "--server", "local")
	if r.code != ExitError || !strings.Contains(r.errout, `no version "9"`) || !f.seen("DELETE /services/new1") || f.seen("POST /services/new1/deploy") {
		t.Fatalf("bad version: %+v", r)
	}
	if _, ok := f.created["deploy"]; ok {
		t.Fatal("a database with a version to check must not start before the check")
	}
	f.version = "17-alpine"
	r = execute(t, "db", "create", "postgres", "--project", "shop", "--version", "17-alpine", "--json", "--server", "local")
	if r.code != 0 || !f.seen("POST /services/new1/deploy") || !strings.Contains(r.out, `"17-alpine"`) {
		t.Fatalf("version: %+v", r)
	}

	if r := execute(t, "db", "create", "oracle", "--project", "shop"); r.code != ExitUsage || !strings.Contains(r.errout, "postgres, mysql") {
		t.Fatalf("unknown engine: %+v", r)
	}
	if r := execute(t, "db", "create", "redis"); r.code != ExitUsage || !strings.Contains(r.errout, "--project") {
		t.Fatalf("no project without a terminal: %+v", r)
	}
}

func TestDbBackups(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "backups", "pg")
	if r.code != 0 || !strings.Contains(r.out, "b1") || !strings.Contains(r.out, "disk full") || !strings.Contains(r.out, "1.0 kB") {
		t.Fatalf("ls: %+v", r)
	}
	r = execute(t, "db", "backups", "ls", "-s", "pg", "--json")
	var list []map[string]any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &list) != nil || len(list) != 2 {
		t.Fatalf("json: %+v", r)
	}

	r = execute(t, "db", "backups", "create", "pg", "--wait", "-d", "app")
	if r.code != 0 || !strings.Contains(r.errout, "Backed up pg (2.0 kB)") {
		t.Fatalf("create: %+v", r)
	}
	if dbs := f.bodies["POST /services/pg1/backups"]["databases"]; dbs == nil || dbs.([]any)[0] != "app" {
		t.Fatalf("databases: %v", f.bodies["POST /services/pg1/backups"])
	}

	// Restoring replaces data: no terminal to ask means --yes.
	if r := execute(t, "db", "backups", "restore", "b1", "-s", "pg"); r.code != ExitUsage || !strings.Contains(r.errout, "--yes") || f.seen("POST /backups/b1/restore") {
		t.Fatalf("restore without --yes: %+v", r)
	}
	if r := execute(t, "db", "backups", "restore", "b2", "-s", "pg", "--yes"); r.code != ExitError || !strings.Contains(r.errout, "did not finish") {
		t.Fatalf("restore failed backup: %+v", r)
	}
	r = execute(t, "db", "backups", "restore", "b1", "-s", "pg", "--yes", "--wait", "--backup-first")
	if r.code != 0 || !strings.Contains(r.errout, "Restored pg from backup b1") || f.bodies["POST /backups/b1/restore"]["backupFirst"] != true {
		t.Fatalf("restore: %+v %v", r, f.bodies["POST /backups/b1/restore"])
	}

	if r := execute(t, "db", "backups", "rm", "b1", "-s", "pg"); r.code != ExitUsage || f.seen("DELETE /backups/b1") {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "db", "backups", "rm", "b1", "-s", "pg", "-y"); r.code != 0 || !f.seen("DELETE /backups/b1") {
		t.Fatalf("rm: %+v", r)
	}
	if r := execute(t, "db", "backups", "rm", "nope", "-s", "pg", "-y"); r.code != ExitError || !strings.Contains(r.errout, `no backup "nope"`) {
		t.Fatalf("rm unknown: %+v", r)
	}

	// An API error comes back as its message.
	f.refuse = "POST /services/pg1/backups"
	if r := execute(t, "db", "backups", "create", "-s", "pg"); r.code != ExitError || !strings.Contains(r.errout, "permission to manage backups") {
		t.Fatalf("refused: %+v", r)
	}
	// Not a database.
	if r := execute(t, "db", "backups", "web"); r.code != ExitError || !strings.Contains(r.errout, "not a database") {
		t.Fatalf("app: %+v", r)
	}
}

func TestDbRestoreLatest(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "backups", "restore", "latest", "-s", "pg", "--yes")
	if r.code != 0 || !f.seen("POST /backups/b1/restore") || !strings.Contains(r.errout, "Started restoring") {
		t.Fatalf("latest: %+v", r)
	}
}

func TestDbImport(t *testing.T) {
	f := dbSetup(t)
	if r := execute(t, "db", "import", "ftp://x/y", "-s", "pg", "--yes"); r.code != ExitUsage {
		t.Fatalf("bad source: %+v", r)
	}
	if r := execute(t, "db", "import", "https://example.com/d.sql.gz", "-s", "pg"); r.code != ExitUsage || f.seen("POST /services/pg1/database/import") {
		t.Fatalf("import without --yes: %+v", r)
	}
	r := execute(t, "db", "import", "s3://acme-dumps/old/app.dump", "-s", "pg", "--yes", "--wait", "--no-backup")
	body := f.bodies["POST /services/pg1/database/import"]
	src, _ := body["source"].(map[string]any)
	if r.code != 0 || !strings.Contains(r.errout, "Imported the dump into pg") || src["destinationId"] != "s3a" || src["key"] != "old/app.dump" || body["backupFirst"] != false {
		t.Fatalf("import: %+v %v", r, body)
	}
	if r := execute(t, "db", "import", "s3://nope/k", "-s", "pg", "--yes"); r.code != ExitError || !strings.Contains(r.errout, "no S3 storage") {
		t.Fatalf("unknown storage: %+v", r)
	}
}

func TestDbQuery(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "query", "pg", "select id, email from users")
	if r.code != 0 || !strings.Contains(r.out, "ada@example.com") || !strings.Contains(r.out, "NULL") || !strings.Contains(r.errout, "2 rows") {
		t.Fatalf("query: %+v", r)
	}
	body := f.bodies["POST /services/pg1/data/query"]
	if body["database"] != "app" || body["readOnly"] != true {
		t.Fatalf("body: %v", body)
	}
	r = execute(t, "db", "query", "-s", "pg", "--write", "--json", "-d", "other", "update x set y = 1")
	if r.code != 0 || !strings.Contains(r.out, `"columns"`) || f.bodies["POST /services/pg1/data/query"]["readOnly"] != false || f.bodies["POST /services/pg1/data/query"]["database"] != "other" {
		t.Fatalf("json: %+v", r)
	}

	// - reads the query from standard input.
	rd, wr, _ := os.Pipe()
	wr.WriteString("select 1\n")
	wr.Close()
	old := os.Stdin
	os.Stdin = rd
	r = execute(t, "db", "query", "pg", "-")
	os.Stdin = old
	if r.code != 0 || f.bodies["POST /services/pg1/data/query"]["query"] != "select 1" {
		t.Fatalf("stdin: %+v %v", r, f.bodies["POST /services/pg1/data/query"])
	}

	if r := execute(t, "db", "query", "cache", "PING"); r.code != 0 || strings.TrimSpace(r.out) != "PONG" || f.bodies["POST /services/rd1/data/query"]["database"] != "0" {
		t.Fatalf("redis: %+v", r)
	}
	if r := execute(t, "db", "query", "mongo", "{}"); r.code != ExitUsage || !strings.Contains(r.errout, "--collection") {
		t.Fatalf("mongo without collection: %+v", r)
	}
	if r := execute(t, "db", "query", "mongo", "-c", "users", "{}"); r.code != 0 || !strings.Contains(r.out, `{"_id": 1}`) || f.bodies["POST /services/mg1/data/query"]["collection"] != "users" {
		t.Fatalf("mongo: %+v", r)
	}

	// An error of the database itself.
	f.queryErr = `relation "nope" does not exist`
	if r := execute(t, "db", "query", "pg", "select * from nope"); r.code != ExitError || !strings.Contains(r.errout, "does not exist") {
		t.Fatalf("db error: %+v", r)
	}
	if r := execute(t, "db", "query", "pg", "select * from nope", "--json"); r.code != ExitError || !strings.Contains(r.out, "does not exist") {
		t.Fatalf("db error json: %+v", r)
	}
	if r := execute(t, "db", "query"); r.code != ExitUsage {
		t.Fatalf("no query: %+v", r)
	}
}

func TestDbTables(t *testing.T) {
	dbSetup(t)
	r := execute(t, "db", "tables", "pg")
	if r.code != 0 || !strings.Contains(r.out, "users") || !strings.Contains(r.out, "postgres") || !strings.Contains(r.out, "TABLE (app)") {
		t.Fatalf("tables: %+v", r)
	}
	if r := execute(t, "db", "tables", "pg", "--json"); r.code != 0 || !strings.Contains(r.out, `"family": "sql"`) {
		t.Fatalf("json: %+v", r)
	}
}

func TestDbUsers(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "users", "pg")
	if r.code != 0 || !strings.Contains(r.out, "reporting") || !strings.Contains(r.out, "read only") || strings.Contains(r.out, "pass") {
		t.Fatalf("ls: %+v", r)
	}
	// create gives the main database by default and does not print the password.
	r = execute(t, "db", "users", "create", "etl", "-s", "pg")
	if r.code != 0 || strings.Contains(r.out+r.errout, "s3cret") || f.bodies["POST /services/pg1/users"]["access"] != "readwrite" {
		t.Fatalf("create: %+v", r)
	}
	if dbs := f.bodies["POST /services/pg1/users"]["databases"].([]any); len(dbs) != 1 || dbs[0] != "app" {
		t.Fatalf("databases: %v", dbs)
	}
	if r := execute(t, "db", "users", "create", "etl", "-s", "pg", "--access", "all"); r.code != ExitUsage {
		t.Fatalf("bad access: %+v", r)
	}
	if r := execute(t, "db", "users", "password", "reporting", "-s", "pg"); r.code != ExitUsage || f.seen("POST /services/pg1/users/reporting/password") {
		t.Fatalf("password without --yes: %+v", r)
	}
	if r := execute(t, "db", "users", "password", "reporting", "-s", "pg", "--yes"); r.code != 0 || !strings.Contains(r.out, "n3w-pass") {
		t.Fatalf("password: %+v", r)
	}
	if r := execute(t, "db", "users", "url", "reporting", "-s", "pg"); r.code != 0 || strings.TrimSpace(r.out) != "postgres://reporting:n3w-pass@pg/app" {
		t.Fatalf("url: %+v", r)
	}
	if r := execute(t, "db", "users", "url", "reporting", "-s", "pg", "--public"); r.code != ExitError || !strings.Contains(r.errout, "public port") {
		t.Fatalf("public url: %+v", r)
	}
	if r := execute(t, "db", "users", "rm", "reporting", "-s", "pg"); r.code != ExitUsage {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "db", "users", "rm", "reporting", "-s", "pg", "--yes"); r.code != 0 || !f.seen("DELETE /services/pg1/users/reporting") {
		t.Fatalf("rm: %+v", r)
	}
}

func TestDbPassword(t *testing.T) {
	f := dbSetup(t)
	if r := execute(t, "db", "password", "pg"); r.code != ExitUsage || f.seen("POST /services/pg1/database/password") {
		t.Fatalf("without --yes: %+v", r)
	}
	r := execute(t, "db", "password", "pg", "--yes")
	if r.code != 0 || r.out != "" || !strings.Contains(r.errout, "web") {
		t.Fatalf("password: %+v", r)
	}
	r = execute(t, "db", "password", "pg", "--yes", "--show")
	if r.code != 0 || strings.TrimSpace(r.out) != "postgres://postgres:new@pg:5432/app" {
		t.Fatalf("show: %+v", r)
	}
}

func TestDbBranches(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "branches", "pg")
	if r.code != 0 || !strings.Contains(r.out, "staging") || !strings.Contains(r.out, "personal data hidden") {
		t.Fatalf("ls: %+v", r)
	}
	r = execute(t, "db", "branches", "create", "demo", "-s", "pg", "--from", "staging", "--wait")
	if r.code != 0 || !strings.Contains(r.errout, "Branch demo of pg is ready") || f.bodies["POST /services/pg1/branches"]["sourceBranchId"] != "br1" {
		t.Fatalf("create: %+v", r)
	}
	if r := execute(t, "db", "branches", "reset", "staging", "-s", "pg"); r.code != ExitUsage {
		t.Fatalf("reset without --yes: %+v", r)
	}
	if r := execute(t, "db", "branches", "reset", "staging", "-s", "pg", "-y", "--wait"); r.code != 0 || !f.seen("POST /branches/br1/reset") {
		t.Fatalf("reset: %+v", r)
	}
	if r := execute(t, "db", "branches", "rm", "staging", "-s", "pg"); r.code != ExitUsage || f.seen("DELETE /branches/br1") {
		t.Fatalf("rm without --yes: %+v", r)
	}
	if r := execute(t, "db", "branches", "rm", "staging", "-s", "pg", "--yes", "--children"); r.code != 0 || !strings.Contains(r.errout, "This also deletes demo") {
		t.Fatalf("rm: %+v", r)
	}
	if r := execute(t, "db", "branches", "rm", "nope", "-s", "pg", "--yes"); r.code != ExitError {
		t.Fatalf("rm unknown: %+v", r)
	}
}

func TestDbReplicasAndDependents(t *testing.T) {
	f := dbSetup(t)
	r := execute(t, "db", "replicas", "pg")
	if r.code != 0 || !strings.Contains(r.out, "eu") || !strings.Contains(r.out, "following") {
		t.Fatalf("replicas: %+v", r)
	}
	if r := execute(t, "db", "replicas", "promote", "eu", "-s", "pg"); r.code != ExitUsage || f.seen("POST /services/pg1/database/replicas/r1/promote") {
		t.Fatalf("promote without --yes: %+v", r)
	}
	if r := execute(t, "db", "replicas", "promote", "eu", "-s", "pg", "--yes"); r.code != 0 || !f.seen("POST /services/pg1/database/replicas/r1/promote") {
		t.Fatalf("promote: %+v", r)
	}
	if r := execute(t, "db", "replicas", "promote", "r9", "-s", "pg", "--yes"); r.code != ExitError {
		t.Fatalf("promote unknown: %+v", r)
	}
	if r := execute(t, "db", "dependents", "pg"); r.code != 0 || !strings.Contains(r.out, "web") {
		t.Fatalf("dependents: %+v", r)
	}
	if r := execute(t, "db", "dependents", "pg", "--json"); r.code != 0 || !strings.Contains(r.out, `"name": "web"`) {
		t.Fatalf("dependents json: %+v", r)
	}
}
