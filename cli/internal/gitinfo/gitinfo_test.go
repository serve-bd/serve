package gitinfo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseStatus(t *testing.T) {
	clean := "# branch.oid 1a2b3c4d5e6f\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"
	if got := ParseStatus(clean); got.Commit != "1a2b3c4d5e6f" || got.Branch != "main" || got.Dirty {
		t.Fatalf("clean: %+v", got)
	}
	dirty := "# branch.oid abc\n# branch.head feature/x\n1 .M N... 100644 100644 100644 a b src/app.go\n? new.txt\n"
	if got := ParseStatus(dirty); got.Branch != "feature/x" || !got.Dirty {
		t.Fatalf("dirty: %+v", got)
	}
	if got := ParseStatus("# branch.oid (initial)\n# branch.head main\n"); got.Commit != "" {
		t.Fatalf("a repository without commits has no commit: %+v", got)
	}
	if got := ParseStatus("# branch.oid abc\n# branch.head (detached)\n"); got.Branch != "" || got.Commit != "abc" {
		t.Fatalf("detached: %+v", got)
	}
	if Short("1234567890") != "1234567" || Short("abc") != "abc" {
		t.Fatal("short")
	}
}

func TestRead(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	if Read(dir) != nil {
		t.Fatal("a plain folder has no git info")
	}
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_GLOBAL=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "trunk")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	run("add", ".")
	run("commit", "-q", "-m", "First commit\n\nbody")
	info := Read(dir)
	if info == nil || len(info.Commit) != 40 || info.Branch != "trunk" || info.Subject != "First commit" || info.Dirty {
		t.Fatalf("clean repo: %+v", info)
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("b"), 0o644)
	if info := Read(dir); !info.Dirty {
		t.Fatal("a changed file makes it dirty")
	}
}

func TestNoCommitsAndWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	env := append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_GLOBAL=/dev/null")
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	dir := t.TempDir()
	run(dir, "init", "-q", "-b", "main")
	if info := Read(dir); info == nil || info.Commit != "" || info.Branch != "main" {
		t.Fatalf("no commits yet: %+v", info)
	}
	os.WriteFile(filepath.Join(dir, "a"), []byte("a"), 0o644)
	run(dir, "add", ".")
	run(dir, "commit", "-qm", "one")
	wt := filepath.Join(t.TempDir(), "wt")
	run(dir, "worktree", "add", "-q", "--detach", wt)
	info := Read(wt)
	if info == nil || len(info.Commit) != 40 || info.Branch != "" || info.Dirty {
		t.Fatalf("detached worktree (.git is a file): %+v", info)
	}
}

func TestIsSha(t *testing.T) {
	if !IsSha("1a2b") || !IsSha(strings.Repeat("f", 64)) || IsSha("abc") || IsSha("zzzzzz") || IsSha(strings.Repeat("a", 65)) {
		t.Fatal("IsSha")
	}
}
