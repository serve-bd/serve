package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/dotenv"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

const noSecrets = "this login cannot read variable values (it needs the variables.view-secrets permission)"

func (a *App) envCmd() *cobra.Command {
	var reveal, asJSON, redeploy, force bool
	cmd := &cobra.Command{
		Use:     "env",
		Aliases: []string{"vars", "variables"},
		Short:   "Read and change the service's environment variables",
		Long:    "Read and change the service's environment variables. Changes apply on the next deploy, or right away with --redeploy.",
	}
	list := func(cmd *cobra.Command, args []string) error {
		ctx := cmd.Context()
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return err
		}
		vars, err := a.client.Variables(ctx, s.ID)
		if err != nil {
			return err
		}
		if asJSON {
			if !reveal {
				for i := range vars {
					vars[i].Value = nil
				}
			}
			return printJSON(vars)
		}
		if len(vars) == 0 {
			ui.Info("%s has no variables. Add one with `serve env set KEY=value`.", s.Name)
			return nil
		}
		var rows [][]string
		hidden, anyFlags := false, false
		for _, v := range vars {
			val := ui.OutDim("(hidden)")
			if v.Value != nil {
				val = mask(*v.Value)
				if reveal {
					val = strings.ReplaceAll(*v.Value, "\n", `\n`)
				}
			} else {
				hidden = true
			}
			var flags []string
			if !v.BuildTime {
				flags = append(flags, "runtime only")
			}
			if !v.Runtime {
				flags = append(flags, "build only")
			}
			anyFlags = anyFlags || len(flags) > 0
			rows = append(rows, []string{v.Key, val, ui.OutDim(strings.Join(flags, ", "))})
		}
		headers := []string{"KEY", "VALUE", "USED"}
		if !anyFlags {
			headers = headers[:2]
			for i := range rows {
				rows[i] = rows[i][:2]
			}
		}
		ui.Table(headers, rows)
		if hidden {
			ui.Line(ui.Dim("Values are hidden: " + noSecrets + "."))
		} else if !reveal {
			ui.Line(ui.Dim("Pass --reveal to show the values."))
		}
		return nil
	}
	cmd.RunE = list
	cmd.Args = noArgs
	cmd.PersistentFlags().BoolVar(&asJSON, "json", false, "print JSON (ls)")
	cmd.PersistentFlags().BoolVar(&reveal, "reveal", false, "show the values (ls)")

	ls := &cobra.Command{Use: "ls", Aliases: []string{"list"}, Short: "List the variables (values masked unless --reveal)", Args: noArgs, RunE: list}

	get := &cobra.Command{
		Use:   "get <KEY>",
		Short: "Print the value of a variable",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			vars, err := a.client.Variables(ctx, s.ID)
			if err != nil {
				return err
			}
			for _, v := range vars {
				if v.Key == args[0] {
					if v.Value == nil {
						return errors.New(noSecrets)
					}
					fmt.Fprintln(ui.Out, *v.Value)
					return nil
				}
			}
			return fmt.Errorf("%s has no variable %s", s.Name, args[0])
		},
	}

	set := &cobra.Command{
		Use:     "set KEY=value...",
		Short:   "Set one or more variables",
		Example: "  serve env set API_URL=https://api.example.com DEBUG=0\n  serve env set SECRET=abc --redeploy",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			changes := map[string]any{}
			for _, arg := range args {
				k, v, ok := strings.Cut(arg, "=")
				if !ok || !dotenv.ValidKey(k) {
					return usagef("%q is not KEY=value", arg)
				}
				changes[k] = v
			}
			return a.patchVars(cmd.Context(), changes, redeploy, fmt.Sprintf("Set %s", keyList(changes)))
		},
	}

	unset := &cobra.Command{
		Use:     "unset KEY...",
		Aliases: []string{"rm"},
		Short:   "Remove one or more variables",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			changes := map[string]any{}
			for _, k := range args {
				changes[k] = nil
			}
			return a.patchVars(cmd.Context(), changes, redeploy, fmt.Sprintf("Removed %s", keyList(changes)))
		},
	}

	pull := &cobra.Command{
		Use:   "pull [file]",
		Short: "Write the variables to a .env file (- for stdout)",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			file := ".env"
			if len(args) > 0 {
				file = args[0]
			}
			if file != "-" && !force {
				if _, err := os.Stat(file); err == nil {
					return fmt.Errorf("%s already exists. Pass --force to overwrite it", file)
				}
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			vars, err := a.client.Variables(ctx, s.ID)
			if err != nil {
				return err
			}
			m := map[string]string{}
			for _, v := range vars {
				if v.Value == nil {
					return errors.New(noSecrets)
				}
				m[v.Key] = *v.Value
			}
			text := dotenv.Format(m)
			if file == "-" {
				fmt.Fprint(ui.Out, text)
				return nil
			}
			if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
				return err
			}
			ui.Success("Wrote %d variable(s) of %s to %s.", len(m), s.Name, file)
			return nil
		},
	}
	pull.Flags().BoolVar(&force, "force", false, "overwrite the file")

	push := &cobra.Command{
		Use:   "push [file]",
		Short: "Set the variables of a .env file (- for stdin); others stay",
		Args:  maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			file := ".env"
			if len(args) > 0 {
				file = args[0]
			}
			var b []byte
			var err error
			if file == "-" {
				b, err = io.ReadAll(os.Stdin)
			} else {
				b, err = os.ReadFile(file)
			}
			if err != nil {
				return err
			}
			vars, err := dotenv.Parse(string(b))
			if err != nil {
				return fmt.Errorf("%s: %w", file, err)
			}
			if len(vars) == 0 {
				return fmt.Errorf("%s has no variables", file)
			}
			changes := map[string]any{}
			for _, v := range vars {
				changes[v.Key] = v.Value
			}
			return a.patchVars(cmd.Context(), changes, redeploy, fmt.Sprintf("Set %d variable(s) from %s", len(changes), file))
		},
	}
	for _, c := range []*cobra.Command{set, unset, push} {
		c.Flags().BoolVar(&redeploy, "redeploy", false, "deploy again so the change applies now")
	}
	cmd.AddCommand(ls, get, set, unset, pull, push)
	return cmd
}

func (a *App) patchVars(ctx context.Context, changes map[string]any, redeploy bool, done string) error {
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return err
	}
	var r map[string]any
	if err := a.client.Patch(ctx, "/services/"+api.P(s.ID)+"/variables", map[string]any{"variables": changes, "redeploy": redeploy}, &r); err != nil {
		return err
	}
	ui.Success("%s on %s.", done, ui.Bold(s.Name))
	if redeploy {
		if id := api.DeploymentIDOf(r); id != "" {
			ui.Line(ui.Dim("Redeploying: serve logs --build " + id + " -f"))
		}
	} else {
		ui.Line(ui.Dim("This applies on the next deploy. Pass --redeploy to apply it now."))
	}
	return nil
}

func keyList(m map[string]any) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	if len(keys) > 3 {
		return fmt.Sprintf("%d variables", len(keys))
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// mask hides a value but keeps a hint of its length.
func mask(v string) string {
	if v == "" {
		return ui.OutDim("(empty)")
	}
	return strings.Repeat("•", min(len(v), 8))
}
