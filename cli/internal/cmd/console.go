package cmd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// The console: serve exec (a service's container) and serve ssh (a server itself).

// consoleIO is the terminal a shell runs in; tests replace it.
type consoleIO struct {
	in            io.Reader
	out           io.Writer
	inFd, outFd   int
	inTTY, outTTY bool
}

var stdConsole = func() consoleIO {
	return consoleIO{
		in: os.Stdin, out: ui.Out,
		inFd: int(os.Stdin.Fd()), outFd: int(os.Stdout.Fd()),
		inTTY: term.IsTerminal(int(os.Stdin.Fd())), outTTY: term.IsTerminal(int(os.Stdout.Fd())) && ui.Out == io.Writer(os.Stdout),
	}
}

var plainWord = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// shellLine makes the command to run: one argument is a shell line as written ("ls | wc -l"),
// several are quoted word by word, so `serve exec -- sh -c 'echo $HOME'` runs as typed.
func shellLine(args []string) string {
	if len(args) == 1 {
		return args[0]
	}
	words := make([]string, len(args))
	for i, w := range args {
		if plainWord.MatchString(w) {
			words[i] = w
		} else {
			words[i] = "'" + strings.ReplaceAll(w, "'", `'\''`) + "'"
		}
	}
	return strings.Join(words, " ")
}

func (a *App) execCmd() *cobra.Command {
	var replica int
	var container string
	var tty bool
	cmd := &cobra.Command{
		Use:   "exec [-- command...]",
		Short: "Run a command, or open a shell, in the service's container",
		Long: `Run a command in a running container of the service (the linked one, or --service), or
open an interactive shell there when no command is given.

A command's output streams back and serve exits with its exit code. One argument is run as
a shell line ("ls | wc -l"); several are passed word by word. Use -t for a program that needs
a terminal (psql, top). Database containers have their client set up: psql or mysql log in.

--replica picks a replica by its number (1 is the first), --container a compose service or
a container name. You need the Console permission; services with host-level access are for
admins of the Root organization, as in the dashboard.`,
		Example: `  serve exec                         # a shell in the linked service
  serve exec -- ls -la /app
  serve exec "env | sort"
  serve exec -s postgres -t -- psql
  serve exec --replica 2 -- hostname
  serve exec -s stack --container worker -- php artisan queue:restart`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if replica < 0 {
				return usagef("--replica is a number from 1")
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			cio := stdConsole()
			line := shellLine(args)
			if line == "" || tty {
				if !cio.inTTY {
					if line == "" {
						return usagef("a shell needs a terminal. Pass a command to run instead: serve exec -- <command>")
					}
					return usagef("-t needs a terminal. Leave it out to run the command without one")
				}
				return a.runShell(ctx, "/services/"+api.P(s.ID), api.ShellRequest{Command: line, Target: container, Replica: replica}, cio, s.Name)
			}
			code, err := a.client.Exec(ctx, s.ID, api.ExecRequest{Command: line, Target: container, Replica: replica}, cio.out)
			if err != nil {
				return err
			}
			if code != 0 {
				return silentExit(code)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.SetInterspersed(false)
	f.IntVarP(&replica, "replica", "r", 0, "the replica to use, by its `number` (1 is the first)")
	f.StringVarP(&container, "container", "c", "", "the compose service or container `name` to use")
	f.BoolVarP(&tty, "tty", "t", false, "run the command with a terminal (for psql, top, ...)")
	return cmd
}

func (a *App) sshCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ssh <server> [-- command...]",
		Short: "Open a shell on a server, or run a command there",
		Long: `Open a root shell on a server itself, like its Terminal page in the dashboard: on the
dashboard's own machine through the host, on other servers over SSH as the server's user.
With a command, run it there with a terminal and exit with its exit code.

The server is a name or id (see serve servers). It needs a token with the admin and Console
permissions, for admins who manage the server: Root admins, or admins of the organization
that owns it. For a shell in a service's container, use serve exec.`,
		Example: `  serve ssh web-1
  serve ssh web-1 -- df -h
  serve ssh local "docker ps --format '{{.Names}}'"`,
		Args: minArgsMsg(1, "name the server: serve ssh <server> (see `serve servers`)"),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			srv, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			cio := stdConsole()
			rest := args[1:]
			// Flags stop at the server's name, so a "--" after it arrives as an argument.
			if len(rest) > 0 && rest[0] == "--" {
				rest = rest[1:]
			}
			line := shellLine(rest)
			if line == "" && !cio.inTTY {
				return usagef("a shell needs a terminal. Pass a command to run instead: serve ssh %s -- <command>", args[0])
			}
			return a.runShell(ctx, "/servers/"+api.P(srv.ID), api.ShellRequest{Command: line}, cio, srv.Name)
		},
	}
	cmd.Flags().SetInterspersed(false)
	return cmd
}

// minArgsMsg is cobra.MinimumNArgs with a message that says what to pass.
func minArgsMsg(n int, msg string) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if len(args) < n {
			return usagef("%s", msg)
		}
		return nil
	}
}

// runShell opens a shell (or a command with a TTY) and connects it to this terminal until it ends.
func (a *App) runShell(ctx context.Context, base string, req api.ShellRequest, cio consoleIO, name string) error {
	c, err := a.Client()
	if err != nil {
		return err
	}
	req.Cols, req.Rows = 80, 24
	if cio.outTTY {
		if w, h, err := term.GetSize(cio.outFd); err == nil && w > 0 && h > 0 {
			req.Cols, req.Rows = w, h
		}
	}
	t, err := c.OpenShell(ctx, base, req)
	if err != nil {
		return err
	}
	code, err := runTerminal(ctx, t, cio)
	if errors.Is(err, api.ErrShellGone) {
		ui.Info("The shell in %s ended.", name)
		return nil
	}
	if err != nil {
		return err
	}
	if code != 0 {
		if code < 0 {
			code = ExitError
		}
		return silentExit(code)
	}
	return nil
}

// runTerminal shows the shell's output and, with a terminal, sends what is typed and the window
// size. It answers the exit code (-1 when unknown).
func runTerminal(ctx context.Context, t *api.Shell, cio consoleIO) (int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	interactive := cio.inTTY
	if interactive {
		old, err := term.MakeRaw(cio.inFd)
		if err != nil {
			return -1, fmt.Errorf("could not set up the terminal: %w", err)
		}
		defer func() { _ = term.Restore(cio.inFd, old) }()
	}
	out := cio.out
	if !cio.outTTY {
		// Piped output reads like a file, not like a terminal.
		out = &crlfWriter{w: cio.out}
	}
	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		code, err := t.Events(ctx, out)
		done <- result{code, err}
	}()
	if interactive {
		go pumpInput(ctx, cancel, t, cio.in)
		go watchResize(ctx, t, cio.outFd)
	}
	r := <-done
	closeCtx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	t.Close(closeCtx)
	stop()
	if cw, ok := out.(*crlfWriter); ok {
		cw.flush()
	}
	return r.code, r.err
}

// pumpInput sends what is typed, a few keystrokes per request: what arrives within a few
// milliseconds goes together, so pasting or typing fast does not mean one request per key.
func pumpInput(ctx context.Context, cancel context.CancelFunc, t *api.Shell, in io.Reader) {
	chunks := make(chan []byte, 64)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := in.Read(buf)
			if n > 0 {
				select {
				case chunks <- append([]byte(nil), buf[:n]...):
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		var batch []byte
		select {
		case <-ctx.Done():
			return
		case b := <-chunks:
			batch = b
		}
		timer := time.NewTimer(8 * time.Millisecond)
	gather:
		for len(batch) < 32*1024 {
			select {
			case b := <-chunks:
				batch = append(batch, b...)
			case <-timer.C:
				break gather
			}
		}
		timer.Stop()
		if err := t.Input(ctx, string(batch)); err != nil {
			if ctx.Err() != nil {
				return
			}
			if api.IsStatus(err, 404) {
				cancel()
				return
			}
			// One more try for a dropped request; keystrokes are not lost on a short hiccup.
			time.Sleep(300 * time.Millisecond)
			_ = t.Input(ctx, string(batch))
		}
	}
}

// crlfWriter turns the terminal's \r\n into \n for output that goes to a file or a pipe.
type crlfWriter struct {
	w    io.Writer
	hold bool
}

func (c *crlfWriter) Write(p []byte) (int, error) {
	data := p
	if c.hold {
		data = append([]byte{'\r'}, p...)
		c.hold = false
	}
	if len(data) > 0 && data[len(data)-1] == '\r' {
		data = data[:len(data)-1]
		c.hold = true
	}
	if _, err := c.w.Write(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *crlfWriter) flush() {
	if c.hold {
		_, _ = c.w.Write([]byte{'\r'})
		c.hold = false
	}
}
