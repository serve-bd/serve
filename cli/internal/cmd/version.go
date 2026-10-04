package cmd

import (
	"os"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

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
				ui.Info("%s %s is out. Run: %s", ui.Yellow("A newer version,"), ui.Bold(latest), ui.Bold("serve upgrade"))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.Flags().BoolVar(&noCheck, "no-check", false, "do not look for a newer version")
	return cmd
}

// newerVersion says whether version a (v1.2.3 or cli-v1.2.3) is newer than b. A dev build is
// never older.
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
	pre := func(s string) bool { return strings.Contains(strings.TrimPrefix(s, "cli-"), "-") }
	return !pre(a) && pre(b)
}

// parseVersion reads v1.2.3, 1.2.3 or cli-v1.2.3 (a pre-release or build suffix is ignored).
func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(v, "cli-")
	v = strings.TrimPrefix(v, "v")
	v, _, _ = strings.Cut(v, "-")
	v, _, _ = strings.Cut(v, "+")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// cleanVersion turns v1.2.3, 1.2.3 or cli-v1.2.3 into v1.2.3. ok is false for anything else.
func cleanVersion(v string) (string, bool) {
	v = strings.TrimSpace(v)
	if _, ok := parseVersion(v); !ok {
		return "", false
	}
	v = strings.TrimPrefix(v, "cli-")
	return "v" + strings.TrimPrefix(v, "v"), true
}
