package cmd

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

const serveJSON = "serve.json"

func (a *App) configCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Check serve.json, or write one from a service's settings",
		Long: `serve.json keeps an app's settings next to its code: build, deploy, health check, resources,
storage, scheduled tasks, variables, HTTP options and the uptime check. Every new deploy
applies it. See https://serve.bd/docs/serve-json/.`,
	}

	var env string
	var preview bool
	validate := &cobra.Command{
		Use:   "validate [file]",
		Short: "Check a serve.json the way a deploy does",
		Long: `Check a serve.json the way a deploy does and list every problem with the place it is in.
With --env, also check the settings that environment's deploys would use (its block merged in),
and with --preview those of pull request previews.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			file := serveJSON
			if len(args) == 1 {
				file = args[0]
			}
			text, err := os.ReadFile(file)
			if errors.Is(err, fs.ErrNotExist) {
				return exit(ExitError, "%s not found. Write one from a service with `serve config pull`.", file)
			}
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"text": string(text)}
			if env != "" {
				body["environment"] = env
				body["preview"] = preview
			}
			var r struct {
				Valid  bool     `json:"valid"`
				Errors []string `json:"errors"`
				Blocks []string `json:"blocks"`
			}
			if err := c.Post(cmd.Context(), "/serve-json/validate", body, &r); err != nil {
				return err
			}
			if jsonFlag(cmd) {
				if err := printJSON(r); err != nil {
					return err
				}
				if !r.Valid {
					return silentExit(ExitError)
				}
				return nil
			}
			if !r.Valid {
				ui.Error(fmt.Sprintf("%s has %s:", file, plural(len(r.Errors), "problem")))
				for _, e := range r.Errors {
					fmt.Fprintf(os.Stderr, "  %s\n", e)
				}
				return silentExit(ExitError)
			}
			if len(r.Blocks) > 0 {
				ui.Success("%s is valid (checked with %s)", file, joinAnd(r.Blocks))
			} else {
				ui.Success("%s is valid", file)
			}
			return nil
		},
	}
	validate.Flags().StringVar(&env, "env", "", "also check the settings this `environment` uses")
	validate.Flags().BoolVar(&preview, "preview", false, "with --env: as a pull request preview")
	validate.Flags().Bool("json", false, "print the result as JSON")

	var out string
	var force bool
	pull := &cobra.Command{
		Use:     "pull",
		Aliases: []string{"init"},
		Short:   "Write the service's current settings as a serve.json",
		Long: `Write the service's current settings as a serve.json, to commit next to the code. Only what
differs from the defaults is written. Variables are left out: their values stay in Serve.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if !force {
				if _, err := os.Stat(out); err == nil {
					return exit(ExitError, "%s already exists. Use --force to replace it.", out)
				}
			}
			var r struct {
				Text string `json:"text"`
			}
			if err := a.client.Get(ctx, "/services/"+s.ID+"/serve-json", nil, &r); err != nil {
				return err
			}
			if dir := filepath.Dir(out); dir != "." {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					return err
				}
			}
			if err := os.WriteFile(out, []byte(r.Text), 0o644); err != nil {
				return err
			}
			ui.Success("Wrote %s from %s. Commit it: every new deploy applies it.", out, s.Name)
			return nil
		},
	}
	pull.Flags().StringVarP(&out, "output", "o", serveJSON, "where to write it")
	pull.Flags().BoolVar(&force, "force", false, "replace an existing file")

	cmd.AddCommand(validate, pull)
	return cmd
}

func joinAnd(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	out := items[0]
	for _, s := range items[1 : len(items)-1] {
		out += ", " + s
	}
	return out + " and " + items[len(items)-1]
}
