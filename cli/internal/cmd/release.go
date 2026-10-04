package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/config"
)

// The CLI has its own releases, tagged cli-v1.2.3, in the Serve repository. Serve's own releases
// (v1.2.3) are what instances update to, so a CLI release is never marked "latest" there and the
// CLI looks through the list instead. Both URLs are overridden in tests.
var (
	ReleasesURL = "https://api.github.com/repos/serve-bd/serve/releases?per_page=100"
	DownloadURL = "https://github.com/serve-bd/serve/releases/download"
)

const cliTagPrefix = "cli-v"

// githubHTTP talks to GitHub. HTTPS_PROXY and NO_PROXY are honored. SERVE_INSECURE is not: it is
// for a dashboard's self-signed certificate, and a new binary must come over checked HTTPS.
var githubHTTP = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}

type ghRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// newestCLI picks the newest CLI release of a list: tags cli-v<semver>, no drafts or
// pre-releases, Serve's own v* tags skipped. It answers v1.2.3, or "" when there is none.
func newestCLI(releases []ghRelease) string {
	best := ""
	for _, r := range releases {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.TagName, cliTagPrefix) {
			continue
		}
		v, ok := cleanVersion(r.TagName)
		if !ok || strings.Contains(v, "-") {
			continue
		}
		if best == "" || newerVersion(v, best) {
			best = v
		}
	}
	return best
}

// fetchNewestCLI asks GitHub for the newest CLI release (v1.2.3, "" when there is none yet).
func fetchNewestCLI(ctx context.Context, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ReleasesURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "serve-cli ("+runtime.GOOS+"/"+runtime.GOARCH+")")
	res, err := githubHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusTooManyRequests {
			return "", fmt.Errorf("GitHub answered %s (its rate limit for this address is probably used up; try again in an hour)", res.Status)
		}
		return "", fmt.Errorf("GitHub answered %s", res.Status)
	}
	var list []ghRelease
	if err := json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(&list); err != nil {
		return "", fmt.Errorf("could not read GitHub's list of releases: %w", err)
	}
	return newestCLI(list), nil
}

type updateCache struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest"`
}

const checkEvery = 24 * time.Hour

// A failed check is tried again after an hour, not on every command.
const retryFailedAfter = time.Hour

func cachePath() (string, error) {
	dir, err := config.CacheDir()
	if err != nil {
		return "", err
	}
	// Not update-check.json: that one held Serve's newest release, not the CLI's.
	return filepath.Join(dir, "cli-update-check.json"), nil
}

// readUpdateCache answers what is remembered and whether it is recent enough to use as is.
func readUpdateCache() (updateCache, bool) {
	var c updateCache
	path, err := cachePath()
	if err != nil {
		return c, false
	}
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &c) != nil {
		return updateCache{}, false
	}
	age := time.Since(c.CheckedAt)
	return c, age >= 0 && age < checkEvery
}

func writeUpdateCache(c updateCache) {
	path, err := cachePath()
	if err != nil {
		return
	}
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	// Through a temporary file: two commands checking at once must not leave half a file.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".cli-update-check-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), path) != nil {
		_ = os.Remove(tmp.Name())
	}
}

// refreshUpdateCache asks GitHub and remembers the answer. On failure it keeps the last known
// version and tries again after an hour.
func refreshUpdateCache(ctx context.Context, old updateCache, timeout time.Duration) (string, error) {
	latest, err := fetchNewestCLI(ctx, timeout)
	if err != nil {
		writeUpdateCache(updateCache{CheckedAt: time.Now().Add(retryFailedAfter - checkEvery), Latest: old.Latest})
		return old.Latest, err
	}
	writeUpdateCache(updateCache{CheckedAt: time.Now(), Latest: latest})
	return latest, nil
}

// latestRelease answers the newest CLI release (v1.2.3), asking GitHub at most once a day.
// "" when unknown.
func latestRelease(ctx context.Context) string {
	c, fresh := readUpdateCache()
	if fresh {
		return c.Latest
	}
	latest, _ := refreshUpdateCache(ctx, c, 5*time.Second)
	return latest
}

var errNoCLIRelease = errors.New("there is no serve CLI release yet at https://github.com/serve-bd/serve/releases (tags cli-v*)")
