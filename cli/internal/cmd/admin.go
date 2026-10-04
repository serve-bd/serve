package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// What the admin areas need, said when the API answers 403.
const (
	needServerAdmin = "an admin of the organization that owns the server (a Root admin for the instance's own servers)"
	needCerts       = "the Manage integrations permission (integrations.manage)"
	needInstance    = "an admin of the Root organization (the admin of this Serve instance); for a token, its owner needs that role"
)

// adminPoll is the wait between two looks at a running server action (tests shorten it).
var adminPoll = 2 * time.Second

// needs makes a 403 answer say which role or permission the action takes. The API's own
// message already names it for a token's missing permission; an action's refusal may not.
func needs(err error, need string) error {
	var ae *api.Error
	if !errors.As(err, &ae) || ae.Status != http.StatusForbidden {
		return err
	}
	msg := strings.TrimSpace(ae.Message)
	if msg == "" {
		msg = "You are not allowed to do this"
	}
	if strings.Contains(msg, "It needs") {
		return errors.New(msg)
	}
	return fmt.Errorf("%s. This needs %s", strings.TrimRight(msg, "."), need)
}

// jsonFlag reads --json, which list commands give their subcommands too.
func jsonFlag(cmd *cobra.Command) bool {
	v, _ := cmd.Flags().GetBool("json")
	return v
}

// sleepCtx waits, or stops early when the command is cancelled (Ctrl+C).
func sleepCtx(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// confirmAction asks a yes or no question. --yes skips it; without a terminal --yes is required.
func confirmAction(question string, yes bool) error {
	if yes {
		return nil
	}
	ok, err := ui.Confirm(question, false)
	if errors.Is(err, ui.ErrNotInteractive) {
		return usagef("this needs --yes when there is no terminal to ask")
	}
	if err != nil {
		return err
	}
	if !ok {
		return ui.ErrAborted
	}
	return nil
}

// until says how far off a time is: "in 40d", "3d ago".
func until(ts *string) string {
	if ts == nil || *ts == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, *ts)
	if err != nil {
		return *ts
	}
	d := time.Until(t)
	if d < 0 {
		return ui.Ago(*ts)
	}
	switch {
	case d < time.Hour:
		return fmt.Sprintf("in %dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("in %dh", int(d.Hours()))
	case d > 365*24*time.Hour:
		return t.Local().Format("2006-01-02")
	}
	return fmt.Sprintf("in %dd", int(d.Hours()/24))
}

// readSecretFile reads a key or certificate file; "~/" means the home folder.
func readSecretFile(path string) ([]byte, error) {
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, rest)
		}
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, errors.Unwrap(err))
	}
	if st.IsDir() {
		return nil, fmt.Errorf("%s is a folder, not a file", path)
	}
	if st.Size() > 1<<20 {
		return nil, fmt.Errorf("%s is larger than 1 MB: is it the right file?", path)
	}
	return os.ReadFile(path)
}

/* SSH keys */

func (a *App) findSSHKey(ctx context.Context, ref string) (*api.SSHKey, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var keys []api.SSHKey
	if _, err := c.GetRaw(ctx, "/ssh-keys", "keys", &keys); err != nil {
		return nil, needs(err, needServerAdmin)
	}
	var found []api.SSHKey
	for _, k := range keys {
		if k.ID == ref {
			return &k, nil
		}
		if strings.EqualFold(k.Name, ref) {
			found = append(found, k)
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("no SSH key named %q. See `serve ssh-keys`", ref)
	case 1:
		return &found[0], nil
	}
	ids := make([]string, len(found))
	for i, k := range found {
		ids[i] = k.ID
	}
	return nil, fmt.Errorf("%d SSH keys are named %q: use the id (%s)", len(found), ref, strings.Join(ids, ", "))
}

func (a *App) sshKeysCmd() *cobra.Command {
	cmd := lsCmd("ssh-keys", "List, add and remove the SSH keys Serve connects to servers with", []string{"ssh-key"}, func(cmd *cobra.Command, asJSON bool) error {
		c, err := a.Client()
		if err != nil {
			return err
		}
		var keys []api.SSHKey
		raw, err := c.GetRaw(cmd.Context(), "/ssh-keys", "keys", &keys)
		if err != nil {
			return needs(err, needServerAdmin)
		}
		if asJSON {
			return printJSON(raw)
		}
		if len(keys) == 0 {
			ui.Info("No SSH keys yet. Add one with `serve ssh-keys add <name>`.")
			return nil
		}
		var rows [][]string
		for _, k := range keys {
			rows = append(rows, []string{k.Name, k.Fingerprint, ui.Ago(k.CreatedAt), k.ID})
		}
		ui.Table([]string{"NAME", "FINGERPRINT", "CREATED", "ID"}, rows)
		return nil
	})
	cmd.Long = `List the SSH keys Serve uses to connect to your servers. Only public keys are shown.
Adding and removing keys needs an organization admin.`
	cmd.Example = "  serve ssh-keys\n  serve ssh-keys add deploy\n  serve ssh-keys add laptop --file ~/.ssh/id_ed25519\n  serve ssh-keys rm deploy"

	var file, description string
	add := &cobra.Command{
		Use:         "add <name>",
		Annotations: printsJSON,
		Short:       "Add an SSH key (a new one, or your own with --file)",
		Long: `Add an SSH key. Without --file, Serve makes a new ed25519 key pair and keeps the
private key. With --file, it stores the private key you give (OpenSSH or PEM format).

The public key is printed: put it in ~/.ssh/authorized_keys on the server, then add the
server with ` + "`serve servers add --key <name>`" + `.`,
		Example: "  serve ssh-keys add deploy\n  serve ssh-keys add deploy >> deploy.pub\n  serve ssh-keys add laptop --file ~/.ssh/id_ed25519",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0]}
			if description != "" {
				body["description"] = description
			}
			if file != "" {
				b, err := readSecretFile(file)
				if err != nil {
					return err
				}
				s := strings.TrimSpace(string(b))
				if strings.HasPrefix(s, "ssh-") || strings.HasPrefix(s, "ecdsa-") || strings.HasSuffix(file, ".pub") {
					return usagef("%s is a public key. Pass the private key file (the one without .pub)", file)
				}
				if !strings.Contains(s, "PRIVATE KEY") {
					return usagef("%s does not look like a private key (OpenSSH or PEM)", file)
				}
				body["privateKey"] = s + "\n"
			}
			var r struct {
				ID          string `json:"id"`
				PublicKey   string `json:"publicKey"`
				Fingerprint string `json:"fingerprint"`
			}
			if err := c.Post(cmd.Context(), "/ssh-keys", body, &r); err != nil {
				return needs(err, needServerAdmin)
			}
			if jsonFlag(cmd) {
				return printJSON(r)
			}
			ui.Success("Added the SSH key %s (%s).", ui.Bold(args[0]), r.Fingerprint)
			ui.Info("Put this public key in ~/.ssh/authorized_keys on the server:")
			fmt.Fprintln(ui.Out, r.PublicKey)
			return nil
		},
	}
	add.Flags().StringVarP(&file, "file", "f", "", "a private key `file` to store instead of making a new key")
	add.Flags().StringVar(&description, "description", "", "a note about the key")

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <name>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete an SSH key",
		Long:    "Delete an SSH key. A key that servers still use cannot be deleted: give them another key first. Asks for the key's name unless --yes.",
		Example: "  serve ssh-keys rm deploy\n  serve ssh-keys rm deploy --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			k, err := a.findSSHKey(ctx, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("an SSH key", k.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/ssh-keys/"+api.P(k.ID), nil, nil); err != nil {
				return needs(err, needServerAdmin)
			}
			ui.Success("Deleted the SSH key %s.", ui.Bold(k.Name))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.AddCommand(add, rm)
	return cmd
}
