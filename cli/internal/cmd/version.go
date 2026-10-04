package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// ReleasesURL answers the newest release. Overridden in tests.
var ReleasesURL = "https://api.github.com/repos/serve-bd/serve/releases/latest"

func (a *App) versionCmd() *cobra.Command {
	var asJSON, noCheck bool
	cmd := &cobra.Command{
		Use:   "version",
		Short: "Print the version and check for a newer one",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			latest := ""
			if !noCheck && os.Getenv("SERVE_NO_UPDATE_CHECK") == "" {
				latest = latestRelease(cmd.Context())
			}
			newer := latest != "" && newerVersion(latest, a.Build.Version)
			if asJSON {
				return printJSON(map[string]any{"version": a.Build.Version, "commit": a.Build.Commit, "date": a.Build.Date, "latest": latest, "updateAvailable": newer})
			}
			line := "serve " + a.Build.Version
			var extra []string
			if a.Build.Commit != "" {
				extra = append(extra, a.Build.Commit)
			}
			if a.Build.Date != "" {
				extra = append(extra, a.Build.Date)
			}
			if len(extra) > 0 {
				line += " (" + strings.Join(extra, ", ") + ")"
			}
			ui.Info("%s", line)
			if newer {
				ui.Info("%s %s is out. Update with:", ui.Yellow("A newer version,"), ui.Bold(latest))
				ui.Info("  curl -fsSL https://raw.githubusercontent.com/serve-bd/serve/main/install-cli.sh | sh")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.Flags().BoolVar(&noCheck, "no-check", false, "do not look for a newer version")
	return cmd
}

type updateCache struct {
	CheckedAt time.Time `json:"checkedAt"`
	Latest    string    `json:"latest"`
}

// latestRelease answers the newest release tag, asking GitHub at most once a day. "" when unknown.
func latestRelease(ctx context.Context) string {
	dir, err := config.CacheDir()
	if err != nil {
		return ""
	}
	path := filepath.Join(dir, "update-check.json")
	var cache updateCache
	if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &cache) == nil && time.Since(cache.CheckedAt) < 24*time.Hour {
		return cache.Latest
	}
	tag, err := fetchLatest(ctx)
	if err != nil {
		return cache.Latest
	}
	cache = updateCache{CheckedAt: time.Now(), Latest: tag}
	if b, err := json.Marshal(cache); err == nil {
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(path, b, 0o644)
	}
	return tag
}

func fetchLatest(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ReleasesURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", errors.New(res.Status)
	}
	var r struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return "", err
	}
	return r.TagName, nil
}

// newerVersion says whether version a (v1.2.3) is newer than b. A dev build is never older.
func newerVersion(a, b string) bool {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return false
	}
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	// 1.2.3 is newer than 1.2.3-rc.1.
	return !strings.Contains(a, "-") && strings.Contains(b, "-")
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(v, "v")
	v, _, _ = strings.Cut(v, "-")
	v, _, _ = strings.Cut(v, "+")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
