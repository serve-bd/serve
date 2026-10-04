//go:build !windows

package cmd

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/serve-bd/serve/cli/internal/api"
	"golang.org/x/term"
)

// watchResize sends the window size whenever the terminal is resized.
func watchResize(ctx context.Context, t *api.Shell, fd int) {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGWINCH)
	defer signal.Stop(sig)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sig:
			if w, h, err := term.GetSize(fd); err == nil && w > 0 && h > 0 {
				_ = t.Resize(ctx, w, h)
			}
		}
	}
}
