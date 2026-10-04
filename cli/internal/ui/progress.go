package ui

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/huh"
)

// Spinner shows a message with a turning wheel on a terminal. Elsewhere it shows nothing.
type Spinner struct {
	mu   sync.Mutex
	msg  string
	stop chan struct{}
	done chan struct{}
}

var frames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func StartSpinner(msg string) *Spinner {
	s := &Spinner{msg: msg, stop: make(chan struct{}), done: make(chan struct{})}
	if !errTTY {
		close(s.done)
		return s
	}
	go func() {
		defer close(s.done)
		t := time.NewTicker(80 * time.Millisecond)
		defer t.Stop()
		for i := 0; ; i++ {
			s.mu.Lock()
			fmt.Fprintf(Err, "\r\033[K%s %s", Cyan(frames[i%len(frames)]), s.msg)
			s.mu.Unlock()
			select {
			case <-s.stop:
				fmt.Fprint(Err, "\r\033[K")
				return
			case <-t.C:
			}
		}
	}()
	return s
}

// Update changes the message.
func (s *Spinner) Update(msg string) {
	s.mu.Lock()
	s.msg = msg
	s.mu.Unlock()
}

// Stop clears the spinner line.
func (s *Spinner) Stop() {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	<-s.done
}

// Progress wraps a reader and draws a bar of how much of total was read, on a terminal only.
type Progress struct {
	r       io.Reader
	total   int64
	n       int64
	start   time.Time
	last    time.Time
	label   string
	enabled bool
}

func NewProgress(r io.Reader, total int64, label string) *Progress {
	return &Progress{r: r, total: total, label: label, start: time.Now(), enabled: errTTY}
}

func (p *Progress) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.n += int64(n)
	if p.enabled && (time.Since(p.last) > 100*time.Millisecond || err != nil) {
		p.last = time.Now()
		p.draw()
	}
	return n, err
}

func (p *Progress) draw() {
	const width = 28
	frac := 1.0
	if p.total > 0 {
		frac = float64(p.n) / float64(p.total)
	}
	if frac > 1 {
		frac = 1
	}
	filled := int(frac * width)
	bar := Green(strings.Repeat("█", filled)) + Dim(strings.Repeat("░", width-filled))
	rate := ""
	if el := time.Since(p.start).Seconds(); el > 0.3 {
		rate = fmt.Sprintf("  %s/s", Bytes(int64(float64(p.n)/el)))
	}
	fmt.Fprintf(Err, "\r\033[K%s %s %3.0f%%  %s / %s%s", p.label, bar, frac*100, Bytes(p.n), Bytes(p.total), rate)
}

// Done ends the bar line.
func (p *Progress) Done() {
	if p.enabled {
		fmt.Fprint(Err, "\r\033[K")
	}
}

// ErrNotInteractive means a choice was needed but nobody can be asked.
var ErrNotInteractive = errors.New("not interactive")

// Option is one choice of a Select.
type Option struct {
	Label string
	Value string
}

// Select asks for one of the options.
func Select(title string, options []Option) (string, error) {
	if !Interactive {
		return "", ErrNotInteractive
	}
	opts := make([]huh.Option[string], len(options))
	for i, o := range options {
		opts[i] = huh.NewOption(o.Label, o.Value)
	}
	var v string
	err := run(huh.NewSelect[string]().Title(title).Options(opts...).Value(&v).Height(min(len(opts)+2, 14)))
	return v, aborted(err)
}

// Input asks for a line of text.
func Input(title, placeholder string, value string) (string, error) {
	if !Interactive {
		return "", ErrNotInteractive
	}
	v := value
	err := run(huh.NewInput().Title(title).Placeholder(placeholder).Value(&v))
	return strings.TrimSpace(v), aborted(err)
}

// Confirm asks a yes or no question.
func Confirm(title string, def bool) (bool, error) {
	if !Interactive {
		return def, ErrNotInteractive
	}
	v := def
	err := run(huh.NewConfirm().Title(title).Value(&v))
	return v, aborted(err)
}

// run shows one field on stderr, so stdout stays clean for data.
func run(f huh.Field) error {
	return huh.NewForm(huh.NewGroup(f)).WithShowHelp(false).WithOutput(os.Stderr).Run()
}

// ErrAborted is a prompt left with Ctrl+C or Esc.
var ErrAborted = errors.New("cancelled")

func aborted(err error) error {
	if errors.Is(err, huh.ErrUserAborted) {
		return ErrAborted
	}
	return err
}

// Animated says whether spinners and progress bars are drawn.
func Animated() bool { return errTTY }
