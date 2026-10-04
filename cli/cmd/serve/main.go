// Command serve deploys folders to a Serve dashboard and manages its services.
package main

import (
	"os"

	"github.com/serve-bd/serve/cli/internal/cmd"
)

// Set at build time with -ldflags "-X main.version=v1.2.3 -X main.commit=... -X main.date=...".
var (
	version = "dev"
	commit  = ""
	date    = ""
)

func main() {
	os.Exit(cmd.Execute(cmd.Build{Version: version, Commit: commit, Date: date}, os.Args[1:]))
}
