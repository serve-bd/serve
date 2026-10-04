package pack

import (
	"bufio"
	"io"
	"regexp"
	"strings"
)

// rule is one line of an ignore file.
type rule struct {
	base    string // folder of the ignore file, relative to the root ("" for the root)
	negate  bool
	dirOnly bool
	// docker rules (.dockerignore) also match every path below a matching folder, and a
	// negation can bring back a file inside an ignored folder.
	docker bool
	re     *regexp.Regexp
}

// parseIgnore reads gitignore syntax. With docker set, every pattern is relative to the root,
// as in .dockerignore.
func parseIgnore(r io.Reader, base string, docker bool) []rule {
	var rules []rule
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if docker {
			line = strings.TrimSpace(line)
		} else {
			line = trimTrailingSpace(line)
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
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
		re, err := regexp.Compile(expr)
		if err != nil {
			continue
		}
		ru.re = re
		rules = append(rules, ru)
	}
	return rules
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
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			j := i + 1
			if j < len(p) && (p[j] == '!' || p[j] == '^') {
				j++
			}
			if j < len(p) && p[j] == ']' {
				j++
			}
			for j < len(p) && p[j] != ']' {
				j++
			}
			if j >= len(p) {
				b.WriteString(`\[`)
				continue
			}
			class := p[i+1 : j]
			if strings.HasPrefix(class, "!") {
				class = "^" + class[1:]
			}
			b.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
			i = j
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

// Matcher holds the rules of .gitignore files, then .dockerignore, then .serveignore files. A
// later rule wins over an earlier one, so .serveignore has the last word.
type Matcher struct {
	git, docker, serve []rule
}

// Ignored says whether a path (slash separated, relative to the root) is left out. inIgnored is
// true inside an ignored folder that is still walked because a .dockerignore negation could
// bring something back: there every rule also matches the folders above the path, so the path
// stays ignored unless a later rule names it again.
func (m *Matcher) Ignored(path string, isDir, inIgnored bool) bool {
	ignored := false
	for _, layer := range [][]rule{m.git, m.docker, m.serve} {
		for _, r := range layer {
			if r.matches(path, isDir, inIgnored) {
				ignored = !r.negate
			}
		}
	}
	return ignored
}

// MayReinclude says whether a docker negation could bring back something inside an ignored folder.
func (m *Matcher) MayReinclude() bool {
	for _, r := range m.docker {
		if r.negate {
			return true
		}
	}
	return false
}

func (r rule) matches(path string, isDir, parents bool) bool {
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
	if r.docker || parents {
		// A folder rule covers what is inside it.
		for i := len(rel) - 1; i > 0; i-- {
			if rel[i] == '/' && r.re.MatchString(rel[:i]) {
				return true
			}
		}
	}
	return false
}
