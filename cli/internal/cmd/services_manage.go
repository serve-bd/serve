package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/config"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// serviceArg lets a command name its service as the first argument instead of --service.
func (a *App) serviceArg(name string) error {
	if a.service != "" && a.service != name {
		return usagef("name the service once: %q or --service %q", name, a.service)
	}
	a.service = name
	return nil
}

// relink keeps this folder's link right after its service was renamed or moved.
func relink(s *api.Service, projectName, envName string) {
	l := config.FindLink(".")
	if l == nil || l.ServiceID != s.ID {
		return
	}
	l.ServiceName = s.Name
	if s.ProjectID != "" {
		l.ProjectID = s.ProjectID
	}
	if projectName != "" {
		l.ProjectName = projectName
	}
	if s.EnvironmentID != "" {
		l.EnvironmentID = s.EnvironmentID
	}
	if envName != "" {
		l.EnvironmentName = envName
	}
	if err := l.Save(); err != nil {
		ui.Warn("Could not update this folder's link: %v", err)
	}
}

// findEnvRef finds an environment by name or id in a project, or as project/environment.
func (a *App) findEnvRef(ctx context.Context, projectID, ref string) (*api.Environment, string, error) {
	env, err := a.findEnvironment(ctx, projectID, ref)
	if err == nil {
		return env, "", nil
	}
	if pn, en, ok := strings.Cut(ref, "/"); ok && pn != "" && en != "" {
		p, perr := a.findProject(ctx, pn)
		if perr != nil {
			return nil, "", perr
		}
		env, err := a.findEnvironment(ctx, p.ID, en)
		return env, p.Name, err
	}
	return nil, "", err
}

// envName answers the name of an environment of a project, or "".
func (a *App) envName(ctx context.Context, projectID, envID string) string {
	envs, err := a.client.Environments(ctx, projectID)
	if err != nil {
		return ""
	}
	for _, e := range envs {
		if e.ID == envID {
			return e.Name
		}
	}
	return ""
}

// startedAfterCreate follows the deployment a create with deploy: true queued.
func (a *App) startedAfterCreate(ctx context.Context, s *api.Service, noWait bool) error {
	list, err := a.client.Deployments(ctx, s.ID, 1)
	if err != nil || len(list) == 0 {
		ui.Info("Deploying %s. See it with `serve status --service %s`.", ui.Bold(s.Name), s.ID)
		return nil
	}
	return a.started(ctx, s, list[0].ID, "Deploying", noWait)
}

func (a *App) serviceCreateCmd() *cobra.Command {
	var name, image, repo, branch, gitConn, dockerfile, server, command string
	var upload, deploy, noWait, asJSON bool
	var port int
	cmd := &cobra.Command{
		Use:     "create",
		Aliases: []string{"new", "add"},
		Short:   "Create an app from an image, a Git repository, a Dockerfile, or for serve deploy",
		Long: `Create an app in the linked project (or --project) and its environment: the linked one,
--env, or else production. Pick where its code comes from:

  --image nginx:latest          a Docker image the server pulls
  --repo <url> [--branch main]  a Git repository the server builds (--git-connection for a
                                private one: the name or id of a Git connection)
  --dockerfile <file>           a Dockerfile (- reads it from stdin), built on every deploy
  --upload                      an empty app you deploy a folder to with serve deploy

Nothing is deployed unless you pass --deploy. The name defaults to the image's or the
repository's name.`,
		Example: `  serve services create --image nginx:latest --port 80 --deploy
  serve services create --repo https://github.com/acme/api --branch main --name api
  serve services create --dockerfile ./Dockerfile --name worker
  serve services create --upload --name site --env staging`,
		Args: noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			picked := 0
			for _, on := range []bool{image != "", repo != "", dockerfile != "", upload} {
				if on {
					picked++
				}
			}
			if picked != 1 {
				return usagef("pick one source: --image, --repo, --dockerfile or --upload")
			}
			if port < 0 || port > 65535 {
				return usagef("--port must be from 1 to 65535")
			}
			if (cmd.Flags().Changed("branch") || gitConn != "") && repo == "" {
				return usagef("--branch and --git-connection go with --repo")
			}
			if upload && deploy {
				return usagef("an --upload app has nothing to deploy yet: deploy a folder to it with `serve deploy`")
			}
			var source map[string]any
			switch {
			case image != "":
				source = map[string]any{"type": "image", "image": image}
				if name == "" {
					name = imageName(image)
				}
			case repo != "":
				source = map[string]any{"type": "git", "repository": repo, "branch": branch}
				if name == "" {
					name = repoName(repo)
				}
			case dockerfile != "":
				content, err := readDockerfile(dockerfile)
				if err != nil {
					return err
				}
				source = map[string]any{"type": "dockerfile", "content": content}
			default:
				source = map[string]any{"type": "upload"}
			}
			if name == "" {
				return usagef("name the app with --name")
			}

			p, link, err := a.scopeProject(ctx)
			if err != nil {
				return err
			}
			c := a.client
			if gitConn != "" {
				id, err := a.findGitConnection(ctx, gitConn)
				if err != nil {
					return err
				}
				source["credentialId"] = id
			}
			env, err := a.defaultEnvironment(ctx, p.ID, link)
			if err != nil {
				return err
			}
			body := map[string]any{"type": "app", "projectId": p.ID, "environmentId": env.ID, "name": name, "source": source, "deploy": deploy}
			if server != "" || ui.Interactive {
				id, err := a.pickServer(ctx, server)
				if err != nil {
					return err
				}
				if id != "" {
					body["serverId"] = id
				}
			}
			if port > 0 {
				body["port"] = port
			}
			var r map[string]any
			if err := c.Post(ctx, "/services", body, &r); err != nil {
				return err
			}
			id := idOf(r)
			if id == "" {
				return errors.New("the new app's id was not in the server's answer")
			}
			// The start command is a runtime setting: the create form has no field for it.
			if command != "" {
				if err := c.Patch(ctx, "/services/"+api.P(id), map[string]any{"runtime": map[string]any{"command": command}}, nil); err != nil {
					ui.Warn("The app was created, but its start command was not saved: %v", err)
				}
			}
			s, err := c.Service(ctx, id)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(s)
			}
			ui.Success("Created the %s %s in %s / %s.", s.Kind(), ui.Bold(s.Name), p.Name, env.Name)
			switch {
			case deploy:
				return a.startedAfterCreate(ctx, s, noWait)
			case upload:
				ui.Line(ui.Dim(fmt.Sprintf("Deploy a folder to it: `serve link --service %s`, then `serve deploy`.", s.ID)))
			default:
				ui.Line(ui.Dim(fmt.Sprintf("Nothing is deployed yet. Deploy it with `serve deploy --git --service %s`.", s.ID)))
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&name, "name", "n", "", "the app's name (default: from the image or the repository)")
	f.StringVar(&image, "image", "", "a Docker image, like nginx:latest")
	f.StringVar(&repo, "repo", "", "a Git repository URL")
	f.StringVar(&branch, "branch", "main", "the branch to deploy (with --repo)")
	f.StringVar(&gitConn, "git-connection", "", "the Git connection (name or id) for a private repository")
	f.StringVar(&dockerfile, "dockerfile", "", "a Dockerfile to build (- reads stdin)")
	f.BoolVar(&upload, "upload", false, "an empty app for serve deploy")
	f.IntVar(&port, "port", 0, "the port the app listens on")
	f.StringVar(&server, "server", "", "the server (name or id) to run it on (default: the one Serve runs on)")
	f.StringVar(&command, "start-command", "", "the command the container runs (overrides the image's)")
	f.BoolVar(&deploy, "deploy", false, "deploy it right away")
	f.BoolVar(&noWait, "no-wait", false, "with --deploy: do not wait for the deployment to end")
	f.BoolVar(&asJSON, "json", false, "print the new service as JSON")
	_ = cmd.RegisterFlagCompletionFunc("server", a.completeServers)
	return cmd
}

// imageName turns ghcr.io/acme/web:1.2 into web.
func imageName(image string) string {
	n := path.Base(strings.TrimSpace(image))
	n, _, _ = strings.Cut(n, "@")
	n, _, _ = strings.Cut(n, ":")
	return n
}

// repoName turns https://github.com/acme/api.git (or git@github.com:acme/api.git) into api.
func repoName(repo string) string {
	r := strings.TrimRight(strings.TrimSpace(repo), "/")
	r = strings.TrimSuffix(r, ".git")
	if i := strings.LastIndexAny(r, "/:"); i >= 0 {
		r = r[i+1:]
	}
	return r
}

func readDockerfile(p string) (string, error) {
	var b []byte
	var err error
	if p == "-" {
		b, err = io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	} else {
		b, err = os.ReadFile(p)
	}
	if err != nil {
		return "", fmt.Errorf("cannot read the Dockerfile: %w", err)
	}
	if strings.TrimSpace(string(b)) == "" {
		return "", fmt.Errorf("the Dockerfile %s is empty", p)
	}
	return string(b), nil
}

func (a *App) findGitConnection(ctx context.Context, ref string) (string, error) {
	list, err := a.client.GitCredentials(ctx)
	if err != nil {
		return "", err
	}
	for _, g := range list {
		if g.ID == ref || strings.EqualFold(g.Name, ref) {
			return g.ID, nil
		}
	}
	names := make([]string, len(list))
	for i, g := range list {
		names[i] = g.Name
	}
	if len(names) == 0 {
		return "", fmt.Errorf("there is no Git connection %q: this organization has none. Add one in the dashboard under Integrations", ref)
	}
	return "", fmt.Errorf("there is no Git connection %q. There are: %s", ref, strings.Join(names, ", "))
}

func (a *App) completeServers(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	c, err := a.Client()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	list, err := c.Servers(cmd.Context())
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = s.Name + "\t" + s.Status
	}
	return out, cobra.ShellCompDirectiveNoFileComp
}

func (a *App) serviceRenameCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "rename [service] <new name>",
		Aliases: []string{"mv"},
		Short:   "Rename a service",
		Long: `Give a service a new name: the linked one, the one named first, or --service.
Names use letters, numbers and hyphens. Variables of other services that refer to it by
name (${{name.KEY}}) need the new name too.`,
		Example: "  serve services rename api-v2\n  serve services rename web frontend",
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) < 1 || len(args) > 2 {
				return usagef("%s needs the new name (and before it, optionally, the service)", cmd.CommandPath())
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 2 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			name := strings.TrimSpace(args[len(args)-1])
			if name == "" {
				return usagef("the new name is empty")
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if s.Name == name {
				ui.Info("The service is already called %s.", name)
				return nil
			}
			var r struct {
				Service api.Service `json:"service"`
			}
			if err := a.client.Patch(ctx, "/services/"+api.P(s.ID), map[string]any{"name": name}, &r); err != nil {
				return err
			}
			newName := orName(r.Service.Name, name)
			ui.Success("Renamed %s to %s.", s.Name, ui.Bold(newName))
			s.Name = newName
			relink(s, "", "")
			return nil
		},
	}
}

func (a *App) serviceCloneCmd() *cobra.Command {
	var name, toEnv, server string
	var copyData, asJSON bool
	cmd := &cobra.Command{
		Use:     "clone [service]",
		Aliases: []string{"copy"},
		Short:   "Copy a service, into its environment or another one",
		Long: `Copy a service (the linked one, the one named, or --service): its settings, variables,
scheduled tasks (turned off) and a generated domain. The copy goes into the same environment,
or --env (a name of the same project, or project/environment), on the same server unless
--server. Nothing is deployed. --copy-data also copies a database's data.`,
		Example: "  serve services clone\n  serve services clone api --env staging\n  serve services clone postgres --env shop/qa --copy-data --name pg-qa",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if len(args) == 1 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			envID, envName, projectName := s.EnvironmentID, "", s.Project
			if toEnv != "" {
				env, pn, err := a.findEnvRef(ctx, s.ProjectID, toEnv)
				if err != nil {
					return err
				}
				envID, envName = env.ID, env.Name
				if pn != "" {
					projectName = pn
				}
			} else {
				envName = a.envName(ctx, s.ProjectID, s.EnvironmentID)
			}
			serverID := s.ServerID
			if server != "" {
				if serverID, err = a.pickServer(ctx, server); err != nil {
					return err
				}
			}
			body := map[string]any{"environmentId": envID, "serverId": serverID}
			if name != "" {
				body["name"] = name
			}
			if copyData {
				body["copyData"] = true
			}
			var r struct {
				ID          string   `json:"id"`
				Name        string   `json:"name"`
				Notes       []string `json:"notes"`
				CopyingData bool     `json:"copyingData"`
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/clone", body, &r); err != nil {
				return err
			}
			if asJSON {
				return printJSON(r)
			}
			ui.Success("Cloned %s as %s in %s / %s.", s.Name, ui.Bold(r.Name), projectName, envName)
			for _, n := range r.Notes {
				ui.Info("  %s", n)
			}
			if r.CopyingData {
				ui.Info("Its data is being copied now.")
			}
			ui.Line(ui.Dim("Nothing is deployed yet."))
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&name, "name", "n", "", "the copy's name (default: a free name based on the service's)")
	// --env here is where the copy goes, not which service to copy.
	f.StringVarP(&toEnv, "env", "e", "", "the environment to copy into (name, or project/environment)")
	f.StringVar(&server, "server", "", "the server (name or id) for the copy (default: the service's)")
	f.BoolVar(&copyData, "copy-data", false, "also copy a database's data")
	f.BoolVar(&asJSON, "json", false, "print JSON")
	_ = cmd.RegisterFlagCompletionFunc("server", a.completeServers)
	return cmd
}

func (a *App) serviceMoveCmd() *cobra.Command {
	var toEnv, server string
	var force, noWait bool
	cmd := &cobra.Command{
		Use:   "move [service] (--server <name> | --env <name>)",
		Short: "Move a service to another server or environment",
		Long: `Move a service (the linked one, the one named, or --service).

--server: its containers on the old server are removed and it is deployed fresh on the new
one. Data volumes stay on the old server, so a database starts empty there: that needs
--force (back it up first and restore it after the move).

--env: it moves to another environment (of this project, or project/environment), with its
variables and domains. References to it are rewritten.`,
		Example: "  serve services move --server worker-2\n  serve services move api --env staging\n  serve services move postgres --server db-box --force",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if (toEnv == "") == (server == "") {
				return usagef("pass --server or --env (one of them)")
			}
			if len(args) == 1 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if server != "" {
				id, err := a.pickServer(ctx, server)
				if err != nil {
					return err
				}
				if id == s.ServerID {
					ui.Info("%s already runs on that server.", s.Name)
					return nil
				}
				var r map[string]any
				err = a.client.Post(ctx, "/services/"+api.P(s.ID)+"/move", map[string]any{"serverId": id, "force": force}, &r)
				if err != nil && s.Type == "database" && !force && api.IsStatus(err, http.StatusBadRequest) {
					return fmt.Errorf("%w Pass --force to move it anyway", err)
				}
				if err != nil {
					return err
				}
				return a.started(ctx, s, api.DeploymentIDOf(r), "Moving", noWait)
			}
			env, projectName, err := a.findEnvRef(ctx, s.ProjectID, toEnv)
			if err != nil {
				return err
			}
			if env.ID == s.EnvironmentID {
				ui.Info("%s is already in %s.", s.Name, env.Name)
				return nil
			}
			var r struct {
				ProjectID       string   `json:"projectId"`
				EnvironmentName string   `json:"environmentName"`
				Moved           int      `json:"moved"`
				Warnings        []string `json:"warnings"`
			}
			if err := a.client.Post(ctx, "/services/move", map[string]any{"serviceIds": []string{s.ID}, "environmentId": env.ID}, &r); err != nil {
				return err
			}
			for _, w := range r.Warnings {
				ui.Warn("%s", w)
			}
			ui.Success("Moved %s to %s.", ui.Bold(s.Name), orName(r.EnvironmentName, env.Name))
			s.EnvironmentID = env.ID
			if r.ProjectID != "" {
				s.ProjectID = r.ProjectID
			}
			relink(s, projectName, env.Name)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&server, "server", "", "the server (name or id) to move it to")
	// --env here is where the service goes, not which service to move.
	f.StringVarP(&toEnv, "env", "e", "", "the environment to move it to (name, or project/environment)")
	f.BoolVar(&force, "force", false, "move a database although it starts empty on the new server")
	f.BoolVar(&noWait, "no-wait", false, "with --server: do not wait for the deployment on the new server")
	_ = cmd.RegisterFlagCompletionFunc("server", a.completeServers)
	return cmd
}

func (a *App) serviceSetCmd() *cobra.Command {
	var port, replicas int
	var command, healthPath string
	var autoDeploy bool
	cmd := &cobra.Command{
		Use:   "set [service]",
		Short: "Change common settings: port, start command, health check path, replicas",
		Long: `Change settings of a service (the linked one, the one named, or --service). Only the
flags you pass change. An empty value (--start-command "", --healthcheck-path "") or
--port 0 clears the setting. The changes apply on the next deploy (serve redeploy).
Other settings are in the dashboard.`,
		Example: "  serve services set --port 8080\n  serve services set api --replicas 3 --healthcheck-path /health\n  serve services set --start-command \"node server.js\"\n  serve services set --auto-deploy=false",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			fl := cmd.Flags()
			runtime := map[string]any{}
			body := map[string]any{}
			var changes []string
			if fl.Changed("port") {
				if port < 0 || port > 65535 {
					return usagef("--port must be from 1 to 65535 (0 clears it)")
				}
				if port == 0 {
					runtime["port"] = nil
					changes = append(changes, "port: none")
				} else {
					runtime["port"] = port
					changes = append(changes, fmt.Sprintf("port %d", port))
				}
			}
			if fl.Changed("replicas") {
				if replicas < 1 {
					return usagef("--replicas must be 1 or more")
				}
				runtime["replicas"] = replicas
				changes = append(changes, fmt.Sprintf("%d replica(s)", replicas))
			}
			if fl.Changed("start-command") {
				runtime["command"] = nullIfEmpty(command)
				changes = append(changes, "start command "+orName(strings.TrimSpace(command), "(the image's)"))
			}
			if fl.Changed("healthcheck-path") {
				runtime["healthcheckPath"] = nullIfEmpty(healthPath)
				changes = append(changes, "health check path "+orName(strings.TrimSpace(healthPath), "(none)"))
			}
			if fl.Changed("auto-deploy") {
				body["autoDeploy"] = autoDeploy
				changes = append(changes, fmt.Sprintf("deploy on push %s", map[bool]string{true: "on", false: "off"}[autoDeploy]))
			}
			if len(changes) == 0 {
				return usagef("pass a setting to change, like --port 8080 (see --help)")
			}
			if len(args) == 1 {
				if err := a.serviceArg(args[0]); err != nil {
					return err
				}
			}
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			if len(runtime) > 0 {
				if s.Type == "compose" {
					return fmt.Errorf("%s is a compose stack: its ports, commands and replicas are in its compose file", s.Name)
				}
				body["runtime"] = runtime
			}
			if err := a.client.Patch(ctx, "/services/"+api.P(s.ID), body, nil); err != nil {
				return err
			}
			ui.Success("Saved %s: %s.", ui.Bold(s.Name), strings.Join(changes, ", "))
			if len(runtime) > 0 {
				ui.Line(ui.Dim("The changes apply on the next deploy: `serve redeploy`."))
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.IntVar(&port, "port", 0, "the port the app listens on (0 clears it)")
	f.IntVar(&replicas, "replicas", 0, "how many copies run")
	f.StringVar(&command, "start-command", "", "the command the container runs (overrides the image's)")
	f.StringVar(&healthPath, "healthcheck-path", "", "the path checked before traffic moves to a new deployment, like /health")
	f.BoolVar(&autoDeploy, "auto-deploy", true, "deploy on every push (git apps)")
	return cmd
}

func nullIfEmpty(s string) any {
	if s = strings.TrimSpace(s); s == "" {
		return nil
	}
	return s
}
