package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Cloudflare Tunnels: a connector on a server, so its domains work without open ports.

func (a *App) tunnelsOf(ctx context.Context, accountID string) ([]api.Tunnel, error) {
	var r struct{ Tunnels []api.Tunnel }
	if err := a.client.Get(ctx, "/cloudflare/accounts/"+api.P(accountID)+"/tunnels", nil, &r); err != nil {
		return nil, needs(err, "the Manage integrations permission (integrations.manage)")
	}
	return r.Tunnels, nil
}

// cloudflareAccounts answers the connected accounts, or the one --account names.
func (a *App) cloudflareAccounts(ctx context.Context, ref string) ([]api.CloudflareAccount, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var r struct{ Accounts []api.CloudflareAccount }
	if err := c.Get(ctx, "/cloudflare/accounts", nil, &r); err != nil {
		return nil, err
	}
	if len(r.Accounts) == 0 {
		return nil, fmt.Errorf("no Cloudflare account is connected. Connect one in the dashboard (Integrations) first")
	}
	if ref == "" {
		return r.Accounts, nil
	}
	for _, acc := range r.Accounts {
		if acc.ID == ref || strings.EqualFold(acc.Name, ref) {
			return []api.CloudflareAccount{acc}, nil
		}
	}
	return nil, fmt.Errorf("no Cloudflare account named %q. See `serve cloudflare ls`", ref)
}

func (a *App) cloudflareTunnelsCmd() *cobra.Command {
	var account string
	cmd := lsCmd("tunnels", "List Cloudflare Tunnels", []string{"tunnel"}, func(cmd *cobra.Command, asJSON bool) error {
		ctx := cmd.Context()
		accounts, err := a.cloudflareAccounts(ctx, account)
		if err != nil {
			return err
		}
		var all []api.Tunnel
		for _, acc := range accounts {
			list, err := a.tunnelsOf(ctx, acc.ID)
			if err != nil {
				return err
			}
			all = append(all, list...)
		}
		if asJSON {
			if all == nil {
				all = []api.Tunnel{}
			}
			return printJSON(all)
		}
		if len(all) == 0 {
			ui.Info("No tunnels yet. Make one with `serve cloudflare tunnels create <server>`.")
			return nil
		}
		names := map[string]string{}
		for _, acc := range accounts {
			names[acc.ID] = acc.Name
		}
		var rows [][]string
		for _, t := range all {
			rows = append(rows, []string{t.ServerName, ui.StatusColor(t.Status), names[t.AccountID], tunnelDomains(&t), t.ID})
		}
		ui.Table([]string{"SERVER", "STATUS", "ACCOUNT", "DOMAINS", "ID"}, rows)
		for _, t := range all {
			if t.StatusMessage != nil && *t.StatusMessage != "" && t.Status != "healthy" {
				ui.Warn("%s: %s", t.ServerName, *t.StatusMessage)
			}
		}
		return nil
	})
	cmd.Short = "Cloudflare Tunnels: list, create, remove"
	cmd.Long = `List the Cloudflare Tunnels (one per server and account) with the domains routed through
each. Tunnels let a server serve its domains without open ports or a public address.`
	cmd.PersistentFlags().StringVar(&account, "account", "", "the Cloudflare account (`name` or id); every account by default")

	create := &cobra.Command{
		Use:   "create <server>",
		Short: "Create a tunnel from a server",
		Long: `Create a Cloudflare Tunnel from a server: Serve starts a connector there. The server's
domains can then route through Cloudflare (choose it per domain in the dashboard), and
domains that used a tunnel on this server before come back by themselves.`,
		Example: "  serve cloudflare tunnels create web-1\n  serve cloudflare tunnels create web-1 --account work",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			srv, err := a.findServer(ctx, args[0])
			if err != nil {
				return err
			}
			accID, err := a.cloudflareAccount(ctx, account)
			if err != nil {
				return err
			}
			sp := ui.StartSpinner(fmt.Sprintf("Creating a tunnel from %s", srv.Name))
			var r struct {
				Tunnel      api.Tunnel `json:"tunnel"`
				Reconnected []string   `json:"reconnected"`
				Failed      []struct {
					Hostname string `json:"hostname"`
					Error    string `json:"error"`
				} `json:"failed"`
			}
			err = a.client.Post(ctx, "/cloudflare/accounts/"+api.P(accID)+"/tunnels", map[string]any{"serverId": srv.ID}, &r)
			sp.Stop()
			if err != nil {
				return needs(err, "the Manage integrations permission (integrations.manage)")
			}
			ui.Success("Created the tunnel %s from %s (%s).", r.Tunnel.Name, srv.Name, r.Tunnel.Status)
			if len(r.Reconnected) > 0 {
				ui.Info("Reconnected: %s", strings.Join(r.Reconnected, ", "))
			}
			for _, f := range r.Failed {
				ui.Warn("%s did not reconnect: %s", f.Hostname, f.Error)
			}
			return nil
		},
	}

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <server|tunnel-id>",
		Aliases: []string{"remove", "delete"},
		Short:   "Remove a tunnel",
		Long: `Remove a server's tunnel: the connector stops and the tunnel is deleted on Cloudflare. Its
domains stop working until a tunnel runs on the server again (they reconnect by themselves
then). Asks for the server's name unless --yes.`,
		Example: "  serve cloudflare tunnels rm web-1\n  serve cloudflare tunnels rm web-1 --account work --yes",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			accounts, err := a.cloudflareAccounts(ctx, account)
			if err != nil {
				return err
			}
			var found []api.Tunnel
			for _, acc := range accounts {
				list, err := a.tunnelsOf(ctx, acc.ID)
				if err != nil {
					return err
				}
				for _, t := range list {
					if t.ID == args[0] || t.ServerID == args[0] || strings.EqualFold(t.ServerName, args[0]) || t.Name == args[0] {
						found = append(found, t)
					}
				}
			}
			switch {
			case len(found) == 0:
				return fmt.Errorf("no tunnel runs on %q. See `serve cloudflare tunnels`", args[0])
			case len(found) > 1:
				return usagef("%s has tunnels to %d accounts: pass --account or the tunnel id", args[0], len(found))
			}
			t := found[0]
			if n := len(t.Domains) + t.OtherDomains; n > 0 || t.Dashboard != nil {
				var hosts []string
				if t.Dashboard != nil {
					hosts = append(hosts, *t.Dashboard+" (the dashboard)")
				}
				for _, d := range t.Domains {
					hosts = append(hosts, d.Hostname)
				}
				if t.OtherDomains > 0 {
					hosts = append(hosts, fmt.Sprintf("%d more in projects you cannot see", t.OtherDomains))
				}
				ui.Warn("These stop working until a tunnel runs on %s again: %s", t.ServerName, strings.Join(hosts, ", "))
			}
			if err := confirmName("the tunnel of "+t.ServerName, t.ServerName, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/cloudflare/accounts/"+api.P(t.AccountID)+"/tunnels/"+api.P(t.ID), nil, nil); err != nil {
				return needs(err, "the Manage integrations permission (integrations.manage)")
			}
			ui.Success("Removed the tunnel of %s.", t.ServerName)
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")
	cmd.AddCommand(create, rm)
	return cmd
}

func tunnelDomains(t *api.Tunnel) string {
	n := len(t.Domains) + t.OtherDomains
	if t.Dashboard != nil {
		n++
	}
	switch {
	case n == 0:
		return "none"
	case n == 1 && len(t.Domains) == 1:
		return t.Domains[0].Hostname
	case n == 1 && t.Dashboard != nil:
		return *t.Dashboard
	}
	return fmt.Sprintf("%d", n)
}
