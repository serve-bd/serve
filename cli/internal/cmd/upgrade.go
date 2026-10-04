package cmd

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

const installScript = "curl -fsSL https://serve.bd/cli.sh | sh"

// maxBinary caps the size of a download and of the binary in it.
const maxBinary = 256 << 20

// executablePath answers the running binary, symlinks resolved. Overridden in tests.
var executablePath = func() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

func (a *App) upgradeCmd() *cobra.Command {
	var check, force bool
	var want string
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Replace this serve with the newest release",
		Long: `Download the newest serve CLI for this machine from GitHub, check its SHA-256
against the release's checksums.txt and replace the running binary.

The CLI has its own releases (tags like cli-v1.2.0), apart from Serve's. It works with
any recent Serve.`,
		Example: "  serve upgrade\n  serve upgrade --check\n  serve upgrade --version v1.2.0",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, stop := context.WithTimeout(cmd.Context(), 10*time.Minute)
			defer stop()
			current := a.Build.Version
			_, released := parseVersion(current)

			target := ""
			if want != "" {
				v, ok := cleanVersion(want)
				if !ok {
					return usagef("--version wants a version like v1.2.3 (got %q)", want)
				}
				target = v
			} else {
				latest, err := fetchNewestCLI(ctx, 15*time.Second)
				if err != nil {
					return fmt.Errorf("could not find the newest serve release: %w", err)
				}
				if latest == "" {
					return errNoCLIRelease
				}
				writeUpdateCache(updateCache{CheckedAt: time.Now(), Latest: latest})
				target = latest
			}

			if check {
				switch {
				case want != "":
					ui.Info("serve %s is installed. %s would be installed.", current, target)
				case newerVersion(target, current):
					ui.Info("serve %s is out (you have %s). Run: %s", ui.Bold(target), current, ui.Bold("serve upgrade"))
				case !released:
					ui.Info("This is a development build (%s). The newest release is %s.", current, target)
				default:
					ui.Success("serve %s is the newest version.", current)
				}
				return nil
			}
			if !released && !force {
				return fmt.Errorf("this serve is a development build (%s), so it is not replaced. Pass --force to replace it with %s", current, target)
			}
			if released && !force {
				if want == "" && !newerVersion(target, current) {
					if target == current {
						ui.Success("serve %s is the newest version.", current)
					} else {
						ui.Success("serve %s is newer than the newest release (%s). Nothing to do.", current, target)
					}
					return nil
				}
				if want != "" && sameRelease(target, current) {
					ui.Success("serve %s is already installed.", current)
					return nil
				}
			}

			exe, err := executablePath()
			if err != nil {
				return fmt.Errorf("could not find this serve binary: %w. Reinstall with:\n  %s", err, installScript)
			}
			// A serve.exe.old left by an earlier upgrade on Windows can go now.
			_ = os.Remove(exe + ".old")
			if err := checkWritable(filepath.Dir(exe)); err != nil {
				return notWritable(exe, err)
			}

			name := assetName(target, runtime.GOOS, runtime.GOARCH)
			sp := ui.StartSpinner(fmt.Sprintf("Downloading serve %s for %s/%s", target, runtime.GOOS, runtime.GOARCH))
			bin, err := downloadRelease(ctx, target, name)
			sp.Stop()
			if err != nil {
				return err
			}
			if err := replaceExecutable(exe, bin, runtime.GOOS); err != nil {
				if errors.Is(err, fs.ErrPermission) {
					return notWritable(exe, err)
				}
				return err
			}
			if newerVersion(target, current) {
				ui.Success("Upgraded serve from %s to %s (%s)", current, ui.Bold(target), exe)
			} else { // going back, or a dev build
				ui.Success("Replaced serve %s with %s (%s)", current, ui.Bold(target), exe)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.BoolVar(&check, "check", false, "only say whether a newer version is out")
	f.StringVar(&want, "version", "", "install this `version` (like v1.2.0) instead of the newest; can go back too")
	f.BoolVar(&force, "force", false, "replace a development build, or reinstall the same version")
	return cmd
}

// sameRelease says whether a and b name the same version, pre-release suffix included.
func sameRelease(a, b string) bool {
	ca, oka := cleanVersion(a)
	cb, okb := cleanVersion(b)
	return oka && okb && ca == cb
}

func notWritable(exe string, err error) error {
	fix := "Run `sudo serve upgrade`, or reinstall with:\n  " + installScript
	if runtime.GOOS == "windows" {
		fix = "Run the terminal as administrator and try again, or download the new .zip from https://github.com/serve-bd/serve/releases"
	}
	return fmt.Errorf("cannot replace %s: %v. %s", exe, err, fix)
}

// checkWritable fails early, before a download, when the binary's folder cannot be written.
func checkWritable(dir string) error {
	f, err := os.CreateTemp(dir, ".serve-upgrade-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_ = f.Close()
	return os.Remove(name)
}

// assetName is the archive of a release for one platform, like serve_1.2.0_linux_amd64.tar.gz.
func assetName(version, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("serve_%s_%s_%s%s", strings.TrimPrefix(version, "v"), goos, goarch, ext)
}

// downloadRelease fetches the archive and checksums.txt of a version, checks the archive and
// answers the binary in it. Releases are tagged cli-v1.2.3; versions before the CLI had its own
// releases (up to v0.3.x) are attached to Serve's release of the same tag, which is tried next.
func downloadRelease(ctx context.Context, version, name string) ([]byte, error) {
	var archive []byte
	tag := ""
	for _, t := range []string{"cli-" + version, version} {
		b, status, err := download(ctx, DownloadURL+"/"+t+"/"+name)
		if status == http.StatusNotFound {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("could not download %s: %w", name, err)
		}
		archive, tag = b, t
		break
	}
	if archive == nil {
		return nil, fmt.Errorf("there is no serve %s for %s/%s (looked for %s in release cli-%s). See https://github.com/serve-bd/serve/releases", version, runtime.GOOS, runtime.GOARCH, name, version)
	}
	sums, _, err := download(ctx, DownloadURL+"/"+tag+"/checksums.txt")
	if err != nil {
		return nil, fmt.Errorf("could not download the checksums of %s: %w", tag, err)
	}
	if err := verifyChecksum(sums, name, archive); err != nil {
		return nil, err
	}
	return extractBinary(archive, name)
}

// download answers the body of a GET, and the status code when there was an answer.
func download(ctx context.Context, url string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "serve-cli ("+runtime.GOOS+"/"+runtime.GOARCH+")")
	res, err := githubHTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, res.StatusCode, fmt.Errorf("%s answered %s", url, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBinary+1))
	if err != nil {
		return nil, res.StatusCode, err
	}
	if len(b) > maxBinary {
		return nil, res.StatusCode, fmt.Errorf("%s is larger than %d MB", url, maxBinary>>20)
	}
	return b, res.StatusCode, nil
}

// verifyChecksum checks data against its line in a sha256sum file.
func verifyChecksum(sums []byte, name string, data []byte) error {
	want := ""
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			want = strings.ToLower(fields[0])
			break
		}
	}
	if want == "" {
		return fmt.Errorf("checksums.txt has no line for %s. Nothing was changed", name)
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fmt.Errorf("the download of %s does not match its checksum (want %s, got %s). Nothing was changed. Try again", name, want, got)
	}
	return nil
}

// extractBinary answers the serve (or serve.exe) inside a release archive.
func extractBinary(archive []byte, name string) ([]byte, error) {
	isExe := func(p string) bool {
		base := path.Base(strings.ReplaceAll(p, "\\", "/"))
		return base == "serve" || base == "serve.exe"
	}
	readAll := func(r io.Reader) ([]byte, error) {
		b, err := io.ReadAll(io.LimitReader(r, maxBinary+1))
		if err == nil && len(b) > maxBinary {
			err = errors.New("the binary in the archive is too large")
		}
		return b, err
	}
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, fmt.Errorf("could not open %s: %w", name, err)
		}
		for _, f := range zr.File {
			if !f.FileInfo().Mode().IsRegular() || !isExe(f.Name) {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return readAll(rc)
		}
		return nil, fmt.Errorf("%s has no serve binary in it", name)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("could not open %s: %w", name, err)
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s has no serve binary in it", name)
		}
		if err != nil {
			return nil, fmt.Errorf("could not read %s: %w", name, err)
		}
		if h.Typeflag == tar.TypeReg && isExe(h.Name) {
			return readAll(tr)
		}
	}
}

// replaceExecutable puts bin in place of the file at exe: written to a temporary file in the same
// folder, made executable and renamed over it, so the binary is never half written. Windows
// cannot replace a running .exe, but can rename it: the old one becomes serve.exe.old.
func replaceExecutable(exe string, bin []byte, goos string) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".serve-upgrade-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(bin); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("could not write the new serve: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("could not write the new serve: %w", err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if goos == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
		if err := os.Rename(tmpName, exe); err != nil {
			_ = os.Rename(old, exe)
			return err
		}
		return nil
	}
	return os.Rename(tmpName, exe)
}
