// Package dotenv reads and writes .env files.
package dotenv

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)

// ValidKey says whether a variable name is accepted by Serve.
func ValidKey(k string) bool { return keyPattern.MatchString(k) }

// Var is one KEY=value pair.
type Var struct {
	Key   string
	Value string
}

// Parse reads KEY=value lines. It understands comments, `export `, single quotes (kept as
// written), double quotes (with \n, \t, \" and \\) and quoted values over several lines.
func Parse(text string) ([]Var, error) {
	var out []Var
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, rest, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || !ValidKey(key) {
			return nil, fmt.Errorf("line %d is not KEY=value: %q", i+1, lines[i])
		}
		rest = strings.TrimLeft(rest, " \t")
		var value string
		switch {
		case strings.HasPrefix(rest, `"`) || strings.HasPrefix(rest, `'`):
			q := rest[0]
			body := rest[1:]
			start := i
			for {
				if end := closingQuote(body, q); end >= 0 {
					value = body[:end]
					break
				}
				i++
				if i >= len(lines) {
					return nil, fmt.Errorf("line %d: the quote is never closed", start+1)
				}
				body += "\n" + lines[i]
			}
			if q == '"' {
				value = unescape(value)
			}
		default:
			if j := strings.Index(rest, " #"); j >= 0 {
				rest = rest[:j]
			}
			value = strings.TrimSpace(rest)
		}
		out = append(out, Var{key, value})
	}
	return out, nil
}

func closingQuote(s string, q byte) int {
	for i := 0; i < len(s); i++ {
		if q == '"' && s[i] == '\\' {
			i++
			continue
		}
		if s[i] == q {
			return i
		}
	}
	return -1
}

func unescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
			switch s[i] {
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			default:
				b.WriteByte(s[i])
			}
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

var plain = regexp.MustCompile(`^[A-Za-z0-9_./:@%+,=-]*$`)

// Quote writes a value so Parse reads it back the same.
func Quote(v string) string {
	if plain.MatchString(v) {
		return v
	}
	if !strings.ContainsAny(v, "'\n\r") {
		return "'" + v + "'"
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`)
	return `"` + r.Replace(v) + `"`
}

// Format writes the variables sorted by key.
func Format(vars map[string]string) string {
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + Quote(vars[k]) + "\n")
	}
	return b.String()
}
