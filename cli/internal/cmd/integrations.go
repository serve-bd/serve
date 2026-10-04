package cmd

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Integrations: container registries, S3 storage, notification channels, secret managers, Git
// connections and Cloudflare. Secrets are read from a flag, a file or stdin and never printed.

// integration is the shared part of a list of named things with an id.
type integration[T any] struct {
	path, key, what, listCmd string
	id                       func(T) string
	name                     func(T) string
}

func (in integration[T]) list(ctx context.Context, a *App) (*api.Listed[T], error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	return api.List[T](ctx, c, in.path, in.key, nil)
}

func (in integration[T]) find(ctx context.Context, a *App, ref string) (*T, error) {
	l, err := in.list(ctx, a)
	if err != nil {
		return nil, err
	}
	return pickOne(l.Items, ref, in.what, in.listCmd, in.id, func(v T) []string { return []string{in.name(v)} })
}

// testCmd checks that a saved integration still works.
func (in integration[T]) testCmd(a *App, short, done string) *cobra.Command {
	return &cobra.Command{
		Use:     "test <name>",
		Short:   short,
		Long:    short + ". Prints the reason when it fails.",
		Example: fmt.Sprintf("  %s test <name>", strings.TrimSuffix(in.listCmd, " ls")),
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			v, err := in.find(ctx, a, args[0])
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, in.path+"/"+api.P(in.id(*v))+"/test", nil, nil); err != nil {
				return err
			}
			ui.Success(done, ui.Bold(txt(in.name(*v))))
			return nil
		},
	}
}

// rmCmd deletes a saved integration after asking for its name.
func (in integration[T]) rmCmd(a *App, short, long string) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:     "rm <name>",
		Aliases: []string{"delete", "remove"},
		Short:   short,
		Long:    long + " Asks for its name unless you pass --yes.",
		Example: fmt.Sprintf("  %s rm <name> --yes", strings.TrimSuffix(in.listCmd, " ls")),
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			v, err := in.find(ctx, a, args[0])
			if err != nil {
				return err
			}
			name := in.name(*v)
			if err := confirmName("a "+in.what, name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, in.path+"/"+api.P(in.id(*v)), nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted %s.", ui.Bold(txt(name)))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	return cmd
}

// keyValues turns --set KEY=value and --set-file KEY=path into a map (path - is stdin).
func keyValues(sets, files []string) (map[string]string, error) {
	out := map[string]string{}
	for _, s := range sets {
		k, v, ok := strings.Cut(s, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, usagef("--set %q is not KEY=value", s)
		}
		out[strings.TrimSpace(k)] = v
	}
	stdinUsed := false
	for _, s := range files {
		k, path, ok := strings.Cut(s, "=")
		if !ok || strings.TrimSpace(k) == "" || path == "" {
			return nil, usagef("--set-file %q is not KEY=path", s)
		}
		if path == "-" {
			if stdinUsed {
				return nil, usagef("only one value can come from stdin")
			}
			stdinUsed = true
		}
		v, err := secretSource{file: path}.read(k, "set")
		if err != nil {
			return nil, err
		}
		out[strings.TrimSpace(k)] = v
	}
	return out, nil
}

/* -------------------------------- Registries ------------------------------- */

var registries = integration[api.Registry]{
	path: "/registries", key: "registries", what: "registry", listCmd: "serve registries ls",
	id: func(r api.Registry) string { return r.ID }, name: func(r api.Registry) string { return r.Name },
}

var registryKinds = []string{"dockerhub", "ghcr", "gitlab", "generic"}

func (a *App) registriesCmd() *cobra.Command {
	cmd := lsCmd("registries", "List container registries", []string{"registry"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := registries.list(cmd.Context(), a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No container registries. Add one with `serve registries add`.")
			return nil
		}
		var rows [][]string
		for _, r := range l.Items {
			rows = append(rows, []string{txt(r.Name), r.Kind, r.Host, txt(r.Username), txt(deref(r.Namespace)), r.ID})
		}
		ui.Table([]string{"NAME", "KIND", "HOST", "USERNAME", "NAMESPACE", "ID"}, rows)
		return nil
	})
	cmd.Short = "Container registries: list, add, test, delete"
	cmd.Long = "List the container registries Serve logs in to, to pull private images and push built ones. Passwords are never shown."
	cmd.Example = "  serve registries\n  serve registries add ghcr --kind ghcr --username ada --password-file token.txt\n  serve registries test ghcr"

	var kind, host, username, namespace string
	var secret secretSource
	add := &cobra.Command{
		Use:   "add <name>",
		Short: "Add a container registry",
		Long: `Add a container registry. --kind is dockerhub, ghcr, gitlab or generic (the default with
--host). The known kinds fill in the host. The login is checked before it is saved.
The password or access token comes from --password-file, --secret-stdin, --password, or a
hidden prompt.`,
		Example: "  serve registries add ghcr --kind ghcr --username ada --password-file token.txt\n  echo \"$TOKEN\" | serve registries add mine --host registry.example.com --username ci --secret-stdin",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if kind == "" {
				if host == "" {
					return usagef("pass --kind (%s), or --host for another registry", strings.Join(registryKinds, ", "))
				}
				kind = "generic"
			}
			if !slices.Contains(registryKinds, kind) {
				return usagef("--kind must be one of %s", strings.Join(registryKinds, ", "))
			}
			if kind == "generic" && host == "" {
				return usagef("a generic registry needs --host")
			}
			if username == "" {
				return usagef("pass the registry --username")
			}
			password, err := secret.read("password", "password")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"kind": kind, "name": args[0], "host": host, "username": username, "password": password, "namespace": namespace}
			if err := c.Post(cmd.Context(), "/registries", body, nil); err != nil {
				return err
			}
			ui.Success("Added the registry %s: the login works.", ui.Bold(args[0]))
			return nil
		},
	}
	add.Flags().StringVar(&kind, "kind", "", "dockerhub, ghcr, gitlab or generic")
	add.Flags().StringVar(&host, "host", "", "the registry host, like registry.example.com:5000")
	add.Flags().StringVar(&username, "username", "", "the login name")
	add.Flags().StringVar(&namespace, "namespace", "", "the account or group images go under (optional)")
	secret.flags(add, "password", "password or access token")
	cmd.AddCommand(add,
		registries.testCmd(a, "Check that Serve can still log in to a registry", "The login to %s works."),
		registries.rmCmd(a, "Delete a container registry", "Delete a container registry. Services that pull from it can no longer pull private images."))
	return cmd
}

/* ---------------------------------- S3 ------------------------------------- */

var s3Destinations = integration[api.S3Destination]{
	path: "/s3-destinations", key: "destinations", what: "S3 destination", listCmd: "serve s3 ls",
	id: func(d api.S3Destination) string { return d.ID }, name: func(d api.S3Destination) string { return d.Name },
}

func (a *App) s3Cmd() *cobra.Command {
	cmd := lsCmd("s3", "List S3 storage for backups", []string{"storage"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := s3Destinations.list(cmd.Context(), a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No S3 storage. Add one with `serve s3 add`.")
			return nil
		}
		var rows [][]string
		for _, d := range l.Items {
			rows = append(rows, []string{txt(d.Name), d.Endpoint, txt(d.Bucket), deref(d.Region), txt(deref(d.PathPrefix)), d.ID})
		}
		ui.Table([]string{"NAME", "ENDPOINT", "BUCKET", "REGION", "PREFIX", "ID"}, rows)
		return nil
	})
	cmd.Short = "S3 storage for backups: list, add, test, delete"
	cmd.Long = "List the S3-compatible storage that backups go to. Keys are never shown."
	cmd.Example = "  serve s3\n  serve s3 add backups --endpoint https://s3.eu-central-1.amazonaws.com --bucket my-backups --access-key-id AKIA... --secret-stdin\n  serve s3 test backups"

	var endpoint, region, bucket, prefix, keyID string
	var secret secretSource
	add := &cobra.Command{
		Use:   "add <name>",
		Short: "Add S3 storage",
		Long: `Add S3-compatible storage for backups. The secret access key comes from
--secret-access-key-file, --secret-stdin, --secret-access-key, or a hidden prompt.`,
		Example: "  serve s3 add backups --endpoint https://s3.eu-central-1.amazonaws.com --region eu-central-1 \\\n    --bucket my-backups --access-key-id AKIA... --secret-access-key-file key.txt",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if endpoint == "" || bucket == "" || keyID == "" {
				return usagef("pass --endpoint, --bucket and --access-key-id")
			}
			key, err := secret.read("secret access key", "secret-access-key")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "endpoint": endpoint, "bucket": bucket, "accessKeyId": keyID, "secretAccessKey": key}
			if region != "" {
				body["region"] = region
			}
			if prefix != "" {
				body["pathPrefix"] = prefix
			}
			if err := c.Post(cmd.Context(), "/s3-destinations", body, nil); err != nil {
				return err
			}
			ui.Success("Added the S3 storage %s.", ui.Bold(args[0]))
			ui.Line(ui.Dim("Check it with: serve s3 test " + args[0]))
			return nil
		},
	}
	add.Flags().StringVar(&endpoint, "endpoint", "", "the S3 address, like https://s3.eu-central-1.amazonaws.com")
	add.Flags().StringVar(&region, "region", "", "the region (auto by default)")
	add.Flags().StringVar(&bucket, "bucket", "", "the bucket")
	add.Flags().StringVar(&prefix, "prefix", "", "a folder in the bucket for the backups (optional)")
	add.Flags().StringVar(&keyID, "access-key-id", "", "the access key id")
	secret.flags(add, "secret-access-key", "secret access key")
	cmd.AddCommand(add,
		s3Destinations.testCmd(a, "Check that Serve can write to an S3 storage", "Serve can use the bucket of %s."),
		s3Destinations.rmCmd(a, "Delete S3 storage", "Delete S3 storage from Serve. The bucket and the backups in it stay."))
	return cmd
}

/* ------------------------------ Notifications ------------------------------ */

var channels = integration[api.NotificationChannel]{
	path: "/notification-channels", key: "channels", what: "notification channel", listCmd: "serve notifications ls",
	id: func(c api.NotificationChannel) string { return c.ID }, name: func(c api.NotificationChannel) string { return c.Name },
}

// notifyEvents mirrors the event catalog of src/lib/notifications.ts; info marks the events a new
// channel does not get by default (the dashboard's default too).
var notifyEvents = []struct {
	id   string
	info bool
}{
	{"deploy.success", true}, {"deploy.failed", false}, {"deploy.waiting", false},
	{"service.down", false}, {"service.recovered", true}, {"service.crashed", false}, {"container.crashloop", false},
	{"backup.success", true}, {"backup.failed", false},
	{"certificate.renewed", true}, {"certificate.failed", false},
	{"server.resource", false}, {"server.disk", false}, {"server.updates", true},
	{"task.failed", false}, {"org.limit", false},
	{"instance.backup.success", true}, {"instance.backup.failed", false},
	{"instance.update.available", true}, {"instance.update.success", true}, {"instance.update.failed", false},
}

// mainSecret is the field --secret-stdin fills, per channel type.
var mainSecret = map[string]string{
	"slack": "webhookUrl", "discord": "webhookUrl", "teams": "webhookUrl", "googlechat": "webhookUrl",
	"mattermost": "webhookUrl", "rocketchat": "webhookUrl", "telegram": "botToken", "matrix": "accessToken",
	"ntfy": "token", "gotify": "token", "pushover": "token", "pushbullet": "accessToken",
	"pagerduty": "routingKey", "opsgenie": "apiKey", "twilio": "authToken", "webhook": "secret",
}

func eventList(s string) ([]string, error) {
	var all, defaults []string
	for _, e := range notifyEvents {
		all = append(all, e.id)
		if !e.info {
			defaults = append(defaults, e.id)
		}
	}
	switch s {
	case "":
		return defaults, nil
	case "all":
		return all, nil
	}
	list := splitList(s)
	for _, e := range list {
		if !slices.Contains(all, e) {
			return nil, usagef("%q is not an event. Known: %s (or all)", e, strings.Join(all, ", "))
		}
	}
	if len(list) == 0 {
		return nil, usagef("--events needs at least one event")
	}
	return list, nil
}

func (a *App) notificationsCmd() *cobra.Command {
	cmd := lsCmd("notifications", "List notification channels", []string{"notification", "channels"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := channels.list(cmd.Context(), a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No notification channels. Add one with `serve notifications add`.")
			return nil
		}
		var rows [][]string
		for _, ch := range l.Items {
			state := ui.StatusColor("on")
			if !ch.Enabled {
				state = ui.OutDim("off")
			}
			last := ui.OutDim("never")
			if ch.LastDeliveryAt != nil {
				last = ui.Ago(*ch.LastDeliveryAt) + " " + txt(deref(ch.LastDeliveryStatus))
				if ch.LastDeliveryError != nil && *ch.LastDeliveryError != "" {
					last += ": " + txt(*ch.LastDeliveryError)
				}
			}
			rows = append(rows, []string{txt(ch.Name), ch.Kind, state, strconv.Itoa(len(ch.Events)), last, ch.ID})
		}
		ui.Table([]string{"NAME", "TYPE", "STATE", "EVENTS", "LAST SENT", "ID"}, rows)
		return nil
	})
	cmd.Short = "Notification channels: list, add, test, on, off, delete"
	cmd.Long = `List the channels Serve sends notifications to (Slack, Discord, Telegram, email,
webhooks and more). Their webhook addresses and tokens are never shown.`
	cmd.Example = "  serve notifications\n  serve notifications add ops --type slack --secret-stdin < webhook.txt\n  serve notifications test ops\n  serve notifications off ops"

	var kind, events string
	var sets, files []string
	var stdin bool
	add := &cobra.Command{
		Use:   "add <name>",
		Short: "Add a notification channel",
		Long: `Add a notification channel. --type is slack, discord, teams, googlechat, mattermost,
rocketchat, telegram, matrix, ntfy, gotify, pushover, pushbullet, pagerduty, opsgenie, email,
twilio or webhook. Its settings are --set KEY=value; secrets are better read with
--set-file KEY=path (- for stdin), or --secret-stdin for the type's main secret (the webhook
URL, bot token or API key). The fields are the ones of the dashboard form, for example:

  slack, discord, teams, googlechat   webhookUrl
  telegram                            botToken, chatId, threadId
  ntfy                                topic, server, token
  email                               to
  webhook                             url, method, headers, secret

--events picks the events (comma-separated, or all); by default the channel gets the
warnings and failures, like in the dashboard.`,
		Example: "  serve notifications add ops --type slack --secret-stdin < webhook.txt\n  serve notifications add pager --type telegram --set chatId=-1001234567890 --set-file botToken=token.txt --events all\n  serve notifications add team --type email --set to=ops@example.com --events deploy.failed,backup.failed",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if kind == "" {
				return usagef("pass the channel --type, like slack, telegram or webhook")
			}
			list, err := eventList(events)
			if err != nil {
				return err
			}
			if stdin && slices.ContainsFunc(files, func(f string) bool { return strings.HasSuffix(f, "=-") }) {
				return usagef("only one value can come from stdin")
			}
			config, err := keyValues(sets, files)
			if err != nil {
				return err
			}
			if stdin {
				field, ok := mainSecret[kind]
				if !ok {
					return usagef("a %s channel has no main secret: pass --set-file KEY=- instead", kind)
				}
				if config[field], err = (secretSource{stdin: true}).read(field, "set"); err != nil {
					return err
				}
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "kind": kind, "config": config, "events": list, "scope": nil, "quietHours": nil, "throttleMinutes": 0, "template": nil}
			if err := c.Post(cmd.Context(), "/notification-channels", body, nil); err != nil {
				return err
			}
			ui.Success("Added the %s channel %s (%d event(s)).", kind, ui.Bold(args[0]), len(list))
			ui.Line(ui.Dim("Send a test with: serve notifications test " + args[0]))
			return nil
		},
	}
	add.Flags().StringVarP(&kind, "type", "t", "", "the channel type, like slack, telegram, email or webhook")
	add.Flags().StringArrayVar(&sets, "set", nil, "a setting, KEY=value (repeatable)")
	add.Flags().StringArrayVar(&files, "set-file", nil, "a setting read from a file, KEY=path (- for stdin; repeatable)")
	add.Flags().BoolVar(&stdin, "secret-stdin", false, "read the type's main secret (webhook URL, token or key) from stdin")
	add.Flags().StringVar(&events, "events", "", "comma-separated events, or all (default: warnings and failures)")

	toggle := func(on bool) *cobra.Command {
		use, word := "off", "Turn off"
		if on {
			use, word = "on", "Turn on"
		}
		return &cobra.Command{
			Use:     use + " <name>",
			Short:   word + " a notification channel",
			Long:    word + " a notification channel. Its settings stay.",
			Example: "  serve notifications " + use + " ops",
			Args:    exactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				ctx := cmd.Context()
				ch, err := channels.find(ctx, a, args[0])
				if err != nil {
					return err
				}
				if err := a.client.Patch(ctx, "/notification-channels/"+api.P(ch.ID), map[string]any{"enabled": on}, nil); err != nil {
					return err
				}
				ui.Success("%s is %s.", ui.Bold(txt(ch.Name)), use)
				return nil
			},
		}
	}
	cmd.AddCommand(add,
		channels.testCmd(a, "Send a test notification to a channel", "Sent a test notification to %s."),
		toggle(true), toggle(false),
		channels.rmCmd(a, "Delete a notification channel", "Delete a notification channel."))
	return cmd
}

/* ----------------------------- Secret managers ----------------------------- */

var secretManagers = integration[api.SecretProvider]{
	path: "/secret-providers", key: "providers", what: "secret manager", listCmd: "serve secret-managers ls",
	id: func(p api.SecretProvider) string { return p.ID }, name: func(p api.SecretProvider) string { return p.Name },
}

var secretManagerKinds = []string{"vault", "infisical", "doppler", "aws-secrets", "aws-parameters"}

// credentialKeys go to the encrypted credentials; other keys are plain settings.
var credentialKeys = []string{"token", "clientId", "clientSecret", "accessKeyId", "secretAccessKey", "sessionToken"}

var managerSecret = map[string]string{"vault": "token", "infisical": "clientSecret", "doppler": "token", "aws-secrets": "secretAccessKey", "aws-parameters": "secretAccessKey"}

func (a *App) secretManagersCmd() *cobra.Command {
	cmd := lsCmd("secret-managers", "List connected secret managers", []string{"secret-manager", "secret-providers"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		l, err := secretManagers.list(ctx, a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No secret managers. Connect one with `serve secret-managers add`.")
			return nil
		}
		names := a.projectNames(ctx)
		var rows [][]string
		for _, p := range l.Items {
			where := ""
			for _, k := range []string{"url", "region"} {
				if s, ok := p.Config[k].(string); ok && s != "" {
					where = s
				}
			}
			access := ui.OutDim("every project")
			if p.Access != nil && len(p.Access.ProjectIDs) > 0 {
				access = txt(namesOf(p.Access.ProjectIDs, names))
			}
			rows = append(rows, []string{txt(p.Name), p.Kind, txt(where), access, p.ID})
		}
		ui.Table([]string{"NAME", "TYPE", "WHERE", "USED BY", "ID"}, rows)
		return nil
	})
	cmd.Short = "Secret managers: list, connect, delete"
	cmd.Long = `List the secret managers variables can read from, as ${{secrets.<name>.<path>}}.
Their tokens and keys are never shown.`
	cmd.Example = "  serve secret-managers\n  serve secret-managers add prod-vault --type vault --set url=https://vault.example.com --secret-stdin < token.txt"

	var kind, projects string
	var sets, files []string
	var stdin bool
	add := &cobra.Command{
		Use:   "add <name>",
		Short: "Connect a secret manager",
		Long: `Connect a secret manager. The name (lowercase letters, digits and dashes) is the one
variables use: ${{secrets.<name>.<path>}}. --type is vault, infisical, doppler, aws-secrets
or aws-parameters. Settings are --set KEY=value; secrets are better read with
--set-file KEY=path (- for stdin), or --secret-stdin for the main secret:

  vault                           url, token, mount, namespace
  infisical                       url, clientId, clientSecret, projectId, environment
  doppler                         token, project, config
  aws-secrets, aws-parameters     region, accessKeyId, secretAccessKey, sessionToken

--projects limits it to some projects (names or ids); by default every project may use it.`,
		Example: "  serve secret-managers add prod-vault --type vault --set url=https://vault.example.com --secret-stdin < token.txt\n  serve secret-managers add aws --type aws-secrets --set region=us-east-1 --set accessKeyId=AKIA... --set-file secretAccessKey=key.txt --projects shop",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if !slices.Contains(secretManagerKinds, kind) {
				return usagef("pass --type: %s", strings.Join(secretManagerKinds, ", "))
			}
			if stdin && slices.ContainsFunc(files, func(f string) bool { return strings.HasSuffix(f, "=-") }) {
				return usagef("only one value can come from stdin")
			}
			values, err := keyValues(sets, files)
			if err != nil {
				return err
			}
			if stdin {
				field := managerSecret[kind]
				if values[field], err = (secretSource{stdin: true}).read(field, "set"); err != nil {
					return err
				}
			}
			config, creds := map[string]any{}, map[string]string{}
			for k, v := range values {
				switch {
				case slices.Contains(credentialKeys, k):
					creds[k] = v
				case k == "kvVersion":
					n, err := strconv.Atoi(v)
					if err != nil || (n != 1 && n != 2) {
						return usagef("kvVersion is 1 or 2")
					}
					config[k] = n
				default:
					config[k] = v
				}
			}
			ids := []string{}
			if projects != "" {
				if ids, err = a.projectIDs(ctx, splitList(projects)); err != nil {
					return err
				}
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "kind": kind, "config": config, "credentials": creds, "access": map[string]any{"projectIds": ids, "environmentIds": []string{}}}
			if err := c.Post(ctx, "/secret-providers", body, nil); err != nil {
				return err
			}
			ui.Success("Connected the secret manager %s.", ui.Bold(strings.ToLower(args[0])))
			ui.Line(ui.Dim("Use it in a variable as ${{secrets." + strings.ToLower(args[0]) + ".<path>}}"))
			return nil
		},
	}
	add.Flags().StringVarP(&kind, "type", "t", "", "vault, infisical, doppler, aws-secrets or aws-parameters")
	add.Flags().StringArrayVar(&sets, "set", nil, "a setting, KEY=value (repeatable)")
	add.Flags().StringArrayVar(&files, "set-file", nil, "a setting read from a file, KEY=path (- for stdin; repeatable)")
	add.Flags().BoolVar(&stdin, "secret-stdin", false, "read the main secret (token, client secret or secret access key) from stdin")
	add.Flags().StringVar(&projects, "projects", "", "only these projects may use it (comma-separated names or ids)")
	cmd.AddCommand(add, secretManagers.rmCmd(a, "Delete a secret manager", "Delete a secret manager. Variables that read from it fail on the next deploy."))
	return cmd
}

/* ----------------------------------- Git ----------------------------------- */

var gitConnections = integration[api.GitCredential]{
	path: "/git/credentials", key: "credentials", what: "Git connection", listCmd: "serve git ls",
	id: func(g api.GitCredential) string { return g.ID }, name: func(g api.GitCredential) string { return g.Name },
}

func (a *App) gitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "git",
		Short: "Git connections, their repositories and branches",
		Long:  "See the Git connections (tokens, apps and deploy keys), the repositories they reach and a repository's branches. Connections are added in the dashboard.",
	}
	ls := lsCmd("ls", "List Git connections", []string{"list"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := gitConnections.list(cmd.Context(), a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No Git connections. Connect one in the dashboard under Integrations.")
			return nil
		}
		var rows [][]string
		for _, g := range l.Items {
			rows = append(rows, []string{txt(g.Name), g.Provider, txt(deref(g.Info)), txt(deref(g.BaseURL)), g.ID})
		}
		ui.Table([]string{"NAME", "PROVIDER", "ACCOUNT", "SERVER", "ID"}, rows)
		return nil
	})
	ls.Example = "  serve git ls\n  serve git ls --json"
	// lsCmd adds its own "ls" child: not needed under a command already called ls.
	for _, c := range ls.Commands() {
		ls.RemoveCommand(c)
	}

	var asJSON bool
	repos := &cobra.Command{
		Use:     "repos <connection>",
		Aliases: []string{"repositories"},
		Short:   "List the repositories a Git connection reaches",
		Long:    "List the repositories a Git connection (name or id from serve git ls) reaches. Deploy keys reach one repository and cannot list any.",
		Example: "  serve git repos \"GitHub · ada\"\n  serve git repos 436gr2afpwi8fics --json",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			g, err := gitConnections.find(ctx, a, args[0])
			if err != nil {
				return err
			}
			l, err := api.List[api.GitRepo](ctx, a.client, "/git/credentials/"+api.P(g.ID)+"/repositories", "repositories", nil)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(l.Raw)
			}
			if len(l.Items) == 0 {
				if g.Provider == "ssh" {
					ui.Info("%s is a deploy key: it cannot list repositories.", txt(g.Name))
				} else {
					ui.Info("%s reaches no repositories.", txt(g.Name))
				}
				return nil
			}
			var rows [][]string
			for _, r := range l.Items {
				vis := "public"
				if r.Private {
					vis = "private"
				}
				updated := ""
				if r.UpdatedAt != nil {
					updated = ui.Ago(*r.UpdatedAt)
				}
				rows = append(rows, []string{txt(r.FullName), txt(r.DefaultBranch), vis, updated, txt(r.CloneURL)})
			}
			ui.Table([]string{"REPOSITORY", "BRANCH", "VISIBILITY", "UPDATED", "URL"}, rows)
			return nil
		},
	}
	repos.Flags().BoolVar(&asJSON, "json", false, "print JSON")

	var conn string
	branches := &cobra.Command{
		Use:   "branches <repository>",
		Short: "List the branches of a repository",
		Long: `List the branches of a repository, by its URL (https or ssh). A private repository needs
--connection, the Git connection that reaches it.`,
		Example: "  serve git branches https://github.com/ada/shop\n  serve git branches git@github.com:ada/private.git --connection \"GitHub · ada\"",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			q := url.Values{"repository": {args[0]}}
			if conn != "" {
				g, err := gitConnections.find(ctx, a, conn)
				if err != nil {
					return err
				}
				q.Set("credentialId", g.ID)
			}
			var r struct{ Branches []string }
			if err := c.Get(ctx, "/git/branches", q, &r); err != nil {
				return err
			}
			if asJSON {
				if r.Branches == nil {
					r.Branches = []string{}
				}
				return printJSON(r.Branches)
			}
			if len(r.Branches) == 0 {
				ui.Info("The repository has no branches.")
				return nil
			}
			for _, b := range r.Branches {
				fmt.Fprintln(ui.Out, txt(b))
			}
			return nil
		},
	}
	branches.Flags().StringVar(&conn, "connection", "", "the Git connection (`name` or id) for a private repository")
	branches.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.AddCommand(ls, repos, branches)
	return cmd
}

/* -------------------------------- Cloudflare ------------------------------- */

var cfAccounts = integration[api.CloudflareAccount]{
	path: "/cloudflare/accounts", key: "accounts", what: "Cloudflare account", listCmd: "serve cloudflare ls",
	id: func(c api.CloudflareAccount) string { return c.ID }, name: func(c api.CloudflareAccount) string { return c.Name },
}

// cfAccount is the account --account names, or the only one.
func (a *App) cfAccount(ctx context.Context, ref string) (*api.CloudflareAccount, error) {
	if ref != "" {
		return cfAccounts.find(ctx, a, ref)
	}
	l, err := cfAccounts.list(ctx, a)
	if err != nil {
		return nil, err
	}
	switch len(l.Items) {
	case 0:
		return nil, fmt.Errorf("no Cloudflare account is connected. Connect one in the dashboard under Integrations")
	case 1:
		return &l.Items[0], nil
	}
	return nil, usagef("%d Cloudflare accounts are connected: name one with --account (see serve cloudflare ls)", len(l.Items))
}

func (a *App) cfZones(ctx context.Context, acc *api.CloudflareAccount) (*api.Listed[api.CloudflareZone], error) {
	return api.List[api.CloudflareZone](ctx, a.client, "/cloudflare/accounts/"+api.P(acc.ID)+"/zones", "zones", nil)
}

// cfZone finds a zone (domain name or id) in --account, or in every connected account.
func (a *App) cfZone(ctx context.Context, account, ref string) (*api.CloudflareAccount, *api.CloudflareZone, error) {
	var accounts []api.CloudflareAccount
	if account != "" {
		acc, err := cfAccounts.find(ctx, a, account)
		if err != nil {
			return nil, nil, err
		}
		accounts = []api.CloudflareAccount{*acc}
	} else {
		l, err := cfAccounts.list(ctx, a)
		if err != nil {
			return nil, nil, err
		}
		if len(l.Items) == 0 {
			return nil, nil, fmt.Errorf("no Cloudflare account is connected. Connect one in the dashboard under Integrations")
		}
		accounts = l.Items
	}
	ref = strings.TrimSuffix(strings.ToLower(hostOnly(ref)), ".")
	type hit struct {
		acc  api.CloudflareAccount
		zone api.CloudflareZone
	}
	var hits []hit
	for _, acc := range accounts {
		zones, err := a.cfZones(ctx, &acc)
		if err != nil {
			if len(accounts) == 1 {
				return nil, nil, err
			}
			ui.Warn("Could not list the zones of %s: %v", txt(acc.Name), err)
			continue
		}
		for _, z := range zones.Items {
			if z.ID == ref || strings.EqualFold(z.Name, ref) {
				hits = append(hits, hit{acc, z})
			}
		}
	}
	switch len(hits) {
	case 0:
		return nil, nil, fmt.Errorf("no connected Cloudflare account has the zone %q. See `serve cloudflare zones`", ref)
	case 1:
		return &hits[0].acc, &hits[0].zone, nil
	}
	return nil, nil, usagef("%d accounts have the zone %q: name one with --account", len(hits), ref)
}

var dnsTypes = []string{"A", "AAAA", "CNAME", "TXT", "MX", "NS", "CAA", "SRV"}

func (a *App) cloudflareCmd() *cobra.Command {
	cmd := lsCmd("cloudflare", "List connected Cloudflare accounts", []string{"cf"}, func(cmd *cobra.Command, asJSON bool) error {
		l, err := cfAccounts.list(cmd.Context(), a)
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(l.Raw)
		}
		if len(l.Items) == 0 {
			ui.Info("No Cloudflare account is connected. Connect one in the dashboard under Integrations.")
			return nil
		}
		var rows [][]string
		for _, c := range l.Items {
			rows = append(rows, []string{txt(c.Name), txt(deref(c.Email)), c.ID})
		}
		ui.Table([]string{"NAME", "EMAIL", "ID"}, rows)
		return nil
	})
	cmd.Short = "Cloudflare accounts, zones, DNS records and cache"
	cmd.Long = `See the connected Cloudflare accounts and their zones, set and delete DNS records, and
purge a zone's cache. Accounts are connected in the dashboard.`
	cmd.Example = "  serve cloudflare ls\n  serve cloudflare zones\n  serve cloudflare dns set example.com A www 203.0.113.10 --proxied\n  serve cloudflare purge example.com"

	var asJSON bool
	zones := &cobra.Command{
		Use:     "zones [account]",
		Short:   "List the zones (domains) of a Cloudflare account",
		Long:    "List the zones (domains) of a Cloudflare account: the one named, or the only one connected.",
		Example: "  serve cloudflare zones\n  serve cloudflare zones \"Ada's Account\" --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			ref := ""
			if len(args) == 1 {
				ref = args[0]
			}
			acc, err := a.cfAccount(ctx, ref)
			if err != nil {
				return err
			}
			l, err := a.cfZones(ctx, acc)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(l.Raw)
			}
			if len(l.Items) == 0 {
				ui.Info("%s has no zones.", txt(acc.Name))
				return nil
			}
			var rows [][]string
			for _, z := range l.Items {
				status := z.Status
				if z.Paused {
					status += " (paused)"
				}
				plan := ""
				if z.Plan != nil {
					plan = z.Plan.Name
				}
				rows = append(rows, []string{txt(z.Name), ui.StatusColor(status), txt(plan), z.ID})
			}
			ui.Table([]string{"ZONE", "STATUS", "PLAN", "ID"}, rows)
			return nil
		},
	}
	zones.Flags().BoolVar(&asJSON, "json", false, "print JSON")

	var account string
	dns := &cobra.Command{
		Use:   "dns",
		Short: "Set and delete DNS records in a Cloudflare zone",
		Long:  "Set and delete DNS records in a Cloudflare zone. The zone is its domain name or id; --account picks the account when several have it.",
	}
	var proxied bool
	var ttl, priority int
	var comment, recordID string
	set := &cobra.Command{
		Use:   "set <zone> <type> <name> <content>",
		Short: "Create a DNS record, or change one with --id",
		Long: `Create a DNS record in a zone, or change the record --id names. type is A, AAAA, CNAME,
TXT, MX, NS, CAA or SRV; name is the record's name (www, or www.example.com; @ is the zone
itself). --proxied sends A, AAAA and CNAME traffic through Cloudflare. The record's id is
printed: delete it with serve cloudflare dns rm <zone> <id>.`,
		Example: "  serve cloudflare dns set example.com A www 203.0.113.10 --proxied\n  serve cloudflare dns set example.com TXT _verify \"token=abc\"\n  serve cloudflare dns set example.com A www 203.0.113.11 --id 372e67954025e0ba6aaa6d586b9e0b59",
		Args:    exactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			typ := strings.ToUpper(args[1])
			if !slices.Contains(dnsTypes, typ) {
				return usagef("the type must be one of %s", strings.Join(dnsTypes, ", "))
			}
			if proxied && typ != "A" && typ != "AAAA" && typ != "CNAME" {
				return usagef("only A, AAAA and CNAME records can be proxied")
			}
			acc, zone, err := a.cfZone(ctx, account, args[0])
			if err != nil {
				return err
			}
			name := args[2]
			if name == "@" {
				name = zone.Name
			}
			body := map[string]any{"type": typ, "name": name, "content": args[3], "proxied": proxied, "recordId": nil}
			if recordID != "" {
				body["recordId"] = recordID
			}
			if cmd.Flags().Changed("ttl") {
				if ttl < 1 {
					return usagef("--ttl is in seconds (1 means automatic)")
				}
				body["ttl"] = ttl
			}
			if cmd.Flags().Changed("priority") {
				body["priority"] = priority
			}
			if comment != "" {
				body["comment"] = comment
			}
			var rec api.DNSRecord
			path := "/cloudflare/accounts/" + api.P(acc.ID) + "/zones/" + api.P(zone.ID) + "/dns"
			if err := a.client.Do(ctx, api.Request{Method: "PUT", Path: path, JSON: body}, &rec); err != nil {
				return err
			}
			if asJSON {
				return printJSON(rec)
			}
			verb := "Created"
			if recordID != "" {
				verb = "Changed"
			}
			ui.Success("%s %s %s → %s in %s.", verb, typ, ui.Bold(txt(orName(rec.Name, name))), txt(orName(rec.Content, args[3])), txt(zone.Name))
			if rec.ID != "" {
				ui.Line(ui.Dim("Record id: " + rec.ID))
			}
			return nil
		},
	}
	set.Flags().BoolVar(&proxied, "proxied", false, "send the traffic through Cloudflare (A, AAAA, CNAME)")
	set.Flags().IntVar(&ttl, "ttl", 1, "time to live in seconds (1 means automatic)")
	set.Flags().IntVar(&priority, "priority", 10, "the priority of an MX record")
	set.Flags().StringVar(&comment, "comment", "", "a note on the record")
	set.Flags().StringVar(&recordID, "id", "", "change this record instead of creating one")
	set.Flags().BoolVar(&asJSON, "json", false, "print the saved record as JSON")

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <zone> <record-id>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a DNS record",
		Long:    "Delete a DNS record by its id (printed by serve cloudflare dns set, or shown in Cloudflare). Asks for the id again unless you pass --yes.",
		Example: "  serve cloudflare dns rm example.com 372e67954025e0ba6aaa6d586b9e0b59 --yes",
		Args:    exactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			acc, zone, err := a.cfZone(ctx, account, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("a DNS record", args[1], yes); err != nil {
				return err
			}
			path := "/cloudflare/accounts/" + api.P(acc.ID) + "/zones/" + api.P(zone.ID) + "/dns/" + api.P(args[1])
			if err := a.client.Delete(ctx, path, nil, nil); err != nil {
				return err
			}
			ui.Success("Deleted the record %s from %s.", args[1], ui.Bold(txt(zone.Name)))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the id")
	dns.PersistentFlags().StringVar(&account, "account", "", "the Cloudflare account (`name` or id) when several have the zone")
	dns.AddCommand(set, rm)

	purge := &cobra.Command{
		Use:     "purge <zone>",
		Short:   "Purge a zone's cache",
		Long:    "Purge everything Cloudflare has cached for a zone. Visitors get fresh files from the server; it may be busier for a while.",
		Example: "  serve cloudflare purge example.com",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			acc, zone, err := a.cfZone(ctx, account, args[0])
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/cloudflare/accounts/"+api.P(acc.ID)+"/zones/"+api.P(zone.ID)+"/purge-cache", nil, nil); err != nil {
				return err
			}
			ui.Success("Purged the cache of %s.", ui.Bold(txt(zone.Name)))
			return nil
		},
	}
	purge.Flags().StringVar(&account, "account", "", "the Cloudflare account (`name` or id) when several have the zone")
	cmd.AddCommand(zones, dns, purge)
	return cmd
}
