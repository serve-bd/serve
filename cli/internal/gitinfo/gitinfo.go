// Package gitinfo reads the commit, branch, subject and local changes of a git checkout.
package gitinfo

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Info struct {
	Commit  string `json:"commit,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Subject string `json:"subject,omitempty"`
	Dirty   bool   `json:"dirty"`
}

// Timeout bounds every git command: a huge or broken repository must not hang a deploy.
var Timeout = 5 * time.Second

func git(dir string, args ...string) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	// Never ask for a password or open an editor.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	return string(out), err
}

// Read answers nil when dir is not in a git repository, git is not installed, or git fails
// or takes too long. A repository without commits gives no commit; a detached HEAD no branch.
// Shallow clones, worktrees and submodules (where .git is a file) work as usual.
func Read(dir string) *Info {
	out, err := git(dir, "status", "--porcelain=v2", "--branch")
	if err != nil {
		return nil
	}
	info := ParseStatus(out)
	if info.Commit != "" {
		if subj, err := git(dir, "log", "-1", "--format=%s"); err == nil {
			info.Subject = strings.TrimSpace(subj)
		}
	}
	return info
}

// ExcludesFile is the user's global git ignore file: core.excludesfile, else
// $XDG_CONFIG_HOME/git/ignore (or ~/.config/git/ignore). "" when there is none.
func ExcludesFile(dir string) string {
	p := ""
	if out, err := git(dir, "config", "--path", "--get", "core.excludesfile"); err == nil {
		p = strings.TrimSpace(out)
	}
	if p == "" {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			base = filepath.Join(home, ".config")
		}
		p = filepath.Join(base, "git", "ignore")
	}
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[2:])
		}
	}
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// IgnoreCase says whether git matches ignore rules without regard to case in dir's repository
// (core.ignorecase, set on macOS and Windows).
func IgnoreCase(dir string) bool {
	out, err := git(dir, "config", "--bool", "--get", "core.ignorecase")
	return err == nil && strings.TrimSpace(out) == "true"
}

// IsSha says whether s is a commit hash (the server takes 4 to 64 hex characters).
func IsSha(s string) bool {
	if len(s) < 4 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// ParseStatus reads the output of `git status --porcelain=v2 --branch`.
func ParseStatus(out string) *Info {
	info := &Info{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if rest, ok := strings.CutPrefix(line, "# branch.oid "); ok {
			if rest != "(initial)" {
				info.Commit = rest
			}
			continue
		}
		if rest, ok := strings.CutPrefix(line, "# branch.head "); ok {
			if rest != "(detached)" {
				info.Branch = rest
			}
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		// 1, 2 (changed), u (unmerged) and ? (untracked) lines are local changes.
		info.Dirty = true
	}
	return info
}

// Short is the first 7 characters of a commit.
func Short(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
