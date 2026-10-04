//go:build windows

package cmd

import (
	"context"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"golang.org/x/term"
)

// watchResize sends the window size when it changes (Windows has no resize signal: it is checked twice a second).
func watchResize(ctx context.Context, t *api.Shell, fd int) {
	lastW, lastH, _ := term.GetSize(fd)
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if w, h, err := term.GetSize(fd); err == nil && w > 0 && h > 0 && (w != lastW || h != lastH) {
				lastW, lastH = w, h
				_ = t.Resize(ctx, w, h)
			}
		}
	}
}
