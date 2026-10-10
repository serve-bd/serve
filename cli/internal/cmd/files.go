package cmd

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Files on servers and in service containers: serve ls, serve upload, serve download.

// filePlace is where the files are: a server, or a service's container.
type filePlace struct {
	base  string // /servers/{id} or /services/{id}
	query url.Values
	label string // the server's or service's name, shown as label:/path
}

// serverRef matches "<server>:<path>" (a server name, not a Windows drive letter like C:).
var serverRef = regexp.MustCompile(`^([A-Za-z0-9._-]{2,}):(.*)$`)

// splitServerRef answers the server and path of "web-1:/etc", or ok=false.
func splitServerRef(arg string) (server, p string, ok bool) {
	m := serverRef.FindStringSubmatch(arg)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

type pickFlags struct {
	container string
	replica   int
}

func (f *pickFlags) add(cmd *cobra.Command) {
	cmd.Flags().StringVarP(&f.container, "container", "c", "", "the compose service or container `name` to use (services)")
	cmd.Flags().IntVarP(&f.replica, "replica", "r", 0, "the replica to use, by its `number` (services)")
}

func (a *App) serverPlace(ctx context.Context, name string, pick pickFlags) (*filePlace, error) {
	if pick.container != "" || pick.replica != 0 {
		return nil, usagef("--container and --replica are for a service's files, not a server's")
	}
	srv, err := a.findServer(ctx, name)
	if err != nil {
		return nil, err
	}
	return &filePlace{base: "/servers/" + api.P(srv.ID), query: url.Values{}, label: srv.Name}, nil
}

func (a *App) servicePlace(ctx context.Context, pick pickFlags) (*filePlace, error) {
	if pick.replica < 0 {
		return nil, usagef("--replica is a number from 1")
	}
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if pick.container != "" {
		q.Set("container", pick.container)
	}
	if pick.replica > 0 {
		q.Set("replica", strconv.Itoa(pick.replica))
	}
	return &filePlace{base: "/services/" + api.P(s.ID), query: q, label: s.Name}, nil
}

// remote answers the place and path of a remote argument: "<server>:<path>" for a server,
// ":<path>" for the service (-s, or the linked one). allowBare also takes an absolute path for the
// service (ls, download: their remote argument cannot be mistaken for a local one).
func (a *App) remote(ctx context.Context, arg string, pick pickFlags, allowBare bool) (*filePlace, string, error) {
	if a.service == "" {
		if name, p, ok := splitServerRef(arg); ok {
			pl, err := a.serverPlace(ctx, name, pick)
			if p == "" {
				p = "/"
			}
			return pl, p, err
		}
	}
	switch {
	case strings.HasPrefix(arg, ":"):
		arg = arg[1:]
	case arg == "":
		arg = "/"
	case !allowBare:
		return nil, "", usagef("%q is not a remote path. Write <server>:<path> for a server, or :<path> for the service", arg)
	}
	if arg == "" {
		arg = "/"
	}
	if !strings.HasPrefix(arg, "/") {
		return nil, "", usagef("%q is not a remote path. Write <server>:/path for a server, or :/path (an absolute path) for the service", arg)
	}
	pl, err := a.servicePlace(ctx, pick)
	return pl, arg, err
}

// filesErr makes a 403 say who may open files.
func filesErr(err error) error {
	return needs(err, "the Console permission (console.access); a server's files are for admins who manage it")
}

func (a *App) lsFilesCmd() *cobra.Command {
	var pick pickFlags
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "ls [<server>:<path> | :<path>]",
		Short: "List a folder on a server or in a service's container",
		Long: `List the files of a folder, like ls -l: on a server (<server>:<path>, the whole disk), or in
a running container of a service (:<path>, with --service or the linked service; the colon may
be left out of an absolute path).

Folders come first. A link shows where it points; a volume or mount of a container is marked.
A server's files are for admins who manage it, like serve ssh. A service's files need the
Console permission, like serve exec.`,
		Example: `  serve ls web-1:/etc/nginx
  serve ls web-1:                    # the top folder of web-1
  serve ls :/app                     # the linked service
  serve ls -s postgres :/var/lib/postgresql/data
  serve ls -s stack -c worker /app --json`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			arg := ""
			if len(args) == 1 {
				arg = args[0]
			}
			pl, p, err := a.remote(ctx, arg, pick, true)
			if err != nil {
				return err
			}
			l, raw, err := a.client.ListFiles(ctx, pl.base, pl.query, p)
			if err != nil {
				return filesErr(err)
			}
			if asJSON {
				_, err := ui.Out.Write(append(raw, '\n'))
				return err
			}
			ui.Line(ui.Dim(pl.label + ":" + l.Path))
			if len(l.Entries) == 0 {
				ui.Info("The folder is empty.")
				return nil
			}
			rows := make([][]string, len(l.Entries))
			for i, e := range l.Entries {
				rows[i] = lsRow(l, e)
			}
			ui.Table([]string{"MODE", "OWNER", "GROUP", "SIZE", "MODIFIED", "NAME"}, rows)
			return nil
		},
	}
	pick.add(cmd)
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.Annotations = printsJSON
	return cmd
}

func lsRow(l *api.FileListing, e api.FileEntry) []string {
	kind := map[string]string{"dir": "d", "link": "l", "file": "-"}[e.Type]
	if kind == "" {
		kind = "?"
	}
	size := ui.Bytes(e.Size)
	if e.Type == "dir" {
		size = "-"
	}
	name := e.Name
	if e.Link != nil {
		name += " -> " + e.Link.Target
	}
	full := pathpkg.Join(l.Path, e.Name)
	for _, m := range l.Mounts {
		if m.Path == full {
			name += ui.Dim(" (" + m.Kind + " " + m.Name + ")")
		}
	}
	return []string{kind + e.Mode, e.Owner, e.Group, size, fileTime(e.Mtime), name}
}

func fileTime(ms int64) string {
	t := time.UnixMilli(ms).Local()
	if time.Since(t) > 180*24*time.Hour || t.After(time.Now().Add(24*time.Hour)) {
		return t.Format("Jan _2  2006")
	}
	return t.Format("Jan _2 15:04")
}

func (a *App) uploadCmd() *cobra.Command {
	var pick pickFlags
	var force bool
	cmd := &cobra.Command{
		Use:   "upload <local>... [<server>:<path> | :<path>]",
		Short: "Upload files to a server or into a service's container",
		Long: `Upload files and folders to a server or into a running container of a service. The remote
path is always written with a colon, like scp: <server>:<path> for a server, :<path> for the
service (--service, or the linked one). Every other argument is a local file or folder.

When the remote path is a folder (it exists, or ends with /), the files go inside it with
their own names. Otherwise it is the new name, for one file or folder. Without a remote path,
they go to /tmp/. A server's name alone (serve upload ./a.txt web-1) also means its /tmp/.

A folder is sent as one archive and unpacked there, symbolic links included. An existing
file or folder is kept unless --force: a file is then replaced (its owner and mode stay), a
folder is merged into (its other files stay).

A server's files are for admins who manage it, like serve ssh. A service's files need the
Console permission, like serve exec.`,
		Example: `  serve upload ./backup.sql web-1:/root/
  serve upload ./backup.sql web-1                # web-1:/tmp/
  serve upload ./nginx.conf web-1:/etc/nginx/nginx.conf --force
  serve upload ./public :/app/                   # into the linked service
  serve upload -s api ./seed.json :/app/data/seed.json
  serve upload -s stack -c worker ./fix.php :/var/www/`,
		Args: minArgsMsg(1, "name what to upload: serve upload <local>... <server>:<path>"),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			locals, dest, err := a.uploadArgs(ctx, args)
			if err != nil {
				return err
			}
			for _, l := range locals {
				if _, err := os.Lstat(l); err != nil {
					return fmt.Errorf("cannot upload %s: %w", l, errors.Unwrap(err))
				}
			}
			pl, p, err := a.remote(ctx, dest, pick, false)
			if err != nil {
				return err
			}
			intoFolder := strings.HasSuffix(p, "/")
			if !intoFolder {
				_, _, lerr := a.client.ListFiles(ctx, pl.base, pl.query, p)
				switch {
				case lerr == nil:
					intoFolder = true
				case api.IsStatus(lerr, http.StatusNotFound), api.IsStatus(lerr, http.StatusBadRequest):
					// Not a folder: the new name.
				default:
					return filesErr(lerr)
				}
			}
			if !intoFolder && len(locals) > 1 {
				return usagef("%s:%s is not a folder. To upload several files, name a folder (end it with /)", pl.label, p)
			}
			u := uploader{a: a, ctx: ctx, pl: pl, force: force}
			for _, l := range locals {
				target := p
				if intoFolder {
					target = pathpkg.Join(p, filepath.Base(filepath.Clean(l)))
				}
				if err := u.put(l, pathpkg.Clean(target)); err != nil {
					return err
				}
			}
			if u.skipped > 0 {
				ui.Warn("Skipped %d special file(s) (devices, sockets, pipes).", u.skipped)
			}
			return nil
		},
	}
	pick.add(cmd)
	cmd.Flags().BoolVarP(&force, "force", "f", false, "replace files that already exist, merge into folders")
	return cmd
}

// uploadArgs splits the arguments into local paths and the remote destination (":/tmp/" for the
// service when none is given). Only an argument with a colon is remote, plus one shorthand: a
// server's name alone as the last argument, without --service, when no local file has that name.
func (a *App) uploadArgs(ctx context.Context, args []string) (locals []string, dest string, err error) {
	last := args[len(args)-1]
	_, _, isServer := splitServerRef(last)
	switch {
	case strings.HasPrefix(last, ":") || (isServer && a.service == ""):
		locals, dest = args[:len(args)-1], last
	case a.service == "" && len(args) > 1 && !strings.ContainsAny(last, `/\`):
		if _, statErr := os.Lstat(last); statErr != nil {
			// Neither a local file nor a server: most likely a mistyped file name.
			if _, ferr := a.findServer(ctx, last); ferr != nil {
				return nil, "", usagef("%s is neither a local file nor a server (see `serve servers`)", last)
			}
			locals, dest = args[:len(args)-1], last+":/tmp/"
			break
		}
		// A local file of that name: is it also a server? Then the user must say which.
		if srv, ferr := a.findServer(ctx, last); ferr == nil {
			return nil, "", usagef("%s is both a local file and a server. Write %s: to upload to the server, or ./%s to upload the file", last, srv.Name, last)
		}
		locals, dest = args, ":/tmp/"
	default:
		locals, dest = args, ":/tmp/"
	}
	if len(locals) == 0 {
		return nil, "", usagef("name what to upload: serve upload <local>... <server>:<path>")
	}
	return locals, dest, nil
}

type uploader struct {
	a       *App
	ctx     context.Context
	pl      *filePlace
	force   bool
	skipped int
}

func (u *uploader) put(local, remote string) error {
	st, err := os.Lstat(local)
	if err != nil {
		return err
	}
	switch {
	case st.Mode().IsRegular():
		return u.file(local, remote, st.Size())
	case st.IsDir():
		return u.folder(local, remote)
	default:
		u.skipped++
		return nil
	}
}

func (u *uploader) file(local, remote string, size int64) error {
	f, err := os.Open(local)
	if err != nil {
		return err
	}
	defer f.Close()
	bar := ui.NewProgress(f, size, filepath.Base(local))
	err = u.a.client.UploadFile(u.ctx, u.pl.base, u.pl.query, remote, bar, size, u.force)
	bar.Done()
	if api.IsStatus(err, http.StatusConflict) && !u.force {
		return fmt.Errorf("%s:%s already exists. Pass --force to replace it", u.pl.label, remote)
	}
	if err != nil {
		return fmt.Errorf("cannot upload %s: %w", local, filesErr(err))
	}
	ui.Success("Uploaded %s → %s:%s (%s)", local, u.pl.label, remote, ui.Bytes(size))
	return nil
}

// folder sends a local folder as one .tar.gz, its entries under the remote name, which the
// server unpacks into the remote parent folder: one request, whatever the number of files.
func (u *uploader) folder(local, remote string) error {
	files, total, err := folderSize(local)
	if err != nil {
		return err
	}
	pr, pw := io.Pipe()
	bar := ui.NewProgress(nil, total, filepath.Base(local))
	skippedc := make(chan int, 1)
	go func() {
		skipped, werr := writeTarGz(pw, local, pathpkg.Base(remote), bar)
		pw.CloseWithError(werr)
		skippedc <- skipped
	}()
	err = u.a.client.UploadArchive(u.ctx, u.pl.base, u.pl.query, pathpkg.Dir(remote), pr, u.force)
	pr.CloseWithError(errors.New("the upload ended"))
	bar.Done()
	if api.IsStatus(err, http.StatusConflict) && !u.force {
		return fmt.Errorf("%s:%s already exists. Pass --force to merge into it", u.pl.label, remote)
	}
	if err != nil {
		return fmt.Errorf("cannot upload %s: %w", local, filesErr(err))
	}
	u.skipped += <-skippedc
	ui.Success("Uploaded %s → %s:%s (%d files, %s)", local, u.pl.label, remote, files, ui.Bytes(total))
	return nil
}

func folderSize(dir string) (files int, size int64, err error) {
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			info, err := d.Info()
			if err != nil {
				return err
			}
			files++
			size += info.Size()
		}
		return nil
	})
	return files, size, err
}

// writeTarGz writes dir as a .tar.gz with its entries under prefix: folders, files and symbolic
// links. Devices, sockets and pipes are skipped (counted). Bytes read from files go to bar.
func writeTarGz(w io.Writer, dir, prefix string, bar *ui.Progress) (skipped int, err error) {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		name := pathpkg.Join(prefix, filepath.ToSlash(rel))
		link := ""
		switch {
		case d.IsDir(), d.Type().IsRegular():
		case d.Type()&fs.ModeSymlink != 0:
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		default:
			skipped++
			return nil
		}
		h, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		h.Name = name
		if d.IsDir() {
			h.Name += "/"
		}
		// Owners of this machine mean nothing there: the server gives the folder's owner.
		h.Uid, h.Gid, h.Uname, h.Gname = 0, 0, "", ""
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, bar.Wrap(f))
		return err
	})
	if err != nil {
		return skipped, err
	}
	if err := tw.Close(); err != nil {
		return skipped, err
	}
	return skipped, gz.Close()
}

func (a *App) downloadCmd() *cobra.Command {
	var pick pickFlags
	var force, extract bool
	cmd := &cobra.Command{
		Use:   "download <server>:<path> | :<path> [<local>]",
		Short: "Download a file or folder from a server or a service's container",
		Long: `Download a file or folder from a server (<server>:<path>) or from a running container of a
service (:<path>, with --service or the linked service; the colon may be left out of an
absolute path). A folder arrives as a .tar.gz;
--extract unpacks it instead.

<local> is where to save it: a folder (the file keeps its name) or a new file name. Without
it, the file is saved in this folder. An existing file is kept unless --force replaces it.

A server's files are for admins who manage it, like serve ssh. A service's files need the
Console permission, like serve exec.`,
		Example: `  serve download web-1:/etc/nginx/nginx.conf
  serve download web-1:/var/log/nginx ./logs -x
  serve download :/app/storage/app.db ./backup.db    # from the linked service
  serve download -s postgres :/var/lib/postgresql/data/postgresql.conf`,
		Args: rangeArgsMsg(1, 2, "name what to download: serve download <server>:<path> [<local>]"),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			pl, p, err := a.remote(ctx, args[0], pick, true)
			if err != nil {
				return err
			}
			local := "."
			if len(args) == 2 {
				local = args[1]
			}
			res, err := a.client.OpenFile(ctx, pl.base, pl.query, p)
			if err != nil {
				return filesErr(err)
			}
			defer res.Body.Close()
			name := attachmentName(res.Header.Get("Content-Disposition"), pathpkg.Base(p))
			folder := strings.HasPrefix(res.Header.Get("Content-Type"), "application/gzip")
			bar := ui.NewProgress(res.Body, res.ContentLength, name)
			defer bar.Done()
			if extract && folder {
				if err := os.MkdirAll(local, 0o755); err != nil {
					return err
				}
				n, err := extractTarGz(bar, local, force)
				bar.Done()
				if err != nil {
					return err
				}
				ui.Success("Downloaded %s:%s into %s (%d files)", pl.label, p, local, n)
				return nil
			}
			if extract {
				ui.Warn("%s is a file, so there is nothing to extract: saving it as is.", p)
			}
			dest := local
			if st, err := os.Stat(local); err == nil && st.IsDir() {
				dest = filepath.Join(local, name)
			}
			if _, err := os.Lstat(dest); err == nil && !force {
				return fmt.Errorf("%s already exists. Pass --force to replace it", dest)
			}
			size, err := saveAtomic(dest, bar)
			bar.Done()
			if err != nil {
				return err
			}
			ui.Success("Downloaded %s:%s → %s (%s)", pl.label, p, dest, ui.Bytes(size))
			return nil
		},
	}
	pick.add(cmd)
	cmd.Flags().BoolVarP(&force, "force", "f", false, "replace local files that already exist")
	cmd.Flags().BoolVarP(&extract, "extract", "x", false, "unpack a folder instead of saving its .tar.gz")
	return cmd
}

// rangeArgsMsg is cobra.RangeArgs with a message that says what to pass.
func rangeArgsMsg(lo, hi int, msg string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < lo || len(args) > hi {
			return usagef("%s", msg)
		}
		return nil
	}
}

// attachmentName is the file name of a Content-Disposition, made safe to save here.
func attachmentName(cd, fallback string) string {
	name := fallback
	if _, params, err := mime.ParseMediaType(cd); err == nil && params["filename"] != "" {
		name = params["filename"]
	}
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if name == "." || name == ".." || name == "/" || name == "" {
		name = "download"
	}
	return name
}

// saveAtomic writes r to a temporary file next to dest, then renames it: a cut-off download leaves
// no half file behind.
func saveAtomic(dest string, r io.Reader) (int64, error) {
	tmp, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".serve-*")
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), dest)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return 0, fmt.Errorf("the download did not finish: %w", err)
	}
	return n, nil
}

// extractTarGz unpacks into dir. Every write goes through an os.Root on dir, which refuses any
// path that would leave it, links included (one link to "..", then a link inside it, cannot lead
// out). Entries with ".." or an absolute name are refused, links that point outside are skipped,
// and existing files are kept unless force.
func extractTarGz(r io.Reader, dir string, force bool) (int, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, fmt.Errorf("the download is not a .tar.gz: %w", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	tr := tar.NewReader(gz)
	files := 0
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return files, nil
		}
		if err != nil {
			return files, fmt.Errorf("the download did not finish: %w", err)
		}
		name := filepath.FromSlash(strings.TrimPrefix(h.Name, "./"))
		if name == "" || name == "." {
			continue
		}
		if !filepath.IsLocal(name) {
			return files, fmt.Errorf("refused %q: it would be written outside %s", h.Name, dir)
		}
		name = filepath.Clean(name)
		shown := filepath.Join(dir, name)
		exists := func() error {
			if _, err := root.Lstat(name); err == nil {
				if !force {
					return fmt.Errorf("%s already exists. Pass --force to replace it", shown)
				}
				if err := root.Remove(name); err != nil {
					return err
				}
			}
			return nil
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o755); err != nil {
				return files, fmt.Errorf("refused %q: %w", h.Name, err)
			}
		case tar.TypeReg:
			if err := root.MkdirAll(filepath.Dir(name), 0o755); err != nil {
				return files, fmt.Errorf("refused %q: %w", h.Name, err)
			}
			if err := exists(); err != nil {
				return files, err
			}
			if err := saveInRoot(root, name, tr, fs.FileMode(h.Mode)&0o777); err != nil {
				return files, err
			}
			files++
		case tar.TypeSymlink:
			// Only relative links that stay inside: an absolute one would mean this machine's paths.
			if filepath.IsAbs(h.Linkname) || !filepath.IsLocal(filepath.Join(filepath.Dir(name), filepath.FromSlash(h.Linkname))) {
				continue
			}
			if err := root.MkdirAll(filepath.Dir(name), 0o755); err != nil {
				return files, fmt.Errorf("refused %q: %w", h.Name, err)
			}
			if err := exists(); err != nil {
				return files, err
			}
			if err := root.Symlink(h.Linkname, name); err != nil {
				return files, err
			}
		}
	}
}

// saveInRoot writes r to a temporary file next to name inside root, then renames it: a cut-off
// download leaves no half file behind.
func saveInRoot(root *os.Root, name string, r io.Reader, mode fs.FileMode) error {
	tmp := filepath.Join(filepath.Dir(name), fmt.Sprintf(".%s.serve-%d", filepath.Base(name), os.Getpid()))
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode|0o200)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = root.Rename(tmp, name)
	}
	if err != nil {
		_ = root.Remove(tmp)
		return fmt.Errorf("the download did not finish: %w", err)
	}
	return root.Chmod(name, mode)
}
