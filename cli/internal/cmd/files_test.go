package cmd

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
)

// filesFake mimics the files routes (src/server/api/routes/files.ts) of server srv1 and service s1.
type filesFake struct {
	mu       sync.Mutex
	folders  map[string]bool   // remote folders
	files    map[string]string // remote path -> content
	queries  []string
	archives int
	download func(w http.ResponseWriter, p string)
}

func filesSetup(t *testing.T) *filesFake {
	t.Helper()
	setup(t)
	f := &filesFake{folders: map[string]bool{"/": true, "/tmp": true, "/etc": true}, files: map[string]string{"/etc/hosts": "127.0.0.1 localhost\n"}}
	j := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	service := map[string]any{"id": "s1", "name": "web", "type": "app", "status": "running", "projectId": "p1", "project": "shop", "environmentId": "e1"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		q := r.URL.Query()
		f.queries = append(f.queries, r.Method+" "+p+"?"+q.Encode())
		path := q.Get("path")
		switch {
		case p == "/servers":
			j(w, 200, map[string]any{"servers": []any{map[string]any{"id": "srv1", "name": "web-1", "status": "ready"}}})
		case p == "/services":
			j(w, 200, map[string]any{"services": []any{service}})
		case p == "/services/s1":
			j(w, 200, map[string]any{"service": service})
		case r.Method == "GET" && strings.HasSuffix(p, "/files"):
			if !f.folders[path] {
				if _, ok := f.files[path]; ok {
					j(w, 400, map[string]any{"error": "Not a folder"})
				} else {
					j(w, 404, map[string]any{"error": "No such folder"})
				}
				return
			}
			j(w, 200, map[string]any{"path": path, "entries": []any{
				map[string]any{"name": "nginx", "type": "dir", "size": 4096, "mtime": 1700000000000, "mode": "rwxr-xr-x", "owner": "root", "group": "root"},
				map[string]any{"name": "hosts", "type": "file", "size": 1234, "mtime": 1700000000000, "mode": "rw-r--r--", "owner": "root", "group": "root"},
				map[string]any{"name": "localtime", "type": "link", "size": 27, "mtime": 1700000000000, "mode": "rwxrwxrwx", "owner": "root", "group": "root", "link": map[string]any{"target": "/usr/share/zoneinfo/UTC", "kind": "file"}},
			}, "mounts": []any{map[string]any{"path": "/etc/nginx", "kind": "volume", "name": "conf"}}})
		case r.Method == "POST" && strings.HasSuffix(p, "/files"):
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if f.folders[body["path"]] {
				j(w, 409, map[string]any{"error": "Something with that name already exists"})
				return
			}
			f.folders[body["path"]] = true
			j(w, 200, map[string]any{"path": body["path"]})
		case r.Method == "PUT" && strings.HasSuffix(p, "/files/content") && q.Get("extract") == "1":
			f.extract(w, r, path, q.Get("replace") == "1", j)
		case r.Method == "PUT" && strings.HasSuffix(p, "/files/content"):
			b, _ := io.ReadAll(r.Body)
			if _, ok := f.files[path]; ok && q.Get("replace") != "1" {
				j(w, 409, map[string]any{"error": "A file with that name already exists"})
				return
			}
			f.files[path] = string(b)
			j(w, 200, map[string]any{"path": path})
		case r.Method == "GET" && strings.HasSuffix(p, "/files/content"):
			if f.download != nil {
				f.download(w, path)
				return
			}
			c, ok := f.files[path]
			if !ok {
				j(w, 404, map[string]any{"error": "No such file or folder"})
				return
			}
			w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
			w.Header().Set("Content-Type", "application/octet-stream")
			io.WriteString(w, c)
		default:
			j(w, 404, map[string]any{"error": "No API route " + r.Method + " " + p})
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("SERVE_URL", srv.URL)
	t.Setenv("SERVE_TOKEN", "tok")
	return f
}

// extract unpacks an uploaded .tar.gz into the folder dir, like the server: 409 when a top-level
// entry exists and replace is off.
func (f *filesFake) extract(w http.ResponseWriter, r *http.Request, dir string, replace bool, j func(http.ResponseWriter, int, any)) {
	if !f.folders[dir] {
		j(w, 404, map[string]any{"error": "No such folder"})
		return
	}
	gz, err := gzip.NewReader(r.Body)
	if err != nil {
		j(w, 400, map[string]any{"error": "Not a .tar.gz"})
		return
	}
	tr := tar.NewReader(gz)
	folders, files, links := map[string]bool{}, map[string]string{}, map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			j(w, 400, map[string]any{"error": err.Error()})
			return
		}
		full := strings.TrimSuffix(dir, "/") + "/" + strings.TrimSuffix(h.Name, "/")
		top := strings.TrimSuffix(dir, "/") + "/" + strings.SplitN(h.Name, "/", 2)[0]
		_, isFile := f.files[top]
		if !replace && (f.folders[top] || isFile) {
			j(w, 409, map[string]any{"error": "Something with that name already exists"})
			return
		}
		switch h.Typeflag {
		case tar.TypeDir:
			folders[full] = true
		case tar.TypeReg:
			b, _ := io.ReadAll(tr)
			files[full] = string(b)
		case tar.TypeSymlink:
			links[full] = h.Linkname
		}
	}
	for k := range folders {
		f.folders[k] = true
	}
	for k, v := range files {
		f.files[k] = v
	}
	for k, v := range links {
		f.files[k] = "-> " + v
	}
	f.archives++
	j(w, 200, map[string]any{"path": dir})
}

func TestUploadFileIntoFolder(t *testing.T) {
	f := filesSetup(t)
	write(t, ".", map[string]string{"a.txt": "hello"})
	r := execute(t, "upload", "a.txt", "web-1:/tmp")
	if r.code != 0 || f.files["/tmp/a.txt"] != "hello" || !strings.Contains(r.errout, "Uploaded a.txt → web-1:/tmp/a.txt") {
		t.Fatalf("upload: %+v %v", r, f.files)
	}
	// The service: no remote path means /tmp/.
	r = execute(t, "upload", "-s", "web", "a.txt", "--force")
	if r.code != 0 || !strings.Contains(r.errout, "web:/tmp/a.txt") || !strings.Contains(strings.Join(f.queries, " "), "PUT /services/s1/files/content?path=%2Ftmp%2Fa.txt&replace=1") {
		t.Fatalf("service upload: %+v %v", r, f.queries)
	}
	// A new name for one file.
	if r := execute(t, "upload", "a.txt", "web-1:/etc/b.conf"); r.code != 0 || f.files["/etc/b.conf"] != "hello" {
		t.Fatalf("rename: %+v", r)
	}
	if r := execute(t, "upload", "a.txt", "a.txt", "web-1:/etc/c.conf"); r.code != ExitUsage || !strings.Contains(r.errout, "not a folder") {
		t.Fatalf("several to a file: %+v", r)
	}
	// The service's path takes a colon; a bare absolute path is a local file, never the destination.
	if r := execute(t, "upload", "-s", "web", "a.txt", ":/etc/"); r.code != 0 || !strings.Contains(r.errout, "web:/etc/a.txt") {
		t.Fatalf("service :path: %+v", r)
	}
	abs, _ := filepath.Abs("a.txt")
	f.queries = nil
	if r := execute(t, "upload", "-s", "web", "a.txt", abs, "--force"); r.code != 0 || strings.Count(r.errout, "→ web:/tmp/a.txt") != 2 {
		t.Fatalf("bare absolute path: %+v", r)
	}
	if strings.Contains(strings.Join(f.queries, " "), url.QueryEscape(abs)) {
		t.Fatalf("a local absolute path was used as the destination: %v", f.queries)
	}
	// A server's name alone: its /tmp/.
	write(t, ".", map[string]string{"b.txt": "bee"})
	if r := execute(t, "upload", "b.txt", "web-1"); r.code != 0 || f.files["/tmp/b.txt"] != "bee" {
		t.Fatalf("server shorthand: %+v", r)
	}
	// A local file with a server's name: say which one is meant.
	write(t, ".", map[string]string{"web-1": "x"})
	if r := execute(t, "upload", "b.txt", "web-1"); r.code != ExitUsage || !strings.Contains(r.errout, "Write web-1:") {
		t.Fatalf("ambiguous name: %+v", r)
	}
	if r := execute(t, "upload", "missing.txt", "web-1:/tmp/"); r.code == 0 || !strings.Contains(r.errout, "missing.txt") {
		t.Fatalf("missing local: %+v", r)
	}
	if r := execute(t, "upload", "a.txt", "web-1:/tmp", "-c", "worker"); r.code != ExitUsage {
		t.Fatalf("--container on a server: %+v", r)
	}
}

func TestUploadExistingNeedsForce(t *testing.T) {
	f := filesSetup(t)
	write(t, ".", map[string]string{"hosts": "new"})
	r := execute(t, "upload", "hosts", "web-1:/etc/")
	if r.code == 0 || !strings.Contains(r.errout, "web-1:/etc/hosts already exists. Pass --force") || f.files["/etc/hosts"] == "new" {
		t.Fatalf("409: %+v", r)
	}
	if r := execute(t, "upload", "hosts", "web-1:/etc/", "--force"); r.code != 0 || f.files["/etc/hosts"] != "new" {
		t.Fatalf("--force: %+v", r)
	}
}

func TestUploadFolderAsOneArchive(t *testing.T) {
	f := filesSetup(t)
	write(t, ".", map[string]string{"site/index.html": "<h1>", "site/css/app.css": "body{}"})
	os.Symlink("index.html", filepath.Join("site", "link.html"))
	r := execute(t, "upload", "./site", "web-1:/tmp/")
	if r.code != 0 || f.archives != 1 || !f.folders["/tmp/site/css"] || f.files["/tmp/site/css/app.css"] != "body{}" || f.files["/tmp/site/index.html"] != "<h1>" ||
		f.files["/tmp/site/link.html"] != "-> index.html" || !strings.Contains(r.errout, "Uploaded ./site → web-1:/tmp/site (2 files, 10 B)") {
		t.Fatalf("folder: %+v %v %v", r, f.folders, f.files)
	}
	for _, q := range f.queries {
		if strings.HasPrefix(q, "POST ") || strings.Contains(q, "site%2Findex") {
			t.Fatalf("a request per file: %v", f.queries)
		}
	}
	// It exists now: kept unless --force, which merges.
	r = execute(t, "upload", "./site", "web-1:/tmp/")
	if r.code == 0 || !strings.Contains(r.errout, "web-1:/tmp/site already exists. Pass --force to merge into it") {
		t.Fatalf("409: %+v", r)
	}
	write(t, ".", map[string]string{"site/index.html": "<h2>"})
	if r := execute(t, "upload", "./site", "web-1:/tmp/", "-f"); r.code != 0 || f.files["/tmp/site/index.html"] != "<h2>" {
		t.Fatalf("--force: %+v", r)
	}
	// A new name: unpacked into the parent under that name.
	if r := execute(t, "upload", "./site", "web-1:/etc/www"); r.code != 0 || f.files["/etc/www/index.html"] != "<h2>" {
		t.Fatalf("rename: %+v %v", r, f.files)
	}
}

func TestDownloadFile(t *testing.T) {
	filesSetup(t)
	os.Mkdir("out", 0o755)
	r := execute(t, "download", "web-1:/etc/hosts", "out")
	if b, _ := os.ReadFile(filepath.Join("out", "hosts")); r.code != 0 || string(b) != "127.0.0.1 localhost\n" {
		t.Fatalf("download: %+v %q", r, b)
	}
	// It exists now: kept unless --force.
	r = execute(t, "download", "web-1:/etc/hosts", "out")
	if r.code == 0 || !strings.Contains(r.errout, "already exists. Pass --force") {
		t.Fatalf("overwrite: %+v", r)
	}
	if r := execute(t, "download", "web-1:/etc/hosts", "out", "--force"); r.code != 0 {
		t.Fatalf("--force: %+v", r)
	}
	if r := execute(t, "download", "web-1:/nope"); r.code == 0 || !strings.Contains(r.errout, "No such file") {
		t.Fatalf("404: %+v", r)
	}
	entries, _ := os.ReadDir("out")
	if len(entries) != 1 {
		t.Fatalf("a temporary file was left: %v", entries)
	}
}

func tarGz(t *testing.T, entries map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, c := range entries {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(c)), Typeflag: tar.TypeReg})
		io.WriteString(tw, c)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestDownloadFolderExtract(t *testing.T) {
	f := filesSetup(t)
	archive := tarGz(t, map[string]string{"nginx/nginx.conf": "events {}"})
	f.download = func(w http.ResponseWriter, p string) {
		w.Header().Set("Content-Disposition", `attachment; filename="nginx.tar.gz"`)
		w.Header().Set("Content-Type", "application/gzip")
		w.Write(archive)
	}
	if r := execute(t, "download", "web-1:/etc/nginx", "-x", "conf"); r.code != 0 {
		t.Fatalf("extract: %+v", r)
	}
	if b, _ := os.ReadFile(filepath.Join("conf", "nginx", "nginx.conf")); string(b) != "events {}" {
		t.Fatalf("extracted: %q", b)
	}
	// Without -x it is saved as the .tar.gz.
	if r := execute(t, "download", "web-1:/etc/nginx"); r.code != 0 {
		t.Fatalf("archive: %+v", r)
	}
	if b, _ := os.ReadFile("nginx.tar.gz"); !bytes.Equal(b, archive) {
		t.Fatal("the .tar.gz was not saved")
	}
	// An entry that climbs out is refused.
	archive = tarGz(t, map[string]string{"../evil.txt": "x"})
	if r := execute(t, "download", "web-1:/etc/nginx", "-x", "safe"); r.code == 0 || !strings.Contains(r.errout, "outside") {
		t.Fatalf("../ entry: %+v", r)
	}
	if _, err := os.Stat("evil.txt"); err == nil {
		t.Fatal("../ entry was written")
	}
}

func TestLsTable(t *testing.T) {
	filesSetup(t)
	r := execute(t, "ls", "web-1:/etc")
	if r.code != 0 || !strings.Contains(r.errout, "web-1:/etc") {
		t.Fatalf("ls: %+v", r)
	}
	lines := strings.Split(strings.TrimSpace(r.out), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[1], "drwxr-xr-x") || !strings.Contains(lines[1], "(volume conf)") || !strings.Contains(lines[2], "1.2 kB") ||
		!strings.Contains(lines[3], "localtime -> /usr/share/zoneinfo/UTC") {
		t.Fatalf("table:\n%s", r.out)
	}
	if r := execute(t, "ls", "-s", "web", ":/etc"); r.code != 0 || !strings.Contains(r.errout, "web:/etc") {
		t.Fatalf("ls :path: %+v", r)
	}
	r = execute(t, "ls", "-s", "web", "/etc", "--json")
	var l map[string]any
	if r.code != 0 || json.Unmarshal([]byte(r.out), &l) != nil || l["path"] != "/etc" {
		t.Fatalf("json: %+v", r)
	}
	if r := execute(t, "ls", "etc"); r.code != ExitUsage {
		t.Fatalf("relative path: %+v", r)
	}
}

// A folder from a server can hold links made by whoever has access there. A link to "..", then a
// link inside it to "..", each look inside on their own; a file written through both would land
// outside the folder. Nothing may be written outside it.
func TestExtractRefusesChainedLinks(t *testing.T) {
	base := t.TempDir()
	out := filepath.Join(base, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "a/", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "a/up", Typeflag: tar.TypeSymlink, Linkname: ".."})
	tw.WriteHeader(&tar.Header{Name: "a/up/up2", Typeflag: tar.TypeSymlink, Linkname: ".."})
	tw.WriteHeader(&tar.Header{Name: "a/up/up2/escaped.txt", Typeflag: tar.TypeReg, Mode: 0o644, Size: 3})
	io.WriteString(tw, "bad")
	tw.Close()
	gz.Close()
	_, err := extractTarGz(bytes.NewReader(buf.Bytes()), out, false)
	if _, statErr := os.Stat(filepath.Join(base, "escaped.txt")); statErr == nil {
		t.Fatal("a file was written outside the folder")
	}
	if err == nil {
		if _, statErr := os.Stat(filepath.Join(out, "escaped.txt")); statErr != nil {
			t.Fatalf("no error, and the file is nowhere inside either")
		}
	}
}
