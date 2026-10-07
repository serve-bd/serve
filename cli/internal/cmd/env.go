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
		Aliases: []string{"variables"},
		Short:   "Read and change the service's environment variables",
		Long: `Read and change the service's environment variables. Changes apply on the next deploy, or
right away with --redeploy.

push and unset also take --preview (the variables pull request previews use) and --replica N
(the variables only replica N gets).`,
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

	var preview, yes bool
	var replica int
	unset := &cobra.Command{
		Use:     "unset KEY...",
		Aliases: []string{"rm"},
		Short:   "Remove one or more variables",
		Long: `Remove variables of the service. With --preview or --replica N, remove every preview
variable or every variable of replica N (those are replaced as a whole: they cannot be read
back to remove only some). Asks first unless --yes.`,
		Example: "  serve env unset OLD_KEY --redeploy\n  serve env unset --preview\n  serve env unset --replica 2 --yes",
		Args: func(cmd *cobra.Command, args []string) error {
			if preview || cmd.Flags().Changed("replica") {
				if len(args) > 0 {
					return usagef("preview and replica variables are removed all at once: run it without keys, or replace them with `serve env push <file> --preview` (or --replica N)")
				}
				return nil
			}
			return minArgs(1)(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, err := extraVarsScope(cmd, preview, replica)
			if err != nil {
				return err
			}
			if scope != nil {
				return a.putExtraVars(cmd.Context(), scope, nil, redeploy, yes)
			}
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
		Long: `Set the variables of a .env file (- for standard input) on the service; the others stay.

--preview sets the variables that pull request previews use instead of the service's ones of
the same name. --replica N sets the variables only replica N (1, 2, ...) gets on top of the
service's. Both replace what was set before as a whole (the values cannot be read back), so
they ask first unless --yes.`,
		Example: "  serve env push\n  serve env push .env.production --redeploy\n  serve env push .env.preview --preview\n  serve env push replica2.env --replica 2 --redeploy",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, err := extraVarsScope(cmd, preview, replica)
			if err != nil {
				return err
			}
			file := ".env"
			if len(args) > 0 {
				file = args[0]
			}
			var b []byte
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
				if scope != nil {
					return fmt.Errorf("%s has no variables. To remove them all, run `serve env unset` with the same flag", file)
				}
				return fmt.Errorf("%s has no variables", file)
			}
			if scope != nil {
				return a.putExtraVars(cmd.Context(), scope, vars, redeploy, yes)
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
	for _, c := range []*cobra.Command{unset, push} {
		c.Flags().BoolVar(&preview, "preview", false, "the variables pull request previews use (replaced as a whole)")
		c.Flags().IntVar(&replica, "replica", 0, "the variables only replica `N` gets (replaced as a whole)")
		c.Flags().BoolVarP(&yes, "yes", "y", false, "with --preview or --replica: do not ask first")
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

// extraScope is a set of variables the API only replaces as a whole: the preview variables, or
// one replica's.
type extraScope struct {
	path  string // after /services/{id}
	label string // "preview variables", "variables of replica 2"
}

// extraVarsScope reads --preview and --replica; nil when neither was passed.
func extraVarsScope(cmd *cobra.Command, preview bool, replica int) (*extraScope, error) {
	fl := cmd.Flags()
	byReplica := fl.Changed("replica")
	switch {
	case preview && byReplica:
		return nil, usagef("pass --preview or --replica, not both")
	case preview:
		if fl.Changed("redeploy") {
			return nil, usagef("--redeploy does not go with --preview: open previews use the variables from their next deploy")
		}
		return &extraScope{"/preview-variables", "preview variables"}, nil
	case byReplica:
		if replica < 1 {
			return nil, usagef("--replica is the number of a replica: 1, 2, ...")
		}
		return &extraScope{fmt.Sprintf("/replicas/%d/variables", replica), fmt.Sprintf("variables of replica %d", replica)}, nil
	}
	if fl.Changed("yes") {
		return nil, usagef("--yes goes with --preview or --replica")
	}
	return nil, nil
}

// putExtraVars replaces the variables of a scope (none: removes them all), after asking.
func (a *App) putExtraVars(ctx context.Context, scope *extraScope, vars []dotenv.Var, redeploy, yes bool) error {
	s, err := a.target(ctx, ".", anyService)
	if err != nil {
		return err
	}
	// The last value of a key wins, as in a .env file; the API refuses a key twice.
	list := []map[string]string{}
	at := map[string]int{}
	for _, v := range vars {
		if i, ok := at[v.Key]; ok {
			list[i]["value"] = v.Value
			continue
		}
		at[v.Key] = len(list)
		list = append(list, map[string]string{"key": v.Key, "value": v.Value})
	}
	question := fmt.Sprintf("Remove every one of the %s of %s?", scope.label, s.Name)
	if len(list) > 0 {
		question = fmt.Sprintf("Replace the %s of %s with these %d? Ones not in the file are removed.", scope.label, s.Name, len(list))
	}
	if err := confirmYes(question, "replace the "+scope.label, yes); err != nil {
		return err
	}
	body := map[string]any{"variables": list}
	if scope.path != "/preview-variables" {
		body["redeploy"] = redeploy
	}
	var r map[string]any
	if err := a.client.PutJSON(ctx, "/services/"+api.P(s.ID)+scope.path, body, &r); err != nil {
		return err
	}
	if len(list) == 0 {
		ui.Success("Removed the %s of %s.", scope.label, ui.Bold(s.Name))
	} else {
		ui.Success("Set the %s of %s (%d).", scope.label, ui.Bold(s.Name), len(list))
	}
	switch {
	case scope.path == "/preview-variables":
		ui.Line(ui.Dim("New previews start with them; open previews use them from their next deploy."))
	case redeploy:
		if id := api.DeploymentIDOf(r); id != "" {
			ui.Line(ui.Dim("Redeploying: serve logs --build " + id + " -f"))
		}
	default:
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
