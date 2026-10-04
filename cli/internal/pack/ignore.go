package pack

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// rule is one line of an ignore file.
type rule struct {
	base    string // folder of the ignore file, relative to the root of its rules ("" for the root)
	negate  bool
	dirOnly bool
	// docker rules (.dockerignore) also match every path below a matching folder, and a
	// negation can bring back a file inside an ignored folder.
	docker bool
	re     *regexp.Regexp
}

// parseIgnore reads gitignore syntax. With docker set, every pattern is relative to the root,
// as in .dockerignore. With fold set, patterns match without regard to case (core.ignorecase).
// Lines that cannot be read as a pattern are answered in bad, never dropped silently.
func parseIgnore(r io.Reader, base string, docker, fold bool) (rules []rule, bad []string) {
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if first {
			// Editors on Windows may start the file with a byte order mark; git skips it.
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		if docker {
			line = strings.TrimSpace(line)
		} else {
			line = trimTrailingSpace(line)
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		raw := line
		ru := rule{base: base, docker: docker}
		if strings.HasPrefix(line, "!") {
			ru.negate = true
			line = line[1:]
		} else if strings.HasPrefix(line, `\!`) || strings.HasPrefix(line, `\#`) {
			line = line[1:]
		}
		if docker {
			line = strings.TrimPrefix(strings.TrimPrefix(line, "./"), "/")
		}
		if strings.HasSuffix(line, "/") {
			ru.dirOnly = true
			line = strings.TrimRight(line, "/")
		}
		if line == "" {
			continue
		}
		anchored := docker || strings.Contains(line, "/")
		line = strings.TrimPrefix(line, "/")
		expr := globToRegexp(line)
		if anchored {
			expr = "^" + expr + "$"
		} else {
			expr = "(^|/)" + expr + "$"
		}
		if fold {
			expr = "(?i)" + expr
		}
		re, err := regexp.Compile(expr)
		if err != nil {
			bad = append(bad, raw)
			continue
		}
		ru.re = re
		rules = append(rules, ru)
	}
	return rules, bad
}

// trimTrailingSpace drops trailing spaces unless escaped with a backslash.
func trimTrailingSpace(s string) string {
	for strings.HasSuffix(s, " ") && !strings.HasSuffix(s, `\ `) {
		s = s[:len(s)-1]
	}
	return s
}

func globToRegexp(p string) string {
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch c {
		case '*':
			if i+1 < len(p) && p[i+1] == '*' {
				atStart := i == 0 || p[i-1] == '/'
				i++
				if atStart && i+1 < len(p) && p[i+1] == '/' {
					// "**/": any number of folders, also none.
					b.WriteString("(?:.*/)?")
					i++
				} else if atStart && i+1 == len(p) {
					// A trailing "/**": everything inside.
					b.WriteString(".*")
				} else {
					// Elsewhere "**" is a plain "*".
					b.WriteString("[^/]*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			class, end, ok := bracket(p, i)
			if !ok {
				b.WriteString(`\[`)
				continue
			}
			b.WriteString(class)
			i = end
		case '\\':
			if i+1 < len(p) {
				i++
				b.WriteString(regexp.QuoteMeta(string(p[i])))
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	return b.String()
}

// posixClasses are the [:name:] classes git knows.
var posixClasses = map[string]bool{"alnum": true, "alpha": true, "blank": true, "cntrl": true, "digit": true, "graph": true,
	"lower": true, "print": true, "punct": true, "space": true, "upper": true, "xdigit": true}

// bracket turns the glob bracket expression that starts at p[i] into a regexp class, and answers
// the index of its closing ']'. Not ok when the bracket is not closed (then '[' is literal).
func bracket(p string, i int) (string, int, bool) {
	var b strings.Builder
	b.WriteString("[")
	j := i + 1
	if j < len(p) && (p[j] == '!' || p[j] == '^') {
		b.WriteString("^")
		j++
	}
	for start := j; j < len(p); j++ {
		c := p[j]
		switch {
		case c == ']' && j > start:
			b.WriteString("]")
			return b.String(), j, true
		case c == '[' && j+1 < len(p) && p[j+1] == ':':
			end := strings.Index(p[j+2:], ":]")
			if end < 0 {
				b.WriteString(`\[`)
				continue
			}
			name := p[j+2 : j+2+end]
			if !posixClasses[name] {
				// Not a class git knows: the pattern does not compile, and the rule is reported.
				return "[[:" + name + ":]]", j + 2 + end + 1, true
			}
			b.WriteString("[:" + name + ":]")
			j += 2 + end + 1
		case c == '\\' && j+1 < len(p):
			j++
			b.WriteString(regexp.QuoteMeta(string(p[j])))
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	return "", 0, false
}

// Matcher holds two separate gates. The git gate is the .gitignore files (from the repository
// root down), .git/info/exclude and the global git ignore file, or the .serveignore files that
// replace them. The docker gate is .dockerignore. A path is left out when either gate leaves it
// out: a .dockerignore negation never brings back what git ignores.
type Matcher struct {
	git, docker []rule
	// prefix is the scanned folder relative to the git repository root ("" when it is the root
	// or there is no repository). Git rules are matched against prefix + path.
	prefix string
}

// Ignored says whether a path (slash separated, relative to the scanned folder) is left out.
func (m *Matcher) Ignored(path string, isDir bool) bool {
	g, d := m.gates(path, isDir)
	return g || d
}

// gates answers what each gate says of a path.
func (m *Matcher) gates(path string, isDir bool) (git, docker bool) {
	full := path
	if m.prefix != "" {
		full = m.prefix + "/" + path
	}
	for _, r := range m.git {
		if r.matches(full, isDir) {
			git = !r.negate
		}
	}
	for _, r := range m.docker {
		if r.matches(path, isDir) {
			docker = !r.negate
		}
	}
	return git, docker
}

// MayReinclude says whether a docker negation could bring back something inside a folder that
// only .dockerignore leaves out.
func (m *Matcher) MayReinclude() bool {
	for _, r := range m.docker {
		if r.negate {
			return true
		}
	}
	return false
}

func (r rule) matches(path string, isDir bool) bool {
	rel := path
	if r.base != "" {
		if !strings.HasPrefix(path, r.base+"/") {
			return false
		}
		rel = path[len(r.base)+1:]
	}
	if r.re.MatchString(rel) && (!r.dirOnly || isDir) {
		return true
	}
	if r.docker {
		// A folder rule covers what is inside it.
		for i := len(rel) - 1; i > 0; i-- {
			if rel[i] == '/' && r.re.MatchString(rel[:i]) {
				return true
			}
		}
	}
	return false
}

func badRules(file string, bad []string) []string {
	out := make([]string, 0, len(bad))
	for _, b := range bad {
		out = append(out, fmt.Sprintf("%s: %s", file, b))
	}
	return out
}
