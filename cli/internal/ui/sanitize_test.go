package ui

import (
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	cases := []struct{ in, color, plain string }{
		{"hello\tworld", "hello\tworld", "hello\tworld"},
		{"\x1b[31mred\x1b[0m", "\x1b[31mred\x1b[0m", "red"},
		{"a\x1b[2Jb\x1b[Hc", "abc", "abc"},                              // clear screen, cursor home
		{"x\x1b]0;evil title\x07y", "xy", "xy"},                         // window title
		{"x\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\", "xlink", "xlink"}, // OSC 8 with ESC \
		{"bell\x07 back\x08 del\x7f", "bell back del", "bell back del"},
		{"bad \xff utf8", "bad � utf8", "bad � utf8"},
		{"cr\rover", "crover", "crover"},
	}
	for _, c := range cases {
		if got := SanitizeLine(c.in, true); got != c.color {
			t.Errorf("color %q: got %q, want %q", c.in, got, c.color)
		}
		if got := SanitizeLine(c.in, false); got != c.plain {
			t.Errorf("plain %q: got %q, want %q", c.in, got, c.plain)
		}
	}
	long := strings.Repeat("a", MaxLine+100)
	if got := SanitizeLine(long, false); len(got) > MaxLine+20 || !strings.HasSuffix(got, "(line cut)") {
		t.Fatalf("long line: %d", len(got))
	}
	// Across writes: the cut ends at the newline.
	var b strings.Builder
	w := &LogWriter{W: &b}
	w.Write([]byte(strings.Repeat("b", MaxLine)))
	w.Write([]byte("bbb\nnext\n"))
	if !strings.HasSuffix(b.String(), "(line cut)\nnext\n") {
		t.Fatalf("stream: %q", b.String()[len(b.String())-30:])
	}
}
