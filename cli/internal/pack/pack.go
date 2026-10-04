// Package pack walks a project folder, leaves out what the ignore files name, and writes the
// rest as a .tar.gz for an upload deploy.
package pack

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type Options struct {
	// IncludeEnv keeps .env files, which are left out by default.
	IncludeEnv bool
	// GlobalExcludes is the user's global git ignore file (core.excludesfile), if any.
	GlobalExcludes string
	// IgnoreCase matches the git rules without regard to case (git's core.ignorecase).
	IgnoreCase bool
}

// File is one entry of the archive.
type File struct {
	Rel     string // slash separated, relative to the root
	Size    int64
	Mode    fs.FileMode
	ModTime time.Time
	Link    string // symlink target, relative and inside the folder
}

type Result struct {
	Root  string
	Files []File // files, symlinks and folders, in walk order
	Count int    // files and symlinks
	Size  int64  // bytes of the files
	// SkippedEnv lists the .env files left out.
	SkippedEnv []string
	// SkippedLinks lists symlinks left out because they point outside the folder.
	SkippedLinks []string
	// Unreadable lists files and folders left out because they cannot be read.
	Unreadable []string
	// Rules names the ignore files that were used, like ".gitignore (2 files)".
	Rules []string
	// BadRules lists ignore lines that could not be read as a pattern ("file: line").
	BadRules []string
}

// alwaysSkipped are left out wherever they are. .git may also be a file (worktrees, submodules).
var alwaysSkipped = map[string]bool{".git": true, ".serve": true, "node_modules": true}

// IsEnvFile is true for .env, .env.local, .env-production, .envrc, production.env and the like.
func IsEnvFile(name string) bool {
	n := strings.ToLower(name)
	return n == ".env" || n == ".envrc" || strings.HasPrefix(n, ".env.") || strings.HasPrefix(n, ".env-") || strings.HasSuffix(n, ".env")
}

// alwaysKept files are needed by a Docker build even when .dockerignore names them.
func alwaysKept(name string) bool {
	lower := strings.ToLower(name)
	return lower == ".dockerignore" || lower == "dockerfile" || strings.HasPrefix(lower, "dockerfile.") || strings.HasSuffix(lower, ".dockerfile")
}

// markers are files that show a folder is a project.
var markers = []string{
	"package.json", "Dockerfile", "dockerfile", "go.mod", "requirements.txt", "pyproject.toml", "Pipfile", "setup.py",
	"index.html", "Gemfile", "composer.json", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
	"deno.json", "deno.jsonc", "bun.lockb", "mix.exs", "Procfile", "nixpacks.toml", "railpack.json",
	"project.json", "pubspec.yaml", "Package.swift", "CMakeLists.txt", "Makefile", "docker-compose.yml", "compose.yml",
}

// HasProjectMarker says whether dir holds a file that a build would start from.
func HasProjectMarker(dir string) bool {
	for _, m := range markers {
		if _, err := os.Stat(filepath.Join(dir, m)); err == nil {
			return true
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".csproj") || strings.HasSuffix(e.Name(), ".sln") {
			return true
		}
	}
	return false
}

// Scan walks root and lists what goes into the archive. With a .serveignore in root, the
// .serveignore files replace the git rules (so build output git ignores can be sent); otherwise
// the git rules apply: every .gitignore from the repository root (which may be above root) down,
// .git/info/exclude and the global git ignore file. .dockerignore applies on top in both cases.
func Scan(root string, opts Options) (*Result, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", root)
	}
	res := &Result{Root: root}
	w := &walker{root: root, opts: opts, res: res, m: &Matcher{}}
	if _, err := os.Stat(filepath.Join(root, ".serveignore")); err == nil {
		w.serveMode = true
	} else {
		if opts.GlobalExcludes != "" {
			if r := w.load(opts.GlobalExcludes, "", "global git ignore"); len(r) > 0 {
				res.Rules = append(res.Rules, "global git ignore")
			}
		}
		if top, gitDir := repoRoot(root); top != "" {
			if r := w.load(filepath.Join(gitDir, "info", "exclude"), "", ".git/info/exclude"); len(r) > 0 {
				res.Rules = append(res.Rules, ".git/info/exclude")
			}
			// The .gitignore files of the folders between the repository root and root.
			rel, _ := filepath.Rel(top, root)
			if rel = filepath.ToSlash(rel); rel != "." {
				w.m.prefix = rel
				parts := strings.Split(rel, "/")
				for i := range parts {
					dir := strings.Join(parts[:i], "/")
					file := filepath.Join(top, filepath.FromSlash(dir), ".gitignore")
					if r := w.load(file, dir, path.Join(dir, ".gitignore")); r != nil {
						w.gitFiles++
					}
				}
			}
		}
	}
	if f, err := os.Open(filepath.Join(root, ".dockerignore")); err == nil {
		var bad []string
		w.m.docker, bad = parseIgnore(f, "", true, false)
		res.BadRules = append(res.BadRules, badRules(".dockerignore", bad)...)
		f.Close()
	}
	if err := w.walk("", false); err != nil {
		return nil, err
	}
	name, n := ".gitignore", w.gitFiles
	if w.serveMode {
		name, n = ".serveignore", w.serveFiles
	}
	if n == 1 {
		res.Rules = append(res.Rules, name)
	} else if n > 1 {
		res.Rules = append(res.Rules, fmt.Sprintf("%s (%d files)", name, n))
	}
	if w.m.docker != nil {
		res.Rules = append(res.Rules, ".dockerignore")
	}
	return res, nil
}

// repoRoot answers the root of the git repository that holds dir and its git folder, or "".
// .git may be a file (worktrees, submodules) naming the git folder; a worktree keeps
// info/exclude in the common folder.
func repoRoot(dir string) (top, gitDir string) {
	for {
		g := filepath.Join(dir, ".git")
		if info, err := os.Stat(g); err == nil {
			if info.IsDir() {
				return dir, g
			}
			if b, err := os.ReadFile(g); err == nil {
				if d, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:"); ok {
					d = strings.TrimSpace(d)
					if !filepath.IsAbs(d) {
						d = filepath.Join(dir, d)
					}
					if c, err := os.ReadFile(filepath.Join(d, "commondir")); err == nil {
						common := strings.TrimSpace(string(c))
						if !filepath.IsAbs(common) {
							common = filepath.Join(d, common)
						}
						d = common
					}
					return dir, d
				}
			}
			return dir, g
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", ""
		}
		dir = parent
	}
}

// load adds the git-style rules of one ignore file (nil when there is none). base is the
// file's folder relative to the root its rules are matched against; name is how it is reported.
func (w *walker) load(file, base, name string) []rule {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	r, bad := parseIgnore(f, base, false, w.opts.IgnoreCase && !w.serveMode)
	w.res.BadRules = append(w.res.BadRules, badRules(name, bad)...)
	if r == nil {
		r = []rule{}
	}
	w.m.git = append(w.m.git, r...)
	return r
}

type walker struct {
	root                 string
	opts                 Options
	res                  *Result
	m                    *Matcher
	serveMode            bool
	gitFiles, serveFiles int
}

func (w *walker) walk(rel string, inIgnored bool) error {
	dir := filepath.Join(w.root, filepath.FromSlash(rel))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if rel == "" {
			return fmt.Errorf("cannot read %s: %w", dir, err)
		}
		w.res.Unreadable = append(w.res.Unreadable, rel+"/")
		return nil
	}
	m := w.m
	if w.serveMode {
		if w.load(filepath.Join(dir, ".serveignore"), rel, path.Join(rel, ".serveignore")) != nil {
			w.serveFiles++
		}
	} else if w.load(filepath.Join(dir, ".gitignore"), path.Join(m.prefix, rel), path.Join(rel, ".gitignore")) != nil {
		w.gitFiles++
	}

	for _, e := range entries {
		name := e.Name()
		p := name
		if rel != "" {
			p = rel + "/" + name
		}
		if alwaysSkipped[name] {
			continue
		}
		t := e.Type()
		isDir := t.IsDir()
		if !isDir && IsEnvFile(name) && !w.opts.IncludeEnv {
			if !inIgnored && !m.Ignored(p, false) {
				w.res.SkippedEnv = append(w.res.SkippedEnv, p)
			}
			continue
		}
		gitIgnored, dockerIgnored := m.gates(p, isDir)
		if !isDir && !inIgnored && alwaysKept(name) {
			gitIgnored, dockerIgnored = false, false
		}
		ignored := gitIgnored || dockerIgnored
		if isDir {
			// Nothing inside a folder git ignores can come back. Inside one only .dockerignore
			// leaves out, a docker negation can bring something back, so it is walked.
			if gitIgnored || (dockerIgnored && !m.MayReinclude()) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				w.res.Unreadable = append(w.res.Unreadable, p+"/")
				continue
			}
			if !ignored {
				w.res.Files = append(w.res.Files, File{Rel: p, Mode: fs.ModeDir | dirPerm(info.Mode()), ModTime: info.ModTime()})
			}
			if err := w.walk(p, ignored); err != nil {
				return err
			}
			continue
		}
		if ignored {
			continue
		}
		info, err := e.Info()
		if err != nil {
			w.res.Unreadable = append(w.res.Unreadable, p)
			continue
		}
		full := filepath.Join(dir, name)
		switch {
		case t&fs.ModeSymlink != 0:
			target, ok := w.linkTarget(full)
			if !ok {
				w.res.SkippedLinks = append(w.res.SkippedLinks, p)
				continue
			}
			w.res.Files = append(w.res.Files, File{Rel: p, Mode: fs.ModeSymlink | 0o777, ModTime: info.ModTime(), Link: target})
			w.res.Count++
		case t.IsRegular():
			f, err := os.Open(full)
			if err != nil {
				w.res.Unreadable = append(w.res.Unreadable, p)
				continue
			}
			mode := fileMode(info.Mode(), f, runtime.GOOS == "windows")
			f.Close()
			w.res.Files = append(w.res.Files, File{Rel: p, Size: info.Size(), Mode: mode, ModTime: info.ModTime()})
			w.res.Count++
			w.res.Size += info.Size()
		default:
			// Sockets, pipes and devices cannot go into an archive.
		}
	}
	return nil
}

// linkTarget answers the target of a symlink as a relative path, when the link stays inside
// the folder: by its text, and after resolving every link on the way. Links are never followed
// outside the folder.
func (w *walker) linkTarget(link string) (string, bool) {
	target, err := os.Readlink(link)
	if err != nil {
		return "", false
	}
	abs := target
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(filepath.Dir(link), target)
	}
	if !inside(w.root, filepath.Clean(abs)) {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(link); err == nil {
		root, rerr := filepath.EvalSymlinks(w.root)
		if rerr != nil || !inside(root, resolved) {
			return "", false
		}
	}
	rel, err := filepath.Rel(filepath.Dir(link), abs)
	if err != nil {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func dirPerm(m fs.FileMode) fs.FileMode {
	if runtime.GOOS == "windows" {
		return 0o755
	}
	return m.Perm()
}

// fileMode is the mode a file gets in the archive. POSIX modes are kept as they are. Windows
// has no executable bit, so there a file that starts with #! gets 0755 and others 0644.
func fileMode(m fs.FileMode, r io.Reader, windows bool) fs.FileMode {
	if !windows {
		return m.Perm()
	}
	head := make([]byte, 2)
	if n, _ := io.ReadFull(r, head); n == 2 && string(head) == "#!" {
		return 0o755
	}
	return 0o644
}

// Folder is a top level entry and the bytes under it.
type Folder struct {
	Path string
	Size int64
}

// Largest lists the biggest top level folders and files, biggest first.
func (r *Result) Largest(n int) []Folder {
	sizes := map[string]int64{}
	for _, f := range r.Files {
		if f.Mode.IsDir() {
			continue
		}
		top, _, nested := strings.Cut(f.Rel, "/")
		if nested {
			top += "/"
		}
		sizes[top] += f.Size
	}
	out := make([]Folder, 0, len(sizes))
	for p, s := range sizes {
		out = append(out, Folder{p, s})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Size != out[j].Size {
			return out[i].Size > out[j].Size
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// Write writes the listed entries as a gzip compressed tar to w. It stops when ctx is done.
func (r *Result) Write(ctx context.Context, w io.Writer) error {
	gz, err := gzip.NewWriterLevel(w, gzip.BestSpeed)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)
	for _, f := range r.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		h := &tar.Header{Name: f.Rel, Mode: int64(f.Mode.Perm()), ModTime: f.ModTime.Truncate(time.Second), Format: tar.FormatPAX}
		switch {
		case f.Mode.IsDir():
			h.Typeflag = tar.TypeDir
			h.Name += "/"
		case f.Mode&fs.ModeSymlink != 0:
			h.Typeflag = tar.TypeSymlink
			h.Linkname = f.Link
		default:
			h.Typeflag = tar.TypeReg
			h.Size = f.Size
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if err := copyFile(ctx, tw, filepath.Join(r.Root, filepath.FromSlash(f.Rel)), f.Size); err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// copyFile writes exactly size bytes: a file that grew or shrank since the scan is cut or
// padded, so the archive stays valid.
func copyFile(ctx context.Context, w io.Writer, file string, size int64) error {
	f, err := os.Open(file)
	if err != nil {
		return fmt.Errorf("cannot read %s: %w", file, err)
	}
	defer f.Close()
	n, err := io.Copy(w, &ctxReader{ctx, io.LimitReader(f, size)})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("cannot read %s: %w", file, err)
	}
	if n < size {
		_, err = w.Write(make([]byte, size-n))
	}
	return err
}

// ctxReader stops a long copy (a huge file) when ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// WriteTemp writes the archive to a temporary file and answers its path and size. When ctx is
// done it stops and removes the file.
func (r *Result) WriteTemp(ctx context.Context) (string, int64, error) {
	f, err := os.CreateTemp("", "serve-upload-*.tar.gz")
	if err != nil {
		return "", 0, err
	}
	if err := r.Write(ctx, f); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", 0, err
	}
	size, err := f.Seek(0, io.SeekCurrent)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", 0, err
	}
	return f.Name(), size, nil
}
