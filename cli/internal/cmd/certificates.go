package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

var certProviders = []string{"letsencrypt-http", "letsencrypt-cloudflare", "cloudflare-origin"}

func (a *App) certificates(ctx context.Context) ([]api.Certificate, json.RawMessage, error) {
	c, err := a.Client()
	if err != nil {
		return nil, nil, err
	}
	var list []api.Certificate
	raw, err := c.GetRaw(ctx, "/certificates", "certificates", &list)
	return list, raw, needs(err, "the View projects permission (projects.view)")
}

// findCertificate takes an id, a name, or a domain that one certificate covers.
func (a *App) findCertificate(ctx context.Context, ref string) (*api.Certificate, error) {
	list, _, err := a.certificates(ctx)
	if err != nil {
		return nil, err
	}
	var byName, byDomain []api.Certificate
	for _, cert := range list {
		if cert.ID == ref {
			return &cert, nil
		}
		if strings.EqualFold(cert.Name, ref) {
			byName = append(byName, cert)
		}
		for _, d := range cert.Domains {
			if strings.EqualFold(d, ref) {
				byDomain = append(byDomain, cert)
				break
			}
		}
	}
	found := byName
	if len(found) == 0 {
		found = byDomain
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("no certificate named %q. See `serve certificates`", ref)
	case 1:
		return &found[0], nil
	}
	ids := make([]string, len(found))
	for i, c := range found {
		ids[i] = c.ID + " (" + c.Name + ")"
	}
	return nil, fmt.Errorf("%d certificates match %q: use the id (%s)", len(found), ref, strings.Join(ids, ", "))
}

// waitCertificate follows an issue or renewal until it ends.
func (a *App) waitCertificate(ctx context.Context, id string) error {
	sp := ui.StartSpinner("Issuing the certificate...")
	defer sp.Stop()
	for {
		if err := sleepCtx(ctx, adminPoll); err != nil {
			return err
		}
		list, _, err := a.certificates(ctx)
		if err != nil {
			return err
		}
		var cert *api.Certificate
		for i := range list {
			if list[i].ID == id {
				cert = &list[i]
			}
		}
		if cert == nil {
			return errors.New("the certificate was deleted while it was being issued")
		}
		switch cert.Status {
		case "pending", "issuing":
			continue
		case "active":
			sp.Stop()
			ui.Success("%s is active (expires %s).", ui.Bold(cert.Name), until(cert.ExpiresAt))
			return nil
		}
		sp.Stop()
		msg := deref(cert.LastError)
		if msg == "" {
			msg = "the certificate is " + cert.Status
		}
		return fmt.Errorf("%s: %s. See `serve certificates logs %s`", cert.Name, strings.TrimRight(msg, "."), cert.ID)
	}
}

// cloudflareAccount picks the account a DNS certificate is made with.
func (a *App) cloudflareAccount(ctx context.Context, ref string) (string, error) {
	var accounts []api.CloudflareAccount
	if _, err := a.client.GetRaw(ctx, "/cloudflare/accounts", "accounts", &accounts); err != nil {
		return "", err
	}
	if len(accounts) == 0 {
		return "", errors.New("no Cloudflare account is connected. Connect one in the dashboard (Integrations) first")
	}
	if ref != "" {
		for _, acc := range accounts {
			if acc.ID == ref || strings.EqualFold(acc.Name, ref) {
				return acc.ID, nil
			}
		}
		return "", fmt.Errorf("no Cloudflare account named %q", ref)
	}
	if len(accounts) == 1 {
		return accounts[0].ID, nil
	}
	opts := make([]ui.Option, len(accounts))
	for i, acc := range accounts {
		opts[i] = ui.Option{Label: acc.Name, Value: acc.ID}
	}
	id, err := ui.Select("Which Cloudflare account?", opts)
	return id, needChoice(err, "several Cloudflare accounts are connected: pass --cloudflare-account <name>")
}

func (a *App) certificatesCmd() *cobra.Command {
	cmd := lsCmd("certificates", "List, request, upload and renew TLS certificates", []string{"certificate", "certs", "cert"}, func(cmd *cobra.Command, asJSON bool) error {
		list, raw, err := a.certificates(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(raw)
		}
		if len(list) == 0 {
			ui.Info("No certificates. Domains get theirs by themselves; request one for other names with `serve certificates request <domain>`.")
			return nil
		}
		var rows [][]string
		for _, c := range list {
			renew := "off"
			if c.AutoRenew {
				renew = "on"
			}
			rows = append(rows, []string{c.Name, strings.Join(c.Domains, ", "), ui.StatusColor(c.Status), until(c.ExpiresAt), renew, c.ID})
		}
		ui.Table([]string{"NAME", "DOMAINS", "STATUS", "EXPIRES", "AUTO-RENEW", "ID"}, rows)
		return nil
	})
	cmd.Long = `List the organization's TLS certificates: requested from Let's Encrypt or Cloudflare,
or uploaded. Requesting, uploading, renewing and deleting needs the Manage integrations
permission.`
	cmd.Example = "  serve certificates\n  serve certificates request example.com www.example.com\n  serve certificates request '*.example.com' --cloudflare-account main\n  serve certificates renew example.com"

	var provider, account, name, server string
	var wait bool
	request := &cobra.Command{
		Use:   "request <domain>...",
		Short: "Request a certificate for one or more domains",
		Long: `Request a certificate. --provider picks how it is made:

  letsencrypt-http         Let's Encrypt over HTTP (the default). The domains must point at the server.
  letsencrypt-cloudflare   Let's Encrypt over Cloudflare DNS. Needed for wildcards like *.example.com.
  cloudflare-origin        A Cloudflare origin certificate (trusted by Cloudflare only).

A wildcard picks letsencrypt-cloudflare by itself. The Cloudflare ones use the connected
account (--cloudflare-account when there are several). The certificate goes on this machine's
proxy unless --server names another. --wait follows the issue until it ends.`,
		Example: "  serve certificates request example.com www.example.com --wait\n  serve certificates request '*.example.com' --cloudflare-account main\n  serve certificates request app.example.com --server eu-1",
		Args:    minArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			p := provider
			if p == "" {
				p = "letsencrypt-http"
				for _, d := range args {
					if strings.HasPrefix(d, "*.") {
						p = "letsencrypt-cloudflare"
					}
				}
			}
			valid := false
			for _, k := range certProviders {
				valid = valid || k == p
			}
			if !valid {
				return usagef("--provider must be one of %s", strings.Join(certProviders, ", "))
			}
			domains := make([]string, len(args))
			for i, d := range args {
				domains[i] = strings.ToLower(hostOnly(d))
			}
			body := map[string]any{"provider": p, "domains": domains}
			if name != "" {
				body["name"] = name
			}
			if p != "letsencrypt-http" {
				id, err := a.cloudflareAccount(ctx, account)
				if err != nil {
					return err
				}
				body["cloudflareAccountId"] = id
			} else if account != "" {
				return usagef("--cloudflare-account is for the letsencrypt-cloudflare and cloudflare-origin providers")
			}
			if server != "" {
				s, err := a.findServer(ctx, server)
				if err != nil {
					return err
				}
				body["serverId"] = s.ID
			}
			var r struct{ ID string }
			if err := c.Post(ctx, "/certificates", body, &r); err != nil {
				return needs(err, needCerts)
			}
			if jsonFlag(cmd) && !wait {
				return printJSON(r)
			}
			ui.Info("Requested a certificate for %s.", strings.Join(domains, ", "))
			if !wait {
				ui.Info("Follow it with `serve certificates` or `serve certificates logs %s`.", r.ID)
				return nil
			}
			return a.waitCertificate(ctx, r.ID)
		},
	}
	request.Flags().StringVar(&provider, "provider", "", "letsencrypt-http, letsencrypt-cloudflare or cloudflare-origin")
	request.Flags().StringVar(&account, "cloudflare-account", "", "the Cloudflare account (`name` or id) for DNS and origin certificates")
	request.Flags().StringVar(&name, "name", "", "a name for the certificate (the first domain by default)")
	request.Flags().StringVar(&server, "server", "", "the server (`name` or id) whose proxy uses it (this machine by default)")
	request.Flags().BoolVarP(&wait, "wait", "w", false, "wait until it is issued")
	_ = request.RegisterFlagCompletionFunc("provider", cobra.FixedCompletions(certProviders, cobra.ShellCompDirectiveNoFileComp))

	var certFile, keyFile, upName, upServer string
	upload := &cobra.Command{
		Use:   "upload --cert <file> --key <file>",
		Short: "Upload your own certificate and private key",
		Long: `Upload a certificate you got elsewhere: the PEM certificate (with its chain) and its
private key. Its names and expiry are read from the file. Uploaded certificates do not renew
by themselves: upload a new one before it expires.`,
		Example: "  serve certificates upload --cert fullchain.pem --key privkey.pem\n  serve certificates upload --cert cert.pem --key key.pem --name shop --server eu-1",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if certFile == "" || keyFile == "" {
				return usagef("pass both --cert and --key")
			}
			cert, err := readSecretFile(certFile)
			if err != nil {
				return err
			}
			key, err := readSecretFile(keyFile)
			if err != nil {
				return err
			}
			if !strings.Contains(string(cert), "BEGIN CERTIFICATE") {
				return usagef("%s is not a PEM certificate", certFile)
			}
			if !strings.Contains(string(key), "PRIVATE KEY") {
				return usagef("%s is not a PEM private key", keyFile)
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": upName, "certificate": string(cert), "privateKey": string(key)}
			if upServer != "" {
				s, err := a.findServer(ctx, upServer)
				if err != nil {
					return err
				}
				body["serverId"] = s.ID
			}
			var r struct{ ID string }
			if err := c.Post(ctx, "/certificates/upload", body, &r); err != nil {
				return needs(err, needCerts)
			}
			if jsonFlag(cmd) {
				return printJSON(r)
			}
			ui.Success("Uploaded the certificate (%s).", r.ID)
			return nil
		},
	}
	upload.Flags().StringVar(&certFile, "cert", "", "the PEM certificate `file` (with its chain)")
	upload.Flags().StringVar(&keyFile, "key", "", "the PEM private key `file`")
	upload.Flags().StringVar(&upName, "name", "", "a name for the certificate (its first domain by default)")
	upload.Flags().StringVar(&upServer, "server", "", "the server (`name` or id) whose proxy uses it (this machine by default)")

	var renewWait bool
	renew := &cobra.Command{
		Use:     "renew <certificate>",
		Short:   "Renew a certificate now",
		Long:    "Renew a requested certificate now, by its id, name or one of its domains. Uploaded certificates are replaced by uploading a new one. --wait follows the renewal.",
		Example: "  serve certificates renew example.com\n  serve certificates renew example.com --wait",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			cert, err := a.findCertificate(ctx, args[0])
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/certificates/"+api.P(cert.ID)+"/renew", nil, nil); err != nil {
				return needs(err, needCerts)
			}
			ui.Info("Renewing %s.", ui.Bold(cert.Name))
			if !renewWait {
				ui.Info("Follow it with `serve certificates logs %s`.", cert.ID)
				return nil
			}
			return a.waitCertificate(ctx, cert.ID)
		},
	}
	renew.Flags().BoolVarP(&renewWait, "wait", "w", false, "wait until it is renewed")

	logs := &cobra.Command{
		Use:     "logs <certificate>",
		Short:   "Show the log of a certificate's last issue or renewal",
		Long:    "Show the log of the last issue or renewal of a certificate (by id, name or domain), with its error if it failed.",
		Example: "  serve certificates logs example.com",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			cert, err := a.findCertificate(ctx, args[0])
			if err != nil {
				return err
			}
			var r struct {
				Logs   string  `json:"logs"`
				Status string  `json:"status"`
				Error  *string `json:"error"`
			}
			raw, err := a.client.GetRaw(ctx, "/certificates/"+api.P(cert.ID)+"/logs", "logs", &r)
			if err != nil {
				return needs(err, needCerts)
			}
			if jsonFlag(cmd) {
				return printJSON(raw)
			}
			if strings.TrimSpace(r.Logs) == "" {
				ui.Info("%s has no log yet (%s).", cert.Name, r.Status)
			}
			color := ui.ColorOut()
			for _, line := range strings.Split(strings.TrimRight(r.Logs, "\n"), "\n") {
				if line != "" {
					fmt.Fprintln(ui.Out, ui.SanitizeLine(line, color))
				}
			}
			if e := deref(r.Error); e != "" && r.Status != "active" {
				ui.Error(e)
			}
			return nil
		},
	}

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <certificate>",
		Aliases: []string{"delete", "remove"},
		Short:   "Delete a certificate",
		Long:    "Delete a certificate (by id, name or domain). Domains that used it fall back to any other certificate that covers them. Asks for its name unless --yes.",
		Example: "  serve certificates rm example.com\n  serve certificates rm example.com --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			cert, err := a.findCertificate(ctx, args[0])
			if err != nil {
				return err
			}
			if err := confirmName("a certificate", cert.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/certificates/"+api.P(cert.ID), nil, nil); err != nil {
				return needs(err, needCerts)
			}
			ui.Success("Deleted the certificate %s.", ui.Bold(cert.Name))
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")

	autoRenew := &cobra.Command{
		Use:       "auto-renew on|off <certificate>",
		Short:     "Turn automatic renewal of a certificate on or off",
		Long:      "Turn automatic renewal on or off for a certificate (by id, name or domain). Serve renews certificates some weeks before they expire.",
		Example:   "  serve certificates auto-renew off example.com",
		Args:      exactArgs(2),
		ValidArgs: []string{"on", "off"},
		RunE: func(cmd *cobra.Command, args []string) error {
			on := args[0] == "on"
			if !on && args[0] != "off" {
				return usagef("say on or off, got %q", args[0])
			}
			ctx := cmd.Context()
			cert, err := a.findCertificate(ctx, args[1])
			if err != nil {
				return err
			}
			if cert.Provider == "custom" && on {
				return errors.New("an uploaded certificate cannot renew by itself: upload a new one before it expires")
			}
			if err := a.client.Patch(ctx, "/certificates/"+api.P(cert.ID), map[string]any{"autoRenew": on}, nil); err != nil {
				return needs(err, needCerts)
			}
			ui.Success("Automatic renewal of %s is %s.", ui.Bold(cert.Name), args[0])
			return nil
		},
	}
	cmd.AddCommand(request, upload, renew, logs, rm, autoRenew)
	return cmd
}
