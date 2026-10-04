package ui

import (
	"io"
	"strings"
	"unicode/utf8"

	"github.com/muesli/termenv"
)

// MaxLine caps one log line; the rest of a longer line is cut.
const MaxLine = 16 * 1024

// LogWriter writes log text from a server to w with control characters removed, so a log can
// never move the cursor, clear the screen or retitle the terminal. Color codes (SGR) are kept
// when color is true. Lines longer than MaxLine are cut.
type LogWriter struct {
	W       io.Writer
	Color   bool
	lineLen int
	cut     bool
}

func (l *LogWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(l.W, l.clean(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// NewLogWriter keeps colors when stdout is a terminal with colors on.
func NewLogWriter(w io.Writer) *LogWriter {
	return &LogWriter{W: w, Color: ColorOut()}
}

func (l *LogWriter) clean(s string) string {
	s = strings.ToValidUTF8(s, "�")
	var b strings.Builder
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == '\n' {
			b.WriteByte('\n')
			l.lineLen, l.cut = 0, false
			i += size
			continue
		}
		if r == 0x1b {
			seq, n := escape(s[i:])
			if l.Color && seq != "" && !l.cut {
				b.WriteString(seq)
			}
			i += n
			continue
		}
		i += size
		if r == '\r' || (r < 0x20 && r != '\t') || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			continue
		}
		if l.cut {
			continue
		}
		if l.lineLen >= MaxLine {
			b.WriteString(" … (line cut)")
			l.cut = true
			continue
		}
		b.WriteRune(r)
		l.lineLen += size
	}
	return b.String()
}

// escape reads an escape sequence at the start of s. It answers the sequence when it is a
// harmless color code (ESC [ digits ; m), and how many bytes to skip.
func escape(s string) (string, int) {
	if len(s) < 2 {
		return "", len(s)
	}
	switch s[1] {
	case '[':
		j := 2
		for j < len(s) && s[j] >= 0x30 && s[j] <= 0x3f {
			j++
		}
		for j < len(s) && s[j] >= 0x20 && s[j] <= 0x2f {
			j++
		}
		if j >= len(s) {
			return "", len(s)
		}
		seq := s[:j+1]
		if s[j] == 'm' && strings.Trim(seq[2:j], "0123456789;") == "" {
			return seq, j + 1
		}
		return "", j + 1
	case ']', 'P', '_', '^':
		// OSC and other strings run to BEL or ESC \.
		for j := 2; j < len(s); j++ {
			if s[j] == 0x07 {
				return "", j + 1
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return "", j + 2
			}
		}
		return "", len(s)
	}
	return "", 2
}

// SanitizeLine cleans one log line for printing.
func SanitizeLine(s string, color bool) string {
	l := &LogWriter{Color: color}
	return l.clean(strings.TrimRight(s, "\r\n"))
}

// ColorOut says whether stdout shows colors.
func ColorOut() bool { return outRenderer.ColorProfile() != termenv.Ascii }
