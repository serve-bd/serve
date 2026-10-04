package cmd

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// TaskPoll is how often `serve tasks run --wait` asks whether the run ended (tests shorten it).
var TaskPoll = 2 * time.Second

func (a *App) tasksCmd() *cobra.Command {
	cmd := lsCmd("tasks", "List, create and run the service's scheduled tasks", []string{"task", "cron"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		s, err := a.target(ctx, ".", anyService)
		if err != nil {
			return err
		}
		list, err := a.client.Tasks(ctx, s.ID)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(list)
		}
		if len(list) == 0 {
			ui.Info("%s has no scheduled tasks. Add one with `serve tasks create <name> --schedule \"0 3 * * *\" --command \"...\"`.", s.Name)
			return nil
		}
		var rows [][]string
		for _, t := range list {
			state := "on"
			if !t.Enabled {
				state = ui.OutDim("off")
			}
			last := ui.OutDim("never")
			if t.LastRunAt != nil {
				last = ui.Ago(*t.LastRunAt)
				if st := deref(t.LastStatus); st != "" {
					last += " " + ui.StatusColor(st)
				}
			}
			rows = append(rows, []string{t.Name, t.Schedule, state, shorten(t.Command, 48), last})
		}
		ui.Table([]string{"NAME", "SCHEDULE", "ON", "COMMAND", "LAST RUN"}, rows)
		return nil
	})
	cmd.Long = `List, create, change and run the service's scheduled tasks: commands run in the
service's container on a cron schedule (like "0 3 * * *" for 3:00 every night, in the server's time).`
	cmd.Example = "  serve tasks\n  serve tasks create cleanup --schedule \"0 3 * * *\" --command \"npm run cleanup\"\n  serve tasks run cleanup --wait"
	cmd.AddCommand(a.taskCreateCmd(), a.taskSetCmd(), a.taskRunCmd(), a.taskRunsCmd(), a.taskRmCmd())
	return cmd
}

// shorten keeps one line of s, at most n characters.
func shorten(s string, n int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-3]) + "..."
	}
	return s
}

// parseSeconds reads "90", "90s", "30m" or "1h" as seconds.
func parseSeconds(v string) (int, error) {
	if n, err := strconv.Atoi(v); err == nil {
		return n, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration like 90s, 30m or 1h", v)
	}
	return int(d.Seconds()), nil
}

func (a *App) findTask(ctx context.Context, s *api.Service, ref string) (*api.Task, error) {
	list, err := a.client.Tasks(ctx, s.ID)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == ref {
			return &list[i], nil
		}
	}
	for i := range list {
		if strings.EqualFold(list[i].Name, ref) {
			return &list[i], nil
		}
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("%s has no scheduled tasks", s.Name)
	}
	names := make([]string, len(list))
	for i, t := range list {
		names[i] = t.Name
	}
	return nil, fmt.Errorf("%s has no task %q. It has: %s", s.Name, ref, strings.Join(names, ", "))
}

// taskFields reads the flags shared by create and set into the request body.
type taskFlags struct {
	name, schedule, command, composeService, timeout string
}

func (tf *taskFlags) body(cmd *cobra.Command) (map[string]any, error) {
	f := cmd.Flags()
	body := map[string]any{}
	if f.Changed("name") {
		if strings.TrimSpace(tf.name) == "" {
			return nil, usagef("--name cannot be empty")
		}
		body["name"] = tf.name
	}
	if f.Changed("schedule") {
		if len(strings.Fields(tf.schedule)) < 5 {
			return nil, usagef("--schedule needs five cron fields, like \"0 3 * * *\" (minute hour day month weekday). Quote it")
		}
		body["schedule"] = tf.schedule
	}
	if f.Changed("command") {
		if strings.TrimSpace(tf.command) == "" {
			return nil, usagef("--command cannot be empty")
		}
		body["command"] = tf.command
	}
	if f.Changed("compose-service") {
		if tf.composeService == "" {
			body["composeService"] = nil
		} else {
			body["composeService"] = tf.composeService
		}
	}
	if f.Changed("timeout") {
		n, err := parseSeconds(tf.timeout)
		if err != nil {
			return nil, usagef("--timeout: %s", err.Error())
		}
		if n < 10 || n > 86400 {
			return nil, usagef("--timeout must be from 10s to 24h")
		}
		body["timeoutSeconds"] = n
	}
	return body, nil
}

func (tf *taskFlags) add(cmd *cobra.Command, withName bool) {
	f := cmd.Flags()
	if withName {
		f.StringVar(&tf.name, "name", "", "a new `name`")
	}
	f.StringVar(&tf.schedule, "schedule", "", "when it runs, as a cron `expression` like \"0 3 * * *\"")
	f.StringVar(&tf.command, "command", "", "the `command` to run in the container")
	f.StringVar(&tf.composeService, "compose-service", "", "for a compose stack: the `service` to run it in")
	f.StringVar(&tf.timeout, "timeout", "", "stop it after this `duration` (like 30m; default 1h)")
}

func (a *App) taskCreateCmd() *cobra.Command {
	var tf taskFlags
	var disabled bool
	cmd := &cobra.Command{
		Use:   "create <name> --schedule <cron> --command <command>",
		Short: "Create a scheduled task",
		Long: `Create a scheduled task: a command run in the service's container on a cron schedule.
The command can also come after --, so it needs no quotes of its own.`,
		Example: "  serve tasks create cleanup --schedule \"0 3 * * *\" --command \"npm run cleanup\"\n  serve tasks create report --schedule \"*/15 * * * *\" -- node scripts/report.js --since 15m",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 1 {
				if cmd.Flags().Changed("command") {
					return usagef("give the command once: with --command or after --")
				}
				tf.command = strings.Join(args[1:], " ")
				_ = cmd.Flags().Set("command", tf.command)
			}
			body, err := tf.body(cmd)
			if err != nil {
				return err
			}
			if body["schedule"] == nil {
				return usagef("pass --schedule, like --schedule \"0 3 * * *\"")
			}
			if body["command"] == nil {
				return usagef("pass --command, or the command after --")
			}
			body["name"] = args[0]
			if disabled {
				body["enabled"] = false
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/tasks", body, nil); err != nil {
				return err
			}
			state := ""
			if disabled {
				state = " (off)"
			}
			ui.Success("Created the task %s on %s%s: %s.", ui.Bold(args[0]), s.Name, state, tf.schedule)
			return nil
		},
	}
	tf.add(cmd, false)
	cmd.Flags().BoolVar(&disabled, "disabled", false, "create it turned off")
	return cmd
}

func (a *App) taskSetCmd() *cobra.Command {
	var tf taskFlags
	var enable, disable bool
	cmd := &cobra.Command{
		Use:     "set <task>",
		Short:   "Change a scheduled task, or turn it on or off",
		Long:    "Change a scheduled task. Only the flags you pass change. --enable and --disable turn it on or off.",
		Example: "  serve tasks set cleanup --schedule \"30 4 * * *\"\n  serve tasks set cleanup --disable\n  serve tasks set cleanup --command \"npm run cleanup -- --all\" --timeout 2h",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if enable && disable {
				return usagef("pass --enable or --disable, not both")
			}
			body, err := tf.body(cmd)
			if err != nil {
				return err
			}
			if len(body) == 0 && !enable && !disable {
				return usagef("nothing to change: pass at least one flag (see --help)")
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			t, err := a.findTask(ctx, s, args[0])
			if err != nil {
				return err
			}
			switch {
			case enable:
				body["enabled"] = true
			case disable:
				body["enabled"] = false
			case len(body) > 0:
				// Saving new settings turns a task on unless it says otherwise: keep it as it was.
				body["enabled"] = t.Enabled
			}
			var r struct{ Task api.Task }
			if err := a.client.Patch(ctx, "/tasks/"+api.P(t.ID), body, &r); err != nil {
				return err
			}
			name := t.Name
			if r.Task.Name != "" {
				name = r.Task.Name
			}
			switch {
			case enable && len(body) == 1:
				ui.Success("Turned %s on.", ui.Bold(name))
			case disable && len(body) == 1:
				ui.Success("Turned %s off.", ui.Bold(name))
			default:
				ui.Success("Updated the task %s.", ui.Bold(name))
			}
			return nil
		},
	}
	tf.add(cmd, true)
	cmd.Flags().BoolVar(&enable, "enable", false, "turn it on")
	cmd.Flags().BoolVar(&disable, "disable", false, "turn it off (it stays, and can still be run by hand)")
	return cmd
}

func (a *App) taskRunCmd() *cobra.Command {
	var wait bool
	cmd := &cobra.Command{
		Use:   "run <task>",
		Short: "Run a scheduled task now",
		Long: `Run a scheduled task now, once, in the service's container. With --wait the CLI waits
for it to end, prints its output and exits with 1 when it failed.`,
		Example: "  serve tasks run cleanup\n  serve tasks run cleanup --wait",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			t, err := a.findTask(ctx, s, args[0])
			if err != nil {
				return err
			}
			var r struct {
				ID string `json:"id"`
			}
			if err := a.client.Post(ctx, "/tasks/"+api.P(t.ID)+"/run", nil, &r); err != nil {
				return err
			}
			if !wait {
				ui.Success("Started %s.", ui.Bold(t.Name))
				ui.Line(ui.Dim("See how it went with `serve tasks runs " + t.Name + "`."))
				return nil
			}
			return a.waitTaskRun(ctx, t, r.ID)
		},
	}
	cmd.Flags().BoolVarP(&wait, "wait", "w", false, "wait for it to end and print its output")
	return cmd
}

func (a *App) waitTaskRun(ctx context.Context, t *api.Task, runID string) error {
	sp := ui.StartSpinner("Running " + t.Name + "...")
	defer sp.Stop()
	for {
		runs, err := a.client.TaskRuns(ctx, t.ID)
		if err != nil {
			return err
		}
		var run *api.TaskRun
		for i := range runs {
			if runs[i].ID == runID || (runID == "" && i == 0) {
				run = &runs[i]
				break
			}
		}
		if run != nil && run.Status != "running" {
			sp.Stop()
			if out := strings.TrimRight(run.Output, "\n"); out != "" {
				fmt.Fprintln(ui.NewLogWriter(ui.Out), out)
			}
			if run.Status == "success" {
				ui.Success("%s finished.", ui.Bold(t.Name))
				return nil
			}
			code := ""
			if run.ExitCode != nil {
				code = fmt.Sprintf(" (exit code %d)", *run.ExitCode)
			}
			return fmt.Errorf("%s failed%s", t.Name, code)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(TaskPoll):
		}
	}
}

func (a *App) taskRunsCmd() *cobra.Command {
	var asJSON, last bool
	cmd := &cobra.Command{
		Use:     "runs <task>",
		Short:   "List the recent runs of a task",
		Long:    "List the last 50 runs of a scheduled task, newest first. --last prints the output of the newest one.",
		Example: "  serve tasks runs cleanup\n  serve tasks runs cleanup --last",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			t, err := a.findTask(ctx, s, args[0])
			if err != nil {
				return err
			}
			runs, err := a.client.TaskRuns(ctx, t.ID)
			if err != nil {
				return err
			}
			if last {
				if len(runs) == 0 {
					return fmt.Errorf("%s has not run yet", t.Name)
				}
				if asJSON {
					return printJSON(runs[0])
				}
				r := runs[0]
				ui.Line(ui.Dim(fmt.Sprintf("%s, %s, %s", ui.Ago(deref(r.StartedAt)), triggerLabel(r.Trigger), r.Status)))
				if out := strings.TrimRight(r.Output, "\n"); out != "" {
					fmt.Fprintln(ui.NewLogWriter(ui.Out), out)
				} else {
					ui.Line(ui.Dim("(no output)"))
				}
				return nil
			}
			if asJSON {
				return printJSON(runs)
			}
			if len(runs) == 0 {
				ui.Info("%s has not run yet. Run it now with `serve tasks run %s`.", t.Name, t.Name)
				return nil
			}
			var rows [][]string
			for _, r := range runs {
				code, took := "", ""
				if r.ExitCode != nil {
					code = strconv.Itoa(*r.ExitCode)
				}
				if r.StartedAt != nil && r.FinishedAt != nil {
					st, e1 := time.Parse(time.RFC3339Nano, *r.StartedAt)
					fi, e2 := time.Parse(time.RFC3339Nano, *r.FinishedAt)
					if e1 == nil && e2 == nil {
						took = ui.Duration(fi.Sub(st))
					}
				}
				rows = append(rows, []string{ui.Ago(deref(r.StartedAt)), ui.StatusColor(r.Status), triggerLabel(r.Trigger), code, took, r.ID})
			}
			ui.Table([]string{"STARTED", "STATUS", "TRIGGER", "EXIT", "TOOK", "ID"}, rows)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON (with the output of each run)")
	cmd.Flags().BoolVar(&last, "last", false, "print the output of the newest run")
	return cmd
}

func (a *App) taskRmCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <task>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a scheduled task",
		Long:    "Delete a scheduled task and its run history. Asks for the task's name unless you pass --yes. To only pause it, use `serve tasks set <task> --disable`.",
		Example: "  serve tasks rm cleanup\n  serve tasks rm cleanup --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			t, err := a.findTask(ctx, s, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("a task", t.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/tasks/"+api.P(t.ID), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the task %s.", ui.Bold(t.Name))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}
