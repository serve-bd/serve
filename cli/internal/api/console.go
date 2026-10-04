package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ExecRequest runs one command in a service's container (POST /services/{id}/exec).
type ExecRequest struct {
	Command string `json:"command"`
	Target  string `json:"target,omitempty"`
	Replica int    `json:"replica,omitempty"`
}

// ErrNoExitCode is a command whose output ended before Serve sent its exit code (a dropped connection).
var ErrNoExitCode = errors.New("the connection ended before the command finished, so its exit code is unknown")

// Exec runs the command and copies its output to w as it arrives. It answers the command's exit code.
func (c *Client) Exec(ctx context.Context, serviceID string, req ExecRequest, w io.Writer) (int, error) {
	res, err := c.send(ctx, Request{Method: http.MethodPost, Path: "/services/" + P(serviceID) + "/exec", JSON: req})
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		e := decode(res, nil)
		var ae *Error
		if errors.As(e, &ae) {
			ae.URL = c.BaseURL
		}
		return 0, e
	}
	return CopyExecOutput(res.Body, w)
}

// CopyExecOutput copies the output of an exec answer to w, without its last line: a NUL
// character and the exit code, which it answers.
func CopyExecOutput(r io.Reader, w io.Writer) (int, error) {
	var hold []byte
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := append(hold, buf[:n]...)
			// Everything before the last "\n\x00" is output; the rest may be the end marker.
			if i := bytes.LastIndex(data, []byte("\n\x00")); i >= 0 {
				if _, werr := w.Write(data[:i]); werr != nil {
					return 0, werr
				}
				hold = append([]byte(nil), data[i:]...)
			} else if data[len(data)-1] == '\n' {
				if _, werr := w.Write(data[:len(data)-1]); werr != nil {
					return 0, werr
				}
				hold = []byte{'\n'}
			} else {
				if _, werr := w.Write(data); werr != nil {
					return 0, werr
				}
				hold = nil
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
	}
	if bytes.HasPrefix(hold, []byte("\n\x00")) {
		if code, err := strconv.Atoi(strings.TrimSpace(string(hold[2:]))); err == nil {
			return code, nil
		}
	}
	if len(hold) > 0 {
		if _, err := w.Write(hold); err != nil {
			return 0, err
		}
	}
	return 0, ErrNoExitCode
}

// Shell is an open shell: in a service's container (/services/{id}) or on a server (/servers/{id}).
type Shell struct {
	c    *Client
	base string
	ID   string
	// Where it runs: the container or the server's name.
	Where string
}

// ShellRequest opens a shell, or one command with a TTY when Command is set.
type ShellRequest struct {
	Command string `json:"command,omitempty"`
	Target  string `json:"target,omitempty"`
	Replica int    `json:"replica,omitempty"`
	Cols    int    `json:"cols"`
	Rows    int    `json:"rows"`
}

// OpenShell opens a shell. base is /services/{id} or /servers/{id}.
func (c *Client) OpenShell(ctx context.Context, base string, req ShellRequest) (*Shell, error) {
	var r struct {
		ID        string `json:"id"`
		Container string `json:"container"`
		Server    string `json:"server"`
	}
	if err := c.Post(ctx, base+"/terminal", req, &r); err != nil {
		return nil, err
	}
	if r.ID == "" {
		return nil, errors.New("the server did not open a shell. Is the dashboard up to date?")
	}
	where := r.Container
	if where == "" {
		where = r.Server
	}
	return &Shell{c: c, base: base, ID: r.ID, Where: where}, nil
}

func (t *Shell) path() string { return t.base + "/terminal/" + P(t.ID) }

// Input types into the shell.
func (t *Shell) Input(ctx context.Context, data string) error {
	return t.c.Do(ctx, Request{Method: http.MethodPost, Path: t.path(), JSON: map[string]any{"type": "input", "data": data}, NoRetry: true}, nil)
}

// Resize tells the shell the window size.
func (t *Shell) Resize(ctx context.Context, cols, rows int) error {
	return t.c.Do(ctx, Request{Method: http.MethodPost, Path: t.path(), JSON: map[string]any{"type": "resize", "cols": cols, "rows": rows}, NoRetry: true}, nil)
}

// Close ends the shell (best effort).
func (t *Shell) Close(ctx context.Context) {
	_ = t.c.Delete(ctx, t.path(), nil, nil)
}

// ErrShellGone is a shell the server no longer knows (it ended, or closed while nobody listened).
var ErrShellGone = errors.New("the shell ended")

// Events copies the shell's output to out until it ends, and answers its exit code (-1 when
// unknown). A dropped connection is opened again from the last output it saw.
func (t *Shell) Events(ctx context.Context, out io.Writer) (int, error) {
	var since int64
	failures := 0
	for {
		code, done, err := t.events(ctx, out, &since)
		if done {
			return code, nil
		}
		if ctx.Err() != nil {
			return -1, ctx.Err()
		}
		if IsStatus(err, http.StatusNotFound) {
			return -1, ErrShellGone
		}
		var ae *Error
		if errors.As(err, &ae) && ae.Status != http.StatusTooManyRequests && ae.Status < 500 {
			return -1, err
		}
		failures++
		if failures > 5 {
			if err == nil {
				err = errors.New("the output stream kept ending")
			}
			return -1, err
		}
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-time.After(time.Duration(failures) * 500 * time.Millisecond):
		}
	}
}

// events reads one Server-Sent Events stream. done is true once the shell exited.
func (t *Shell) events(ctx context.Context, out io.Writer, since *int64) (code int, done bool, err error) {
	q := url.Values{}
	if *since > 0 {
		q.Set("since", strconv.FormatInt(*since, 10))
	}
	res, err := t.c.send(ctx, Request{Method: http.MethodGet, Path: t.path(), Query: q})
	if err != nil {
		return 0, false, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return 0, false, decode(res, nil)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var event, data string
	var id int64 = -1
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if event == "exit" {
				var e struct {
					Code *int `json:"code"`
				}
				_ = json.Unmarshal([]byte(data), &e)
				if e.Code == nil {
					return -1, true, nil
				}
				return *e.Code, true, nil
			}
			if data != "" {
				b, derr := base64.StdEncoding.DecodeString(data)
				if derr == nil {
					if _, werr := out.Write(b); werr != nil {
						return 0, false, werr
					}
				}
				if id >= 0 {
					*since = id
				}
			}
			event, data, id = "", "", -1
		case strings.HasPrefix(line, ":"):
			// A ping.
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimSpace(line[5:])
		case strings.HasPrefix(line, "id:"):
			if n, perr := strconv.ParseInt(strings.TrimSpace(line[3:]), 10, 64); perr == nil {
				id = n
			}
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return 0, false, err
	}
	return 0, false, nil
}
