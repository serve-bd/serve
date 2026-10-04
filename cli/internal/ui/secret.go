package ui

import (
	"strings"

	"github.com/charmbracelet/huh"
)

// Password asks for a secret without showing what is typed.
func Password(title string) (string, error) {
	if !Interactive {
		return "", ErrNotInteractive
	}
	var v string
	err := run(huh.NewInput().Title(title).EchoMode(huh.EchoModePassword).Value(&v))
	return strings.TrimSpace(v), aborted(err)
}
