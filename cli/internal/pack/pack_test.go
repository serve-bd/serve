package pack

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// tree writes files (path → content) under a new temp folder.
func tree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for p, content := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func fileList(r *Result) []string {
	var out []string
	for _, f := range r.Files {
		if !f.Mode.IsDir() {
			out = append(out, f.Rel)
		}
	}
	sort.Strings(out)
	return out
}

func TestGitignoreRules(t *testing.T) {
	root := tree(t, map[string]string{
		".gitignore":            "*.log\n/build\ndist/\n!keep.log\n# comment\n\ntmp*\ncache/**\n",
		"a.log":                 "x",
		"keep.log":              "x",
		"build/out.js":          "x",
		"src/build/inner.js":    "x", // /build is anchored to the root
		"dist/x.js":             "x",
		"src/dist/y.js":         "x", // dist/ matches at any level
		"src/main.go":           "x",
		"src/tmpfile":           "x",
		"cache/a/b.txt":         "x",
		"lib/.gitignore":        "secret.txt\n!*.keep\n",
		"lib/secret.txt":        "x",
		"lib/code.js":           "x",
		"other/secret.txt":      "x", // the nested rule only applies under lib/
		"node_modules/x/y.js":   "x",
		"web/node_modules/z.js": "x",
		".git/HEAD":             "x",
		".serve/project.json":   "x",
		".env":                  "SECRET=1",
		".env.local":            "SECRET=2",
		"config/.env.example":   "A=1",
	})
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".gitignore", "keep.log", "lib/.gitignore", "lib/code.js", "other/secret.txt", "src/build/inner.js", "src/main.go"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("files:\n got  %v\n want %v", got, want)
	}
	sort.Strings(res.SkippedEnv)
	if want := []string{".env", ".env.local", "config/.env.example"}; !reflect.DeepEqual(res.SkippedEnv, want) {
		t.Fatalf("skipped env: %v", res.SkippedEnv)
	}

	res, err = Scan(root, Options{IncludeEnv: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := fileList(res); !contains(got, ".env") || !contains(got, "config/.env.example") {
		t.Fatalf("--include-env should keep .env files: %v", got)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestDockerignoreAndServeignore(t *testing.T) {
	root := tree(t, map[string]string{
		".dockerignore":      "*\n!src\n!package.json\n!docs/**/*.md\nDockerfile\n",
		"Dockerfile":         "FROM scratch",
		"package.json":       "{}",
		"README.md":          "x",
		"src/index.js":       "x",
		"src/deep/a.js":      "x",
		"docs/guide/one.md":  "x",
		"docs/guide/img.png": "x",
		".serveignore":       "src/deep\n",
	})
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// .dockerignore and Dockerfile are kept for the Docker build even though * names them.
	want := []string{".dockerignore", "Dockerfile", "docs/guide/one.md", "package.json", "src/index.js"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("files:\n got  %v\n want %v", got, want)
	}
}

func TestServeignoreReplacesGitignore(t *testing.T) {
	root := tree(t, map[string]string{
		".gitignore":     "dist/\n*.log\n",
		".serveignore":   "*.log\n",
		"web/.gitignore": "build/\n",
		"web/build/a.js": "x",
		"dist/app.js":    "x",
		"debug.log":      "x",
	})
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	got := fileList(res)
	if !contains(got, "dist/app.js") || !contains(got, "web/build/a.js") || contains(got, "debug.log") {
		t.Fatalf(".serveignore should replace every .gitignore: %v", got)
	}
	if strings.Join(res.Rules, ",") != ".serveignore" {
		t.Fatalf("rules %v", res.Rules)
	}
}

func TestGlobalAndInfoExcludes(t *testing.T) {
	root := tree(t, map[string]string{
		".git/info/exclude": "secret.txt\n",
		".gitignore":        "a.tmp\n",
		"sub/.gitignore":    "b.tmp\n",
		"secret.txt":        "x",
		"notes.swp":         "x",
		"a.tmp":             "x",
		"sub/b.tmp":         "x",
		"main.go":           "x",
	})
	global := filepath.Join(t.TempDir(), "ignore")
	os.WriteFile(global, []byte("*.swp\n"), 0o644)
	res, err := Scan(root, Options{GlobalExcludes: global})
	if err != nil {
		t.Fatal(err)
	}
	if got := fileList(res); strings.Join(got, ",") != ".gitignore,main.go,sub/.gitignore" {
		t.Fatalf("files %v", got)
	}
	if strings.Join(res.Rules, ",") != "global git ignore,.git/info/exclude,.gitignore (2 files)" {
		t.Fatalf("rules %v", res.Rules)
	}
}

func TestSymlinksStayInside(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "passwd"), []byte("x"), 0o644)
	root := tree(t, map[string]string{"real/a.txt": "x", "other/b.txt": "x"})
	os.Symlink("real/a.txt", filepath.Join(root, "rel.txt"))
	os.Symlink(filepath.Join(root, "real", "a.txt"), filepath.Join(root, "abs.txt"))
	os.Symlink(filepath.Join(outside, "passwd"), filepath.Join(root, "out.txt"))
	os.Symlink("../../"+filepath.Base(outside), filepath.Join(root, "other", "up"))
	os.Symlink(outside, filepath.Join(root, "outdir"))
	// A link to a link that leaves the folder.
	os.Symlink("out.txt", filepath.Join(root, "chain.txt"))
	os.Symlink("missing.txt", filepath.Join(root, "dangling.txt"))
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	links := map[string]string{}
	for _, f := range res.Files {
		if f.Link != "" {
			links[f.Rel] = f.Link
		}
	}
	if links["rel.txt"] != "real/a.txt" || links["abs.txt"] != "real/a.txt" || links["dangling.txt"] != "missing.txt" || len(links) != 3 {
		t.Fatalf("links kept: %v", links)
	}
	sort.Strings(res.SkippedLinks)
	if strings.Join(res.SkippedLinks, ",") != "chain.txt,other/up,out.txt,outdir" {
		t.Fatalf("skipped links: %v", res.SkippedLinks)
	}
}

func TestUnreadableFilesAreSkipped(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	root := tree(t, map[string]string{"ok.txt": "x", "locked.txt": "x", "closed/in.txt": "x"})
	os.Chmod(filepath.Join(root, "locked.txt"), 0)
	os.Chmod(filepath.Join(root, "closed"), 0)
	defer os.Chmod(filepath.Join(root, "closed"), 0o755)
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(res.Unreadable)
	if strings.Join(res.Unreadable, ",") != "closed/,locked.txt" || strings.Join(fileList(res), ",") != "ok.txt" {
		t.Fatalf("unreadable %v, files %v", res.Unreadable, fileList(res))
	}
	var buf bytes.Buffer
	if err := res.Write(context.Background(), &buf); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsModes(t *testing.T) {
	if m := fileMode(0o644, strings.NewReader("#!/bin/sh\n"), true); m != 0o755 {
		t.Fatalf("shebang on Windows: %v", m)
	}
	if m := fileMode(0o666, strings.NewReader("hello"), true); m != 0o644 {
		t.Fatalf("plain file on Windows: %v", m)
	}
	if m := fileMode(0o750, strings.NewReader("hello"), false); m != 0o750 {
		t.Fatalf("POSIX modes are kept: %v", m)
	}
}

func TestProjectMarkers(t *testing.T) {
	if HasProjectMarker(tree(t, map[string]string{"notes.txt": "x"})) {
		t.Fatal("no marker")
	}
	if !HasProjectMarker(tree(t, map[string]string{"go.mod": "module x"})) || !HasProjectMarker(tree(t, map[string]string{"App.csproj": ""})) {
		t.Fatal("markers not found")
	}
}

func TestGlobs(t *testing.T) {
	cases := []struct {
		pattern, path string
		dir, want     bool
	}{
		{"*.js", "a/b/c.js", false, true},
		{"/*.js", "a/c.js", false, false},
		{"a/**/z", "a/z", true, true},
		{"a/**/z", "a/b/c/z", true, true},
		{"**/foo", "x/y/foo", false, true},
		{"foo/**", "foo/bar/baz", false, true},
		{"doc/*.txt", "doc/x/y.txt", false, false},
		{"file[0-9].txt", "file7.txt", false, true},
		{"file[!0-9].txt", "file7.txt", false, false},
		{"?.md", "a.md", false, true},
		{"logs/", "logs", false, false},
		{"logs/", "logs", true, true},
		{`\#hash`, "#hash", false, true},
	}
	for _, c := range cases {
		rules, _ := parseIgnore(strings.NewReader(c.pattern), "", false, false)
		m := &Matcher{git: rules}
		if got := m.Ignored(c.path, c.dir); got != c.want {
			t.Errorf("%q on %q (dir %v): got %v, want %v", c.pattern, c.path, c.dir, got, c.want)
		}
	}
}

func TestWriteArchive(t *testing.T) {
	root := tree(t, map[string]string{"app/main.sh": "#!/bin/sh\necho hi\n", "README.md": "hello"})
	if runtime.GOOS != "windows" {
		os.Chmod(filepath.Join(root, "app/main.sh"), 0o755)
		os.Symlink("README.md", filepath.Join(root, "link.md"))
	}
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := res.Write(context.Background(), &buf); err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	got := map[string]*tar.Header{}
	contents := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got[h.Name] = h
		b, _ := io.ReadAll(tr)
		contents[h.Name] = string(b)
	}
	if contents["README.md"] != "hello" || contents["app/main.sh"] != "#!/bin/sh\necho hi\n" {
		t.Fatalf("contents: %v", contents)
	}
	if h := got["app/"]; h == nil || h.Typeflag != tar.TypeDir {
		t.Fatalf("missing folder entry: %v", got)
	}
	if runtime.GOOS != "windows" {
		if got["app/main.sh"].Mode&0o111 == 0 {
			t.Fatal("the executable bit was lost")
		}
		if h := got["link.md"]; h == nil || h.Typeflag != tar.TypeSymlink || h.Linkname != "README.md" {
			t.Fatalf("symlink: %+v", h)
		}
	}
	if res.Count != len(contents)-1 && res.Count != len(contents)-2 {
		t.Fatalf("count %d for %d entries", res.Count, len(contents))
	}

	path, size, err := res.WriteTemp(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if info, _ := os.Stat(path); info.Size() != size || size == 0 {
		t.Fatalf("temp archive size %d vs %d", info.Size(), size)
	}
}

func TestLargest(t *testing.T) {
	root := tree(t, map[string]string{
		"big/a.bin":   strings.Repeat("x", 3000),
		"big/b/c.bin": strings.Repeat("x", 2000),
		"small/a":     "x",
		"top.txt":     strings.Repeat("x", 100),
	})
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	l := res.Largest(2)
	if len(l) != 2 || l[0].Path != "big/" || l[0].Size != 5000 || l[1].Path != "top.txt" {
		t.Fatalf("largest: %+v", l)
	}
	if res.Size != 5101 {
		t.Fatalf("size %d", res.Size)
	}
}

func TestParentGitignoreApplies(t *testing.T) {
	root := tree(t, map[string]string{
		".gitignore":               "*.pem\nsecrets.json\napps/web/local.key\ndist/\n",
		"apps/.gitignore":          "/web/notes.txt\n",
		"apps/web/package.json":    "{}",
		"apps/web/server.pem":      "KEY",
		"apps/web/secrets.json":    "{}",
		"apps/web/local.key":       "k",
		"apps/web/notes.txt":       "n",
		"apps/web/creds.txt":       "c",
		"apps/web/index.js":        "x",
		"apps/web/lib/.gitignore":  "gen/\n",
		"apps/web/lib/gen/a.js":    "x",
		"apps/web/lib/b.js":        "x",
		"apps/web/dist/index.html": "x",
		".git/info/exclude":        "creds.txt\n",
	})
	res, err := Scan(filepath.Join(root, "apps/web"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"index.js", "lib/.gitignore", "lib/b.js", "package.json"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("subfolder of a repository:\n got %v\nwant %v", got, want)
	}

	// A folder git ignores can still be deployed on its own (build output); the rule that
	// names the folder itself does not empty it.
	res, err = Scan(filepath.Join(root, "apps/web/dist"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := fileList(res); !reflect.DeepEqual(got, []string{"index.html"}) {
		t.Fatalf("ignored build folder: %v", got)
	}

	// A worktree: .git is a file naming the git folder, info/exclude is in the common folder.
	wt := tree(t, map[string]string{
		"main/.git/info/exclude":           "*.secret\n",
		"main/.git/worktrees/wt/commondir": "../..\n",
		"wt/a.secret":                      "s",
		"wt/b.js":                          "x",
	})
	os.WriteFile(filepath.Join(wt, "wt/.git"), []byte("gitdir: ../main/.git/worktrees/wt\n"), 0o644)
	res, _ = Scan(filepath.Join(wt, "wt"), Options{})
	if got := fileList(res); !reflect.DeepEqual(got, []string{"b.js"}) {
		t.Fatalf("worktree exclude: %v", got)
	}
}

func TestDockerNegationNeverOverridesGit(t *testing.T) {
	root := tree(t, map[string]string{
		".gitignore":    "*.pem\nsecret/\n",
		".dockerignore": "*\n!src\n!package.json\n!secret\n",
		"package.json":  "{}",
		"src/index.js":  "x",
		"src/key.pem":   "KEY",
		"secret/a.txt":  "s",
		"README.md":     "x",
	})
	res, _ := Scan(root, Options{})
	want := []string{".dockerignore", "package.json", "src/index.js"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	// .serveignore replaces the git rules, but .dockerignore still applies on top.
	root = tree(t, map[string]string{
		".gitignore":    "dist/\n",
		".serveignore":  "tmp/\n",
		".dockerignore": "*.log\n",
		"dist/a.js":     "x",
		"tmp/b":         "x",
		"c.log":         "x",
	})
	res, _ = Scan(root, Options{})
	want = []string{".dockerignore", ".gitignore", ".serveignore", "dist/a.js"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf(".serveignore: got %v, want %v", got, want)
	}
}

func TestIgnoreSyntaxLikeGit(t *testing.T) {
	root := tree(t, map[string]string{
		".gitignore":   "\xef\xbb\xbfsecrets.json\nkey[[:digit:]].txt\nbad[[:nope:]]\nfoo**bar\n",
		"secrets.json": "{}",
		"key1.txt":     "x",
		"keyA.txt":     "x",
		"foo/x/bar":    "x",
		"fooxbar":      "x",
		"index.js":     "x",
	})
	res, _ := Scan(root, Options{})
	want := []string{".gitignore", "foo/x/bar", "index.js", "keyA.txt"}
	if got := fileList(res); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if !reflect.DeepEqual(res.BadRules, []string{".gitignore: bad[[:nope:]]"}) {
		t.Fatalf("bad rules: %v", res.BadRules)
	}

	// core.ignorecase: git rules match without regard to case; .dockerignore does not.
	root = tree(t, map[string]string{".gitignore": "secrets.json\n", ".dockerignore": "*.LOG\n", "Secrets.JSON": "{}", "a.log": "x"})
	res, _ = Scan(root, Options{IgnoreCase: true})
	if got := fileList(res); !reflect.DeepEqual(got, []string{".dockerignore", ".gitignore", "a.log"}) {
		t.Fatalf("ignorecase: %v", got)
	}
}

func TestEnvFileNames(t *testing.T) {
	for name, want := range map[string]bool{".env": true, ".env.local": true, ".env-prod": true, ".envrc": true, "prod.env": true, ".ENV": true,
		"env.js": false, ".environment": false, "environment.ts": false} {
		if IsEnvFile(name) != want {
			t.Errorf("IsEnvFile(%q) = %v", name, !want)
		}
	}
}

func TestWriteStopsWhenCancelled(t *testing.T) {
	root := tree(t, map[string]string{"a.bin": strings.Repeat("x", 1<<20), "b.bin": "x"})
	res, err := Scan(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := res.Write(ctx, io.Discard); err != context.Canceled {
		t.Fatalf("write after cancel: %v", err)
	}
	before, _ := filepath.Glob(filepath.Join(os.TempDir(), "serve-upload-*.tar.gz"))
	if _, _, err := res.WriteTemp(ctx); err == nil {
		t.Fatal("WriteTemp should stop")
	}
	if after, _ := filepath.Glob(filepath.Join(os.TempDir(), "serve-upload-*.tar.gz")); len(after) > len(before) {
		t.Fatal("the temporary archive was left behind")
	}
}
