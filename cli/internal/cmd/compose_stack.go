package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/dotenv"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// StackFile is the file `serve compose up` reads when -f is not given.
const StackFile = "serve-compose.yml"

// maxStackFile caps each file read for a stack (the stack itself, env files, compose files).
const maxStackFile = 1 << 20

type stackFlags struct {
	file                                                     string
	dryRun, force, removeOrphans, redeploy, noDeploy, noWait bool
	asJSON                                                   bool
}

type stackPlanService struct {
	Key      string   `json:"key"`
	Kind     string   `json:"kind"`
	Action   string   `json:"action"`
	Name     string   `json:"name"`
	Changes  []string `json:"changes"`
	Kept     []string `json:"kept"`
	Wave     int      `json:"wave"`
	Upload   *string  `json:"upload"`
	GitLogin *string  `json:"gitLogin"`
}

type stackPlan struct {
	Stack *string `json:"stack"`
	Ready bool    `json:"ready"`
	Needs struct {
		Variables []string `json:"variables"`
		Files     []string `json:"files"`
	} `json:"needs"`
	Errors   []string           `json:"errors"`
	Warnings []string           `json:"warnings"`
	Services []stackPlanService `json:"services"`
	Orphans  []struct {
		Key    string `json:"key"`
		Name   string `json:"name"`
		Remove bool   `json:"remove"`
	} `json:"orphans"`
}

type stackRunView struct {
	ID       string `json:"id"`
	Stack    string `json:"stack"`
	Status   string `json:"status"`
	Services []struct {
		Key            string  `json:"key"`
		ServiceID      string  `json:"serviceId"`
		State          string  `json:"state"`
		DeploymentID   *string `json:"deploymentId"`
		Note           *string `json:"note"`
		AwaitingUpload bool    `json:"awaitingUpload"`
	} `json:"services"`
}

// stackDoc is a stack file read from disk, with what the server asks for next to it.
type stackDoc struct {
	path, dir, text string
}

func readStack(file string) (*stackDoc, error) {
	if file == "" {
		file = StackFile
		if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
			if _, err := os.Stat("serve-compose.yaml"); err == nil {
				file = "serve-compose.yaml"
			}
		}
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		return nil, err
	}
	b, err := readCapped(abs)
	if errors.Is(err, os.ErrNotExist) {
		return nil, usagef("there is no %s here. Pass -f with its path", file)
	}
	if err != nil {
		return nil, err
	}
	return &stackDoc{path: abs, dir: filepath.Dir(abs), text: string(b)}, nil
}

func readCapped(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxStackFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxStackFile {
		return nil, fmt.Errorf("%s is larger than 1 MB", path)
	}
	return b, nil
}

// local resolves a path the stack names: inside the stack's folder only (symlinks too), so a
// file or a server's answer can never make the CLI read or send anything else.
func (d *stackDoc) local(p string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(p))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.VolumeName(clean) != "" {
		return "", fmt.Errorf("%s is outside the stack's folder", p)
	}
	full := filepath.Join(d.dir, clean)
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("%s does not exist (next to %s)", p, filepath.Base(d.path))
		}
		return "", err
	}
	root, err := filepath.EvalSymlinks(d.dir)
	if err != nil {
		return "", err
	}
	if real != root && !strings.HasPrefix(real, root+string(filepath.Separator)) {
		return "", fmt.Errorf("%s leads outside the stack's folder", p)
	}
	return real, nil
}

// values are the ${VAR}s the file names: the shell first, then a .env next to the file, like
// docker compose. Only the names asked for leave this machine.
func (d *stackDoc) values(names []string) (map[string]string, error) {
	fromFile := map[string]string{}
	if b, err := readCapped(filepath.Join(d.dir, ".env")); err == nil {
		vars, err := dotenv.Parse(string(b))
		if err != nil {
			return nil, fmt.Errorf(".env: %w", err)
		}
		for _, v := range vars {
			fromFile[v.Key] = v.Value
		}
	}
	out := map[string]string{}
	inFile := map[string]bool{}
	for _, m := range varRef.FindAllStringSubmatch(d.text, -1) {
		inFile[m[1]] = true
	}
	for _, n := range names {
		// Only what the file itself names: a server asking for more (SERVE_TOKEN, cloud keys) gets nothing.
		if !inFile[n] {
			continue
		}
		if v, ok := os.LookupEnv(n); ok {
			out[n] = v
		} else if v, ok := fromFile[n]; ok {
			out[n] = v
		}
	}
	return out, nil
}

// varRef is a ${NAME} the file uses (not a ${{ }} link).
var varRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)`)

// names says whether the file itself names this path as a value (env_file, compose), so a server
// can only ever get the files the file points at.
func (d *stackDoc) names(p string) bool {
	re := regexp.MustCompile(`(?m)(^|[\s\[,:'"])(\./)?` + regexp.QuoteMeta(p) + `(['"\],\s#]|$)`)
	return re.MatchString(d.text)
}

var stackNameLine = regexp.MustCompile(`(?m)^name:\s*["']?([A-Za-z0-9-]+)["']?\s*(#.*)?$`)

// name is the stack's name: the file's name: line, else its folder's name as the server makes it.
func (d *stackDoc) name() string {
	if m := stackNameLine.FindStringSubmatch(d.text); m != nil {
		return m[1]
	}
	// A name the file fills in (name: ${STACK}) is not known here: the folder's name could be another stack's.
	if regexp.MustCompile(`(?m)^name:`).MatchString(d.text) {
		return ""
	}
	n := regexp.MustCompile(`[^A-Za-z0-9-]+`).ReplaceAllString(strings.ReplaceAll(strings.TrimSpace(filepath.Base(d.dir)), " ", "-"), "")
	return strings.Trim(regexp.MustCompile(`-+`).ReplaceAllString(n, "-"), "-")
}

// stackEnvironment is the environment a compose command works on: --project/--env, the link, or a pick.
func (a *App) stackEnvironment(ctx context.Context) (*api.Project, *api.Environment, error) {
	p, link, err := a.scopeProject(ctx)
	if err != nil {
		return nil, nil, err
	}
	e, err := a.defaultEnvironment(ctx, p.ID, link)
	if err != nil {
		return nil, nil, err
	}
	return p, e, nil
}

// plan asks the server what up would do: once for the names the file uses, then with their
// values and the files it names.
func (a *App) stackPlan(ctx context.Context, envID string, d *stackDoc, f stackFlags) (*stackPlan, map[string]any, error) {
	body := map[string]any{"file": d.text, "folder": filepath.Base(d.dir), "client": "cli", "force": f.force, "removeOrphans": f.removeOrphans}
	var r struct {
		Plan stackPlan `json:"plan"`
	}
	path := "/environments/" + api.P(envID) + "/stacks/plan"
	if err := a.client.Do(ctx, api.Request{Method: "POST", Path: path, JSON: body}, &r); err != nil {
		return nil, nil, err
	}
	values, err := d.values(r.Plan.Needs.Variables)
	if err != nil {
		return nil, nil, err
	}
	body["values"] = values
	// Files are named only once every ${VAR} is known: their paths may hold some.
	if err := a.client.Do(ctx, api.Request{Method: "POST", Path: path, JSON: body}, &r); err != nil {
		return nil, nil, err
	}
	if len(r.Plan.Needs.Files) > 0 {
		files := map[string]string{}
		for _, p := range r.Plan.Needs.Files {
			if !d.names(p) {
				return nil, nil, fmt.Errorf("the server asked for %s, which %s does not name. Nothing was sent", p, filepath.Base(d.path))
			}
			full, err := d.local(p)
			if err != nil {
				return nil, nil, err
			}
			b, err := readCapped(full)
			if err != nil {
				return nil, nil, err
			}
			files[p] = string(b)
		}
		body["files"] = files
		if err := a.client.Do(ctx, api.Request{Method: "POST", Path: path, JSON: body}, &r); err != nil {
			return nil, nil, err
		}
	}
	return &r.Plan, body, nil
}

func printStackPlan(p *stackPlan) {
	if p.Stack != nil {
		ui.Info("Stack %s", ui.Bold(*p.Stack))
	}
	rows := [][]string{}
	for _, s := range p.Services {
		what := strings.Join(s.Changes, "; ")
		if len(s.Kept) > 0 {
			kept := "kept as changed in the dashboard: " + strings.Join(s.Kept, ", ")
			if what != "" {
				what += "; "
			}
			what += kept
		}
		if s.Upload != nil {
			what = strings.TrimPrefix(what+"; uploads "+*s.Upload, "; ")
		}
		rows = append(rows, []string{s.Key, s.Kind, s.Action, fmt.Sprint(s.Wave + 1), what})
	}
	if len(rows) > 0 {
		ui.Table([]string{"SERVICE", "KIND", "ACTION", "WAVE", "DETAILS"}, rows)
	}
	for _, o := range p.Orphans {
		if o.Remove {
			ui.Warn("%s (%s) is no longer in the file: it will be removed.", o.Key, o.Name)
		}
	}
	for _, w := range p.Warnings {
		ui.Warn("%s", w)
	}
	for _, e := range p.Errors {
		ui.Error(e)
	}
}

func (a *App) composeUpCmd() *cobra.Command {
	var f stackFlags
	cmd := &cobra.Command{
		Use:   "up",
		Short: "Create, update and deploy the services of serve-compose.yml",
		Long: `Read serve-compose.yml (or -f) and make the environment match it: missing services are
created, the stack's existing ones updated, and they deploy in waves, each after what it
depends on (depends_on, and the services its ${{ }} links point at).

${VAR} values come from your shell, then from a .env next to the file. Only the names the
file uses are sent. Files the stack names (env_file, compose) and folders it builds
(build: ./web) must sit inside the stack's folder.

Running up again changes only what changed. A value edited in the dashboard since the last
up stays, unless --force. Services removed from the file stay, unless --remove-orphans.`,
		Example: "  serve compose up\n  serve compose up -f deploy/serve-compose.yml --env staging\n  serve compose up --dry-run",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.composeUp(cmd.Context(), f)
		},
	}
	fl := cmd.Flags()
	fl.StringVarP(&f.file, "file", "f", "", "the stack `file` (default serve-compose.yml)")
	fl.BoolVar(&f.dryRun, "dry-run", false, "show what would change, and change nothing")
	fl.BoolVar(&f.force, "force", false, "the file's values win over changes made in the dashboard")
	fl.BoolVar(&f.removeOrphans, "remove-orphans", false, "remove the stack's services that are no longer in the file (their volumes stay)")
	fl.BoolVar(&f.redeploy, "redeploy", false, "deploy services that did not change too")
	fl.BoolVar(&f.noDeploy, "no-deploy", false, "make the changes without deploying")
	fl.BoolVar(&f.noWait, "no-wait", false, "start the deploy and return without following it")
	fl.BoolVar(&f.asJSON, "json", false, "print the result as JSON")
	return cmd
}

func (a *App) composeUp(ctx context.Context, f stackFlags) error {
	d, err := readStack(f.file)
	if err != nil {
		return err
	}
	p, env, err := a.stackEnvironment(ctx)
	if err != nil {
		return err
	}
	if !f.asJSON {
		ui.Info("%s to %s", ui.Bold(filepath.Base(d.path)), ui.Bold(p.Name+" / "+env.Name))
	}
	plan, body, err := a.stackPlan(ctx, env.ID, d, f)
	if err != nil {
		return err
	}
	if f.dryRun || !plan.Ready {
		if f.asJSON {
			if err := printJSON(plan); err != nil {
				return err
			}
		} else {
			printStackPlan(plan)
		}
		if !plan.Ready {
			return silentExit(ExitError)
		}
		return nil
	}
	if !f.asJSON {
		printStackPlan(plan)
	}
	body["redeploy"] = f.redeploy
	body["noDeploy"] = f.noDeploy
	var r struct {
		Services []struct {
			Key       string  `json:"key"`
			ServiceID string  `json:"serviceId"`
			Name      string  `json:"name"`
			Action    string  `json:"action"`
			Upload    *string `json:"upload"`
		} `json:"services"`
		RunID *string `json:"runId"`
	}
	if err := a.client.Do(ctx, api.Request{Method: "POST", Path: "/environments/" + api.P(env.ID) + "/stacks/up", JSON: body}, &r); err != nil {
		return err
	}
	if r.RunID == nil {
		if f.asJSON {
			return printJSON(r)
		}
		ui.Success("Applied %s without deploying.", ui.Bold(*plan.Stack))
		return nil
	}
	runID := *r.RunID
	// Folders go up now; each service deploys when its turn comes.
	for _, s := range r.Services {
		if s.Upload == nil {
			continue
		}
		dir, err := d.local(*s.Upload)
		if err != nil {
			return fmt.Errorf("%s: %w", s.Key, err)
		}
		svc, err := a.client.Service(ctx, s.ServiceID)
		if err != nil {
			return err
		}
		if _, err := a.upload(ctx, a.client, svc, dir, deployFlags{stackRun: runID}); err != nil {
			return fmt.Errorf("%s: %w", s.Key, err)
		}
	}
	if f.noWait {
		if f.asJSON {
			return printJSON(r)
		}
		ui.Success("Deploying %s (run %s). Follow it with `serve compose ps`.", ui.Bold(*plan.Stack), runID)
		return nil
	}
	return a.followStackRun(ctx, runID, f.asJSON)
}

// StackPoll is how often a stack run is checked while it is followed.
var StackPoll = 2 * time.Second

func (a *App) followStackRun(ctx context.Context, runID string, asJSON bool) error {
	seen := map[string]string{}
	for {
		var r struct {
			Run stackRunView `json:"run"`
		}
		if err := a.client.Get(ctx, "/stack-runs/"+api.P(runID), nil, &r); err != nil {
			return err
		}
		if !asJSON {
			for _, s := range r.Run.Services {
				line := s.State
				if s.Note != nil && *s.Note != "" {
					line += ": " + *s.Note
				}
				if seen[s.Key] == line {
					continue
				}
				seen[s.Key] = line
				switch s.State {
				case "success":
					ui.Success("%s deployed", ui.Bold(s.Key))
				case "unchanged":
					ui.Line(ui.Dim(fmt.Sprintf("  %s unchanged", s.Key)))
				case "failed", "skipped":
					ui.Warn("%s %s", ui.Bold(s.Key), line)
				default:
					ui.Info("  %s %s", s.Key, line)
				}
			}
		}
		if r.Run.Status != "running" {
			if asJSON {
				if err := printJSON(r.Run); err != nil {
					return err
				}
			}
			if r.Run.Status == "success" {
				if !asJSON {
					ui.Success("%s is up.", ui.Bold(r.Run.Stack))
				}
				return nil
			}
			return exit(ExitDeployed, "the stack did not deploy in full (%s). See the services above", r.Run.Status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(StackPoll):
		}
	}
}

func (a *App) composeConfigCmd() *cobra.Command {
	var f stackFlags
	cmd := &cobra.Command{
		Use:     "config",
		Short:   "Check serve-compose.yml and show what up would do",
		Long:    "Check the stack file against the environment and show each service's action, changes and deploy wave. Changes nothing. Exits with 1 when the file has problems.",
		Example: "  serve compose config\n  serve compose config -f stack.yml --json",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			f.dryRun = true
			return a.composeUp(cmd.Context(), f)
		},
	}
	cmd.Flags().StringVarP(&f.file, "file", "f", "", "the stack `file` (default serve-compose.yml)")
	cmd.Flags().BoolVar(&f.force, "force", false, "show the plan as with up --force")
	cmd.Flags().BoolVar(&f.asJSON, "json", false, "print the plan as JSON")
	return cmd
}

type stackStatus struct {
	Name     string `json:"name"`
	Services []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Type     string `json:"type"`
		Status   string `json:"status"`
		StackKey string `json:"stackKey"`
	} `json:"services"`
	LastRun *stackRunView `json:"lastRun"`
}

func (a *App) stacksOf(ctx context.Context, envID, name string) ([]stackStatus, error) {
	q := url.Values{}
	if name != "" {
		q.Set("name", name)
	}
	var r struct {
		Stacks []stackStatus `json:"stacks"`
	}
	err := a.client.Get(ctx, "/environments/"+api.P(envID)+"/stacks", q, &r)
	return r.Stacks, err
}

func (a *App) composePsCmd() *cobra.Command {
	var asJSON bool
	var file string
	cmd := &cobra.Command{
		Use:     "ps [stack]",
		Short:   "Show the services of a stack and how its last deploy went",
		Long:    "Show the stack's services with their status and its last deploy. Without a name: the stack of serve-compose.yml here, or every stack of the environment when there is no file.",
		Example: "  serve compose ps\n  serve compose ps shop --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			_, env, err := a.stackEnvironment(ctx)
			if err != nil {
				return err
			}
			name := ""
			if len(args) == 1 {
				name = args[0]
			} else if d, err := readStack(file); err == nil {
				name = d.name()
			}
			stacks, err := a.stacksOf(ctx, env.ID, name)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(stacks)
			}
			if len(stacks) == 0 {
				ui.Info("No stacks in this environment yet. Run serve compose up.")
				return nil
			}
			for _, s := range stacks {
				last := "never deployed"
				if s.LastRun != nil {
					last = "last deploy " + s.LastRun.Status
				}
				ui.Info("%s  %s", ui.Bold(s.Name), ui.Dim(last))
				rows := [][]string{}
				for _, x := range s.Services {
					rows = append(rows, []string{x.StackKey, x.Name, x.Type, ui.StatusColor(x.Status)})
				}
				ui.Table([]string{"SERVICE", "NAME", "TYPE", "STATUS"}, rows)
				if s.LastRun != nil {
					for _, r := range s.LastRun.Services {
						if r.Note != nil && *r.Note != "" && (r.State == "failed" || r.State == "skipped" || r.State == "waiting") {
							ui.Warn("%s %s: %s", r.Key, r.State, *r.Note)
						}
					}
				}
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "the stack `file` whose name to use (default serve-compose.yml)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print as JSON")
	return cmd
}

func (a *App) composeDownCmd() *cobra.Command {
	var volumes, yes, asJSON bool
	var file string
	cmd := &cobra.Command{
		Use:   "down [stack]",
		Short: "Remove the services of a stack",
		Long: `Remove every service of a stack from the environment. Their volumes (database data
included) stay unless --volumes. Without a name: the stack of serve-compose.yml here.`,
		Example: "  serve compose down\n  serve compose down shop --volumes --yes",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			_, env, err := a.stackEnvironment(ctx)
			if err != nil {
				return err
			}
			name := ""
			if len(args) == 1 {
				name = args[0]
			} else {
				d, err := readStack(file)
				if err != nil {
					return err
				}
				name = d.name()
			}
			if name == "" {
				return usagef("name the stack: serve compose down <stack>")
			}
			stacks, err := a.stacksOf(ctx, env.ID, name)
			if err != nil {
				return err
			}
			if len(stacks) == 0 {
				return fmt.Errorf("no stack named %s in %s", name, env.Name)
			}
			names := []string{}
			for _, s := range stacks[0].Services {
				names = append(names, s.Name)
			}
			what := "Remove " + listSome(names, 6) + " from " + env.Name + "?"
			if volumes {
				what = "Remove " + listSome(names, 6) + " and their data (volumes, databases included) from " + env.Name + "? This cannot be undone."
			}
			if err := confirmAction(what, yes); err != nil {
				return err
			}
			q := url.Values{}
			if volumes {
				q.Set("volumes", "1")
			}
			var r struct {
				Removed []string `json:"removed"`
			}
			if err := a.client.Do(ctx, api.Request{Method: "DELETE", Path: "/environments/" + api.P(env.ID) + "/stacks/" + api.P(name), Query: q}, &r); err != nil {
				return err
			}
			if asJSON {
				return printJSON(r)
			}
			ui.Success("Removed %s.", listSome(r.Removed, 10))
			if !volumes {
				ui.Line(ui.Dim("  Their volumes stay. serve compose down --volumes removes them too."))
			}
			return nil
		},
	}
	fl := cmd.Flags()
	fl.BoolVarP(&volumes, "volumes", "v", false, "remove their volumes too (database data included)")
	fl.BoolVarP(&yes, "yes", "y", false, "do not ask")
	fl.StringVarP(&file, "file", "f", "", "the stack `file` whose name to use (default serve-compose.yml)")
	fl.BoolVar(&asJSON, "json", false, "print as JSON")
	return cmd
}

func (a *App) composeExportCmd() *cobra.Command {
	var out, stack, services string
	var values, force bool
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Write an environment's services as a serve-compose.yml",
		Long: `Write the environment's services (or one stack's, or --services) as a serve-compose.yml
with the files it names, ready for serve compose up in another project or another Serve.
Links between services stay as ${{ }}. Variable values go to .env.<service> files only with
--with-values; otherwise the files list the names to fill in. Database data is not part of
it: restore a backup in the new place.`,
		Example: "  serve compose export -o ./shop\n  serve compose export --stack shop --with-values -o ./copy",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			_, env, err := a.stackEnvironment(ctx)
			if err != nil {
				return err
			}
			q := url.Values{}
			if stack != "" {
				q.Set("stack", stack)
			}
			if services != "" {
				q.Set("services", services)
			}
			if values {
				q.Set("values", "1")
			}
			var r struct {
				File  string            `json:"file"`
				Files map[string]string `json:"files"`
				Notes []string          `json:"notes"`
			}
			if err := a.client.Get(ctx, "/environments/"+api.P(env.ID)+"/stacks/export", q, &r); err != nil {
				return err
			}
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			all := map[string]string{StackFile: r.File}
			for p, text := range r.Files {
				all[p] = text
			}
			// Nothing is written unless every file can be: no half export over existing files.
			doc := &stackDoc{dir: out}
			for p := range all {
				clean := filepath.Clean(filepath.FromSlash(p))
				if !safeFileName(p) || clean != p {
					return fmt.Errorf("the server named a file this folder cannot hold: %s", p)
				}
				if _, err := os.Lstat(filepath.Join(doc.dir, clean)); err == nil && !force {
					return usagef("%s already exists. Pass --force to write over it, or -o another folder", filepath.Join(out, clean))
				}
			}
			for p, text := range all {
				mode := os.FileMode(0o644)
				if strings.HasPrefix(p, ".env") {
					mode = 0o600
				}
				if err := writeReplacing(filepath.Join(out, p), []byte(text), mode); err != nil {
					return err
				}
			}
			ui.Success("Wrote %s and %d more file(s) to %s.", StackFile, len(r.Files), out)
			for _, n := range r.Notes {
				ui.Warn("%s", n)
			}
			return nil
		},
	}
	fl := cmd.Flags()
	fl.StringVarP(&out, "output", "o", ".", "the `folder` to write to")
	fl.StringVar(&stack, "stack", "", "only this stack's services")
	fl.StringVar(&services, "services", "", "only these services (`names`, comma separated)")
	fl.BoolVar(&values, "with-values", false, "write variable values into the .env files (needs the right to view secrets)")
	fl.BoolVar(&force, "force", false, "write over files that exist")
	return cmd
}

// safeFileName is a plain file name: no folders, nothing Windows treats as a device or a drive.
func safeFileName(p string) bool {
	if !regexp.MustCompile(`^[A-Za-z0-9._-]+$`).MatchString(p) || p == "." || p == ".." {
		return false
	}
	base := strings.ToUpper(strings.SplitN(p, ".", 2)[0])
	return !regexp.MustCompile(`^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$`).MatchString(base)
}

// writeReplacing writes a new file and renames it into place: an existing file or symlink there
// is replaced, never written through, and the new file gets mode from the start.
func writeReplacing(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".serve-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
