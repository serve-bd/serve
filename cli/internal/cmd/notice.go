package cmd

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// The update notice: after the everyday commands, one line on stderr says when a newer serve is
// out. It never slows a command: it uses the remembered answer, and when that is older than a
// day it asks GitHub in the background and shows only what is known by the time the command ends.

const noticeAnnotation = "updateNotice"

// noticeTimeout bounds the background check.
var noticeTimeout = 2 * time.Second

// stderrIsTerminal is overridden in tests.
var stderrIsTerminal = ui.ErrIsTerminal

// withNotice marks a command that shows the update notice when it ends.
func withNotice(c *cobra.Command) *cobra.Command {
	if c.Annotations == nil {
		c.Annotations = map[string]string{}
	}
	c.Annotations[noticeAnnotation] = "1"
	return c
}

type updateNotice struct {
	known   string      // the newest version known when the command started
	refresh chan string // the answer of the background check, when there is one
}

// noticeWanted says whether this run of cmd may show the notice.
func (a *App) noticeWanted(cmd *cobra.Command) bool {
	if cmd == nil || cmd.Annotations[noticeAnnotation] != "1" {
		return false
	}
	if os.Getenv("SERVE_NO_UPDATE_CHECK") != "" || isCI() || !stderrIsTerminal() {
		return false
	}
	if _, ok := parseVersion(a.Build.Version); !ok {
		return false // a development build
	}
	for _, name := range []string{"json", "follow"} {
		if f := cmd.Flags().Lookup(name); f != nil && f.Value.String() == "true" {
			return false
		}
	}
	return true
}

func isCI() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("CI")))
	return v != "" && v != "0" && v != "false" && v != "no"
}

// startNotice runs before the command: it reads the cache and, when that is stale, starts the
// background check.
func (a *App) startNotice(cmd *cobra.Command) {
	if !a.noticeWanted(cmd) {
		return
	}
	c, fresh := readUpdateCache()
	n := &updateNotice{known: c.Latest}
	if !fresh {
		n.refresh = make(chan string, 1)
		// Not cancelled when the command ends: the process exits and takes it along, and the
		// cache is written through a rename, so it is never left half written.
		go func() {
			latest, _ := refreshUpdateCache(context.Background(), c, noticeTimeout)
			n.refresh <- latest
		}()
	}
	a.notice = n
}

// finishNotice runs after the command, whether it worked or not, and prints the line when a
// newer version is known. It never waits for the background check.
func (a *App) finishNotice() {
	n := a.notice
	if n == nil {
		return
	}
	a.notice = nil
	latest := n.known
	if n.refresh != nil {
		select {
		case v := <-n.refresh:
			latest = v
		default:
		}
	}
	if latest != "" && newerVersion(latest, a.Build.Version) {
		ui.Line("  " + ui.Yellow("serve "+latest+" is out") + " (you have " + a.Build.Version + "). Run: " + ui.Bold("serve upgrade"))
	}
}
