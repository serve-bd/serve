package cmd

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/ui"
)

// Exit codes.
const (
	ExitOK       = 0
	ExitError    = 1
	ExitUsage    = 2
	ExitDeployed = 3 // the deployment failed or was cancelled
)

// ExitError ends the run with a code. An empty message prints nothing more.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

func exit(code int, format string, a ...any) error {
	return &exitError{code: code, msg: fmt.Sprintf(format, a...)}
}

// silentExit ends with a code without printing an error (the reason was already shown).
func silentExit(code int) error { return &exitError{code: code} }

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, a ...any) error { return &usageError{msg: fmt.Sprintf(format, a...)} }

// ExitCode maps an error of a command to the process exit code.
func ExitCode(err error) int {
	if err == nil {
		return ExitOK
	}
	var ee *exitError
	if errors.As(err, &ee) {
		return ee.code
	}
	var ue *usageError
	if errors.As(err, &ue) || isCobraUsage(err) {
		return ExitUsage
	}
	return ExitError
}

// cobra's own errors for an unknown command or a bad argument count.
func isCobraUsage(err error) bool {
	s := err.Error()
	for _, p := range []string{"unknown command", "unknown flag", "unknown shorthand flag", "accepts ", "requires at least", "requires at most", "flag needs an argument", "invalid argument"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// PrintError shows an error the way the user should read it.
func PrintError(err error, cmdPath string) {
	var ee *exitError
	if errors.As(err, &ee) && ee.msg == "" {
		return
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, ui.ErrAborted) {
		ui.Info("Cancelled.")
		return
	}
	ui.Error(err.Error())
	if ExitCode(err) == ExitUsage && cmdPath != "" {
		ui.Line(ui.Dim(fmt.Sprintf("Run `%s --help` for usage.", cmdPath)))
	}
}

// needChoice turns "nobody can be asked" into a clear message naming the flag to pass.
func needChoice(err error, what string) error {
	if errors.Is(err, ui.ErrNotInteractive) {
		return usagef("%s", what)
	}
	return err
}
