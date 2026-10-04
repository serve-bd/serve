package cmd

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/serve-bd/serve/cli/internal/ui"
)

func TestNewestCLI(t *testing.T) {
	list := []ghRelease{
		{TagName: "v2.0.0"},                       // Serve's own release
		{TagName: "cli-v1.3.0", Draft: true},      // not published
		{TagName: "cli-v1.2.1", Prerelease: true}, // not for everyone
		{TagName: "cli-v1.2.0-rc.1"},              // a pre-release tag
		{TagName: "cli-v1.1.0"},
		{TagName: "cli-vnext"},
		{TagName: "cli-v1.0.0"},
	}
	if got := newestCLI(list); got != "v1.1.0" {
		t.Fatalf("newestCLI = %q, want v1.1.0", got)
	}
	if got := newestCLI([]ghRelease{{TagName: "v0.3.5"}}); got != "" {
		t.Fatalf("Serve releases only: %q", got)
	}
	// A patch for an older line cut after a newer one does not win.
	if got := newestCLI([]ghRelease{{TagName: "cli-v1.0.1"}, {TagName: "cli-v1.1.0"}}); got != "v1.1.0" {
		t.Fatalf("newestCLI = %q", got)
	}
}

func TestParseCLIVersions(t *testing.T) {
	if v, ok := parseVersion("cli-v1.2.3"); !ok || v != [3]int{1, 2, 3} {
		t.Fatalf("parseVersion(cli-v1.2.3) = %v %v", v, ok)
	}
	for in, want := range map[string]string{"cli-v1.2.3": "v1.2.3", "1.2.3": "v1.2.3", "v1.2.3": "v1.2.3", " v1.2.3-rc.1 ": "v1.2.3-rc.1"} {
		if got, ok := cleanVersion(in); !ok || got != want {
			t.Errorf("cleanVersion(%q) = %q %v", in, got, ok)
		}
	}
	for _, bad := range []string{"dev", "", "cli-", "v1.2", "latest", "v1.-2.3"} {
		if _, ok := cleanVersion(bad); ok {
			t.Errorf("cleanVersion(%q) should fail", bad)
		}
	}
	if !newerVersion("cli-v1.2.0", "v1.1.9") || newerVersion("cli-v1.2.0", "v1.2.0") || !newerVersion("cli-v1.2.0", "v1.2.0-rc.1") {
		t.Fatal("cli-v versions compare as semver")
	}
}

func TestVerifyChecksum(t *testing.T) {
	data := []byte("archive")
	sum := sha256.Sum256(data)
	good := hex.EncodeToString(sum[:]) + "  serve_1.0.0_linux_amd64.tar.gz\n"
	if err := verifyChecksum([]byte(good), "serve_1.0.0_linux_amd64.tar.gz", data); err != nil {
		t.Fatal(err)
	}
	if err := verifyChecksum([]byte(good), "serve_1.0.0_linux_amd64.tar.gz", []byte("tampered")); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("a mismatch must be refused: %v", err)
	}
	if err := verifyChecksum([]byte(good), "serve_1.0.0_darwin_arm64.tar.gz", data); err == nil || !strings.Contains(err.Error(), "no line") {
		t.Fatalf("a missing line must be refused: %v", err)
	}
}

func TestReplaceExecutable(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		dir := t.TempDir()
		exe := filepath.Join(dir, "serve")
		if err := os.WriteFile(exe, []byte("old"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := replaceExecutable(exe, []byte("new"), goos); err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		b, _ := os.ReadFile(exe)
		st, _ := os.Stat(exe)
		if string(b) != "new" {
			t.Fatalf("%s: got %q", goos, b)
		}
		if runtime.GOOS != "windows" && st.Mode().Perm() != 0o755 {
			t.Fatalf("%s: mode %v", goos, st.Mode())
		}
		old, err := os.ReadFile(exe + ".old")
		if goos == "windows" && string(old) != "old" {
			t.Fatalf("windows keeps the running exe as .old: %q %v", old, err)
		}
		if goos == "linux" && err == nil {
			t.Fatal("no .old file elsewhere")
		}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".serve-upgrade-") {
				t.Fatalf("%s: temporary file left: %s", goos, e.Name())
			}
		}
	}
}

func TestExtractBinary(t *testing.T) {
	if b, err := extractBinary(makeArchive(t, "serve_1.1.0_linux_amd64.tar.gz", "bin"), "serve_1.1.0_linux_amd64.tar.gz"); err != nil || string(b) != "bin" {
		t.Fatalf("tar.gz: %q %v", b, err)
	}
	if b, err := extractBinary(makeArchive(t, "serve_1.1.0_windows_amd64.zip", "exe"), "serve_1.1.0_windows_amd64.zip"); err != nil || string(b) != "exe" {
		t.Fatalf("zip: %q %v", b, err)
	}
}

// makeArchive builds a release archive the way the release workflow does.
func makeArchive(t *testing.T, name, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	if strings.HasSuffix(name, ".zip") {
		folder := strings.TrimSuffix(name, ".zip")
		zw := zip.NewWriter(&buf)
		w, _ := zw.Create(folder + "/README.md")
		w.Write([]byte("readme"))
		w, _ = zw.Create(folder + "/serve.exe")
		w.Write([]byte(content))
		zw.Close()
		return buf.Bytes()
	}
	folder := strings.TrimSuffix(name, ".tar.gz")
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: folder + "/", Typeflag: tar.TypeDir, Mode: 0o755})
	for _, f := range []struct{ name, body string }{{"README.md", "readme"}, {"serve", content}} {
		tw.WriteHeader(&tar.Header{Name: folder + "/" + f.name, Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(f.body))})
		tw.Write([]byte(f.body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// fakeGitHub serves a release list and the archives of cli-v1.1.0.
type fakeGitHub struct {
	listHits    atomic.Int32
	badChecksum bool
	delay       time.Duration
}

func (g *fakeGitHub) start(t *testing.T) {
	t.Helper()
	name := assetName("v1.1.0", runtime.GOOS, runtime.GOARCH)
	archive := makeArchive(t, name, "new serve")
	sum := sha256.Sum256(archive)
	mux := http.NewServeMux()
	mux.HandleFunc("/releases", func(w http.ResponseWriter, r *http.Request) {
		g.listHits.Add(1)
		time.Sleep(g.delay)
		w.Write([]byte(`[{"tag_name":"v0.4.0"},{"tag_name":"cli-v1.2.0","prerelease":true},{"tag_name":"cli-v1.1.0"},{"tag_name":"cli-v1.0.0"}]`))
	})
	mux.HandleFunc("/download/cli-v1.1.0/"+name, func(w http.ResponseWriter, r *http.Request) { w.Write(archive) })
	mux.HandleFunc("/download/cli-v1.1.0/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		s := hex.EncodeToString(sum[:])
		if g.badChecksum {
			s = strings.Repeat("0", 64)
		}
		w.Write([]byte(s + "  " + name + "\n"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	oldR, oldD, oldE := ReleasesURL, DownloadURL, executablePath
	ReleasesURL, DownloadURL = srv.URL+"/releases", srv.URL+"/download"
	t.Cleanup(func() { ReleasesURL, DownloadURL, executablePath = oldR, oldD, oldE })
}

func fakeExecutable(t *testing.T) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "serve")
	if err := os.WriteFile(exe, []byte("old serve"), 0o755); err != nil {
		t.Fatal(err)
	}
	executablePath = func() (string, error) { return exe, nil }
	return exe
}

func TestUpgrade(t *testing.T) {
	setup(t)
	g := &fakeGitHub{}
	g.start(t)
	exe := fakeExecutable(t)

	r := execute(t, "upgrade", "--check")
	if r.code != 0 || !strings.Contains(r.errout, "v1.1.0 is out") {
		t.Fatalf("--check: %+v", r)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old serve" {
		t.Fatal("--check must not change the binary")
	}

	r = execute(t, "upgrade")
	if r.code != 0 || !strings.Contains(r.errout, "Upgraded serve from v1.0.0 to") || !strings.Contains(r.errout, "v1.1.0") {
		t.Fatalf("upgrade: %+v", r)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new serve" {
		t.Fatalf("binary not replaced: %q", b)
	}
}

func TestUpgradeAlreadyNewest(t *testing.T) {
	setup(t)
	(&fakeGitHub{}).start(t)
	exe := fakeExecutable(t)
	var errout bytes.Buffer
	r := executeAs(t, "v1.1.0", &errout, "upgrade")
	if r != 0 || !strings.Contains(errout.String(), "newest version") {
		t.Fatalf("already newest: %d %q", r, errout.String())
	}
	if b, _ := os.ReadFile(exe); string(b) != "old serve" {
		t.Fatal("nothing should change")
	}
}

func TestUpgradeRefusesBadChecksum(t *testing.T) {
	setup(t)
	(&fakeGitHub{badChecksum: true}).start(t)
	exe := fakeExecutable(t)
	r := execute(t, "upgrade")
	if r.code == 0 || !strings.Contains(r.errout, "does not match its checksum") {
		t.Fatalf("bad checksum: %+v", r)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old serve" {
		t.Fatal("a bad download must not replace the binary")
	}
}

func TestUpgradeDevBuildAndVersions(t *testing.T) {
	setup(t)
	(&fakeGitHub{}).start(t)
	exe := fakeExecutable(t)
	var errout bytes.Buffer
	if code := executeAs(t, "dev", &errout, "upgrade"); code == 0 || !strings.Contains(errout.String(), "development build") {
		t.Fatalf("dev build: %d %q", code, errout.String())
	}
	errout.Reset()
	if code := executeAs(t, "dev", &errout, "upgrade", "--force", "--version", "cli-v1.1.0"); code != 0 {
		t.Fatalf("dev --force: %d %q", code, errout.String())
	}
	if b, _ := os.ReadFile(exe); string(b) != "new serve" {
		t.Fatalf("binary not replaced: %q", b)
	}
	if r := execute(t, "upgrade", "--version", "nope"); r.code != ExitUsage {
		t.Fatalf("bad --version: %+v", r)
	}
	if r := execute(t, "upgrade", "--version", "v9.9.9"); r.code == 0 || !strings.Contains(r.errout, "there is no serve v9.9.9") {
		t.Fatalf("missing version: %+v", r)
	}
}

func TestUpgradeNotWritable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a folder this user cannot write")
	}
	setup(t)
	(&fakeGitHub{}).start(t)
	exe := fakeExecutable(t)
	dir := filepath.Dir(exe)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	r := execute(t, "upgrade")
	if r.code == 0 || !strings.Contains(r.errout, "sudo serve upgrade") {
		t.Fatalf("not writable: %+v", r)
	}
}

// executeAs runs the CLI as a build of the given version.
func executeAs(t *testing.T, version string, errout *bytes.Buffer, args ...string) int {
	t.Helper()
	var out bytes.Buffer
	ui.Out, ui.Err = &out, errout
	defer func() { ui.Out, ui.Err = os.Stdout, os.Stderr }()
	return Execute(Build{Version: version}, args)
}

func TestUpdateNotice(t *testing.T) {
	setup(t)
	g := &fakeGitHub{}
	g.start(t)
	t.Setenv("SERVE_NO_UPDATE_CHECK", "")
	t.Setenv("CI", "")
	oldTTY := stderrIsTerminal
	t.Cleanup(func() { stderrIsTerminal = oldTTY })
	tty := true
	stderrIsTerminal = func() bool { return tty }

	// "status" fails (not logged in); the notice is shown anyway.
	writeUpdateCache(updateCache{CheckedAt: time.Now(), Latest: "v1.1.0"})
	notice := "serve v1.1.0 is out (you have v1.0.0). Run: serve upgrade"
	if r := execute(t, "status"); !strings.Contains(r.errout, notice) {
		t.Fatalf("notice missing: %+v", r)
	}
	if g.listHits.Load() != 0 {
		t.Fatal("a fresh cache must not ask GitHub")
	}

	silent := []struct {
		name  string
		setup func()
		args  []string
	}{
		{"no terminal", func() { tty = false }, []string{"status"}},
		{"--json", func() {}, []string{"status", "--json"}},
		{"CI", func() { t.Setenv("CI", "true") }, []string{"status"}},
		{"opted out", func() { t.Setenv("SERVE_NO_UPDATE_CHECK", "1") }, []string{"status"}},
		{"logs -f", func() {}, []string{"logs", "-f"}},
		{"other command", func() {}, []string{"projects"}},
	}
	for _, c := range silent {
		tty = true
		t.Setenv("CI", "")
		t.Setenv("SERVE_NO_UPDATE_CHECK", "")
		c.setup()
		if r := execute(t, c.args...); strings.Contains(r.errout, "serve upgrade") {
			t.Errorf("%s: notice shown: %q", c.name, r.errout)
		}
	}
	tty = true
	t.Setenv("CI", "")
	t.Setenv("SERVE_NO_UPDATE_CHECK", "")

	// A dev build never sees it.
	var errout bytes.Buffer
	executeAs(t, "dev", &errout, "status")
	if strings.Contains(errout.String(), "serve upgrade") {
		t.Fatalf("dev build: %q", errout.String())
	}

	// A stale cache is refreshed in the background, and a slow GitHub does not hold the command.
	writeUpdateCache(updateCache{CheckedAt: time.Now().Add(-48 * time.Hour), Latest: "v1.0.5"})
	g.delay = time.Second
	start := time.Now()
	r := execute(t, "status")
	if time.Since(start) > 800*time.Millisecond {
		t.Fatalf("the notice slowed the command: %v", time.Since(start))
	}
	if !strings.Contains(r.errout, "serve v1.0.5 is out") {
		t.Fatalf("the remembered answer should show while GitHub is slow: %q", r.errout)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if c, fresh := readUpdateCache(); fresh && c.Latest == "v1.1.0" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the background check did not refresh the cache")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
