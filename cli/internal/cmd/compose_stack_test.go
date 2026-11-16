package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func stackDir(t *testing.T, files map[string]string) *stackDoc {
	t.Helper()
	dir := t.TempDir()
	for name, text := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	d, err := readStack(filepath.Join(dir, StackFile))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestStackValuesSendOnlyWhatTheFileNames(t *testing.T) {
	d := stackDir(t, map[string]string{StackFile: "services:\n  a: { image: 'x:${A}', env: { B: '${B:-x}', C: '${C}' } }\n", ".env": "A=from-file\nB=from-file\nSECRET=never\n"})
	t.Setenv("B", "from-shell")
	t.Setenv("OTHER", "never")
	// The server asks for more than the file names: those are never read.
	got, err := d.values([]string{"A", "B", "C", "OTHER", "SECRET"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["A"] != "from-file" || got["B"] != "from-shell" {
		t.Fatalf("values: %v", got)
	}
}

func TestStackPathsStayInsideTheFolder(t *testing.T) {
	d := stackDir(t, map[string]string{StackFile: "services: {}\n", ".env.web": "A=1\n", "web/Dockerfile": "FROM x\n"})
	if p, err := d.local("./web"); err != nil || !strings.HasSuffix(p, "web") {
		t.Fatalf("inside: %q %v", p, err)
	}
	if _, err := d.local(".env.web"); err != nil {
		t.Fatalf("env file: %v", err)
	}
	for _, bad := range []string{"../x", "/etc/passwd", "web/../../x", ".."} {
		if _, err := d.local(bad); err == nil || !strings.Contains(err.Error(), "outside") {
			t.Fatalf("%s: %v", bad, err)
		}
	}
	// A symlink that leaves the folder is refused, whatever its name says.
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(d.dir, "innocent.env")); err != nil {
		t.Skip("no symlinks here")
	}
	if _, err := d.local("innocent.env"); err == nil || !strings.Contains(err.Error(), "leads outside") {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := d.local("missing.env"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing: %v", err)
	}
}

func TestStackName(t *testing.T) {
	d := stackDir(t, map[string]string{StackFile: "# shop\nname: 'my-shop' # the shop\nservices: {}\n"})
	if d.name() != "my-shop" {
		t.Fatalf("name line: %q", d.name())
	}
	d = &stackDoc{dir: "/x/My Shop!", text: "services: {}\n"}
	if d.name() != "My-Shop" {
		t.Fatalf("folder: %q", d.name())
	}
}

func TestReadStackFindsYamlSpelling(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if _, err := readStack(""); err == nil || !strings.Contains(err.Error(), "no serve-compose.yml") {
		t.Fatalf("missing: %v", err)
	}
	if err := os.WriteFile("serve-compose.yaml", []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := readStack("")
	if err != nil || filepath.Base(d.path) != "serve-compose.yaml" {
		t.Fatalf("yaml: %v %v", d, err)
	}
}

func TestStackFilesOnlyThoseTheFileNames(t *testing.T) {
	d := stackDir(t, map[string]string{StackFile: "# values come from .env\nservices:\n  web:\n    image: nginx\n    env_file: [./.env.web, \"conf/a.env\"]\n  tools:\n    compose: tools.yml # here\n  site:\n    build: ./site\n  api:\n    build: { context: ./api/, builder: dockerfile }\n"})
	refs, err := d.refs()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{".env.web", "conf/a.env", "tools.yml"} {
		if !refs.files[p] {
			t.Fatalf("%s should be named", p)
		}
	}
	for _, p := range []string{".env", "nginx", ".git/config", "site"} {
		if refs.files[p] {
			t.Fatalf("%s is not an env or compose file of the stack", p)
		}
	}
	if !refs.folders["site"] || !refs.folders["api"] || refs.folders[".ssh"] || len(refs.folders) != 2 {
		t.Fatalf("folders: %v", refs.folders)
	}
}

func TestStackNameFilledInIsNotGuessed(t *testing.T) {
	d := &stackDoc{dir: "/x/shop", text: "name: ${STACK}\nservices: {}\n"}
	if d.name() != "" {
		t.Fatalf("name: %q", d.name())
	}
}

func TestExportFileNamesAndWrites(t *testing.T) {
	for _, ok := range []string{"serve-compose.yml", ".env.web", "web.compose.yml"} {
		if !safeFileName(ok) {
			t.Fatalf("%s should be fine", ok)
		}
	}
	for _, bad := range []string{"../x", "a/b", "C:x", "CON", "con.txt", "..", ".", "a b"} {
		if safeFileName(bad) {
			t.Fatalf("%s should be refused", bad)
		}
	}
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(outside, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, ".env.web")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("no symlinks here")
	}
	if err := writeReplacing(link, []byte("A=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(outside); string(b) != "keep" {
		t.Fatal("wrote through the symlink")
	}
	if st, err := os.Lstat(link); err != nil || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm() != 0o600 {
		t.Fatalf("replaced file: %v %v", st.Mode(), err)
	}
}
