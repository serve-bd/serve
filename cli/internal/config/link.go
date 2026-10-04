package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Link ties a project folder to a service: .serve/project.json.
type Link struct {
	URL             string `json:"url"`
	ProjectID       string `json:"projectId"`
	ProjectName     string `json:"projectName,omitempty"`
	EnvironmentID   string `json:"environmentId"`
	EnvironmentName string `json:"environmentName,omitempty"`
	ServiceID       string `json:"serviceId"`
	ServiceName     string `json:"serviceName,omitempty"`
	OrgID           string `json:"organizationId,omitempty"`
	OrgName         string `json:"organizationName,omitempty"`
	// OneOffOK is set once the user agreed that uploads to a git app are one-off deploys.
	OneOffOK bool `json:"oneOffOk,omitempty"`

	// Dir is the project folder that holds .serve.
	Dir string `json:"-"`
}

const LinkDir = ".serve"

func linkPath(dir string) string { return filepath.Join(dir, LinkDir, "project.json") }

// ReadLink reads the link of exactly this folder.
func ReadLink(dir string) (*Link, error) {
	b, err := os.ReadFile(linkPath(dir))
	if err != nil {
		return nil, err
	}
	l := &Link{}
	if err := json.Unmarshal(b, l); err != nil {
		return nil, errors.New(linkPath(dir) + " is not valid JSON. Run `serve link` again")
	}
	l.Dir = dir
	return l, nil
}

// FindLink looks for a link in dir and then its parents, like git looks for .git. Nil when none.
func FindLink(dir string) *Link {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil
	}
	start := dir
	home, _ := os.UserHomeDir()
	for {
		// A link in the home folder counts there only: one made there by accident must not link
		// every folder inside it.
		if dir != start && home != "" && dir == filepath.Clean(home) {
			return nil
		}
		if l, err := ReadLink(dir); err == nil {
			return l
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil
		}
		dir = parent
	}
}

// Save writes the link back to its folder.
func (l *Link) Save() error {
	_, err := WriteLink(l.Dir, l)
	return err
}

// WriteLink saves the link in dir/.serve and, in a git repository, adds .serve/ to .gitignore.
// It answers whether .gitignore was changed.
func WriteLink(dir string, l *Link) (bool, error) {
	if err := os.MkdirAll(filepath.Join(dir, LinkDir), 0o755); err != nil {
		return false, err
	}
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return false, err
	}
	if err := os.WriteFile(linkPath(dir), append(b, '\n'), 0o644); err != nil {
		return false, err
	}
	l.Dir = dir
	return ignoreLinkDir(dir)
}

// RemoveLink deletes the link file (and .serve when it is then empty).
func RemoveLink(dir string) error {
	if err := os.Remove(linkPath(dir)); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(dir, LinkDir))
	return nil
}

func ignoreLinkDir(dir string) (bool, error) {
	if !inGitRepo(dir) {
		return false, nil
	}
	path := filepath.Join(dir, ".gitignore")
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		switch strings.TrimSpace(line) {
		case ".serve", ".serve/", "/.serve", "/.serve/":
			return false, nil
		}
	}
	text := string(b)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += ".serve/\n"
	return true, os.WriteFile(path, []byte(text), 0o644)
}

func inGitRepo(dir string) bool {
	dir, _ = filepath.Abs(dir)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}
