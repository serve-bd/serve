// Package ui prints messages, tables, spinners and progress bars. Messages and progress go to
// stderr, data goes to stdout. Colors and animations are used only on a terminal, and never when
// NO_COLOR is set.
package ui

import (
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
	"golang.org/x/term"
)

var (
	Out io.Writer = os.Stdout
	Err io.Writer = os.Stderr

	// Interactive is true when stdin and stderr are terminals: prompts, spinners and progress
	// bars are shown only then.
	Interactive = isTerminal(os.Stdin) && isTerminal(os.Stderr)
	errTTY      = isTerminal(os.Stderr)

	errRenderer = lipgloss.NewRenderer(os.Stderr)
	outRenderer = lipgloss.NewRenderer(os.Stdout)
)

func isTerminal(f *os.File) bool { return term.IsTerminal(int(f.Fd())) }

func init() {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		DisableColor()
	}
	if !isTerminal(os.Stdout) {
		outRenderer.SetColorProfile(termenv.Ascii)
	}
	if !errTTY {
		errRenderer.SetColorProfile(termenv.Ascii)
	}
}

// DisableColor turns colors off for the rest of the run (--no-color).
func DisableColor() {
	errRenderer.SetColorProfile(termenv.Ascii)
	outRenderer.SetColorProfile(termenv.Ascii)
}

// Styles for stderr messages.
var (
	Bold   = func(s string) string { return errRenderer.NewStyle().Bold(true).Render(s) }
	Dim    = func(s string) string { return errRenderer.NewStyle().Faint(true).Render(s) }
	Green  = func(s string) string { return errRenderer.NewStyle().Foreground(lipgloss.Color("2")).Render(s) }
	Red    = func(s string) string { return errRenderer.NewStyle().Foreground(lipgloss.Color("1")).Render(s) }
	Yellow = func(s string) string { return errRenderer.NewStyle().Foreground(lipgloss.Color("3")).Render(s) }
	Cyan   = func(s string) string { return errRenderer.NewStyle().Foreground(lipgloss.Color("6")).Render(s) }
)

// Styles for stdout data.
var (
	OutBold = func(s string) string { return outRenderer.NewStyle().Bold(true).Render(s) }
	OutDim  = func(s string) string { return outRenderer.NewStyle().Faint(true).Render(s) }
)

// StatusColor colors a service or deployment status for stdout.
func StatusColor(status string) string {
	c := ""
	switch status {
	case "running", "success", "ready":
		c = "2"
	case "failed", "crashed", "unreachable", "error":
		c = "1"
	case "building", "deploying", "queued", "waiting", "restarting":
		c = "3"
	case "cancelled", "superseded", "stopped", "idle":
		return outRenderer.NewStyle().Faint(true).Render(status)
	}
	if c == "" {
		return status
	}
	return outRenderer.NewStyle().Foreground(lipgloss.Color(c)).Render(status)
}

func Success(format string, a ...any) {
	fmt.Fprintf(Err, "%s %s\n", Green("✓"), fmt.Sprintf(format, a...))
}

func Warn(format string, a ...any) {
	fmt.Fprintf(Err, "%s %s\n", Yellow("!"), fmt.Sprintf(format, a...))
}

func Info(format string, a ...any) {
	fmt.Fprintf(Err, "%s\n", fmt.Sprintf(format, a...))
}

func Error(msg string) {
	fmt.Fprintf(Err, "%s %s\n", Red("Error:"), msg)
}

// Table writes aligned columns to stdout with a bold header.
func Table(headers []string, rows [][]string) {
	tw := tabwriter.NewWriter(Out, 0, 0, 2, ' ', 0)
	h := make([]string, len(headers))
	for i, s := range headers {
		h[i] = OutBold(s)
	}
	fmt.Fprintln(tw, strings.Join(h, "\t"))
	for _, r := range rows {
		fmt.Fprintln(tw, strings.Join(r, "\t"))
	}
	tw.Flush()
}

// KV writes "label  value" lines to stdout, labels aligned.
func KV(pairs [][2]string) {
	tw := tabwriter.NewWriter(Out, 0, 0, 2, ' ', 0)
	for _, p := range pairs {
		if p[1] == "" {
			continue
		}
		fmt.Fprintf(tw, "%s\t%s\n", OutDim(p[0]), p[1])
	}
	tw.Flush()
}

// Bytes formats a size: 1.2 MB.
func Bytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "kMGTPE"[exp])
}

// Ago formats an RFC 3339 time as "5m ago".
func Ago(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ts
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
	return t.Local().Format("2006-01-02")
}

// Duration formats an elapsed time as "1m12s".
func Duration(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	return s
}

// Line prints a message as it is.
func Line(s string) { fmt.Fprintln(Err, s) }

// ErrIsTerminal says whether stderr is a terminal (where hints like the update notice belong).
func ErrIsTerminal() bool { return errTTY }
