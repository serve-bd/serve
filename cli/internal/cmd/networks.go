package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// Private networks: servers in the same network reach each other over WireGuard.

type networksView struct {
	Networks []api.PrivateNetwork `json:"networks"`
	Servers  []api.NetworkServer  `json:"servers"`
}

func (a *App) privateNetworks(ctx context.Context) (*networksView, error) {
	c, err := a.Client()
	if err != nil {
		return nil, err
	}
	var v networksView
	if err := c.Get(ctx, "/private-networks", nil, &v); err != nil {
		return nil, needs(err, "an admin token (the admin permission)")
	}
	return &v, nil
}

func (v *networksView) network(ref string) (*api.PrivateNetwork, error) {
	if ref == "" {
		switch len(v.Networks) {
		case 0:
			return nil, fmt.Errorf("there is no private network yet. Create one with `serve networks create <name>`")
		case 1:
			return &v.Networks[0], nil
		}
		names := make([]string, len(v.Networks))
		for i, n := range v.Networks {
			names[i] = n.Name
		}
		return nil, usagef("pass --network: %s", strings.Join(names, ", "))
	}
	for i := range v.Networks {
		if v.Networks[i].ID == ref || strings.EqualFold(v.Networks[i].Name, ref) {
			return &v.Networks[i], nil
		}
	}
	return nil, fmt.Errorf("there is no private network %q. See `serve networks`", ref)
}

func (v *networksView) server(ref string) (*api.NetworkServer, error) {
	var found []api.NetworkServer
	for _, s := range v.Servers {
		if s.ID == ref {
			return &s, nil
		}
		if strings.EqualFold(s.Name, ref) {
			found = append(found, s)
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("there is no server %q here. See `serve networks`", ref)
	case 1:
		return &found[0], nil
	}
	return nil, fmt.Errorf("%d servers are named %q: use the id", len(found), ref)
}

func (a *App) networksCmd() *cobra.Command {
	cmd := lsCmd("networks", "List private networks and their servers", []string{"network"}, func(cmd *cobra.Command, asJSON bool) error {
		v, err := a.privateNetworks(cmd.Context())
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(v)
		}
		if len(v.Networks) == 0 {
			ui.Info("No private networks yet. Create one with `serve networks create <name>`.")
		} else {
			var rows [][]string
			for _, n := range v.Networks {
				names := make([]string, len(n.Servers))
				for i, s := range n.Servers {
					names[i] = s.Name
					if !s.Joined {
						names[i] += " (not joined)"
					}
				}
				rows = append(rows, []string{n.Name, strings.Join(names, ", "), n.ID})
			}
			ui.Table([]string{"NETWORK", "SERVERS", "ID"}, rows)
		}
		var waiting []string
		for _, s := range v.Servers {
			if !s.Joined {
				waiting = append(waiting, s.Name)
			}
		}
		if len(waiting) > 0 {
			ui.Line(ui.Dim("Not joined yet: " + strings.Join(waiting, ", ") + ". A server joins from its Private network page in the dashboard."))
		}
		return nil
	})
	cmd.Short = "Private networks between servers: list, create, delete, join, leave"
	cmd.Long = `List the private networks: servers in the same network reach each other over WireGuard,
and services on them can talk across servers. For admins; in the Root organization every
network, elsewhere the organization's own.`

	var servers []string
	create := &cobra.Command{
		Use:     "create <name>",
		Short:   "Create a private network",
		Long:    "Create a private network, optionally with servers in it (--server, more than once). A server must have joined the private network first, from its page in the dashboard.",
		Example: "  serve networks create backend\n  serve networks create backend --server web-1 --server db-1",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			body := map[string]any{"name": args[0]}
			if len(servers) > 0 {
				v, err := a.privateNetworks(ctx)
				if err != nil {
					return err
				}
				var ids []string
				for _, ref := range servers {
					s, err := v.server(ref)
					if err != nil {
						return err
					}
					ids = append(ids, s.ID)
				}
				body["serverIds"] = ids
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := c.Post(ctx, "/private-networks", body, nil); err != nil {
				return needs(err, "an admin token (the admin permission)")
			}
			ui.Success("Created the private network %s.", args[0])
			return nil
		},
	}
	create.Flags().StringArrayVar(&servers, "server", nil, "a server (`name` or id) to put in it; repeat for more")

	var yes bool
	rm := &cobra.Command{
		Use:     "rm <network>",
		Aliases: []string{"remove", "delete"},
		Short:   "Delete a private network",
		Long:    "Delete a private network. Its servers stop reaching each other, unless they share another network. Asks for its name unless --yes.",
		Example: "  serve networks rm backend",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			v, err := a.privateNetworks(ctx)
			if err != nil {
				return err
			}
			n, err := v.network(args[0])
			if err != nil {
				return err
			}
			if len(n.Servers) > 0 {
				names := make([]string, len(n.Servers))
				for i, s := range n.Servers {
					names[i] = s.Name
				}
				ui.Warn("%s stop reaching each other through %s.", strings.Join(names, ", "), n.Name)
			}
			if err := confirmName("the private network "+n.Name, n.Name, yes); err != nil {
				return err
			}
			if err := a.client.Delete(ctx, "/private-networks/"+api.P(n.ID), nil, nil); err != nil {
				return needs(err, "an admin token (the admin permission)")
			}
			ui.Success("Deleted the private network %s.", n.Name)
			return nil
		},
	}
	rm.Flags().BoolVarP(&yes, "yes", "y", false, "do not ask for the name")

	cmd.AddCommand(create, rm, a.networkMemberCmd(true), a.networkMemberCmd(false))
	return cmd
}

// networkMemberCmd is serve networks join or leave.
func (a *App) networkMemberCmd(join bool) *cobra.Command {
	var network string
	use, short, long, example := "join <server>", "Put a server in a private network",
		"Put a server in a private network (--network, or the only one). The server must have joined the private network first, from its Private network page in the dashboard.",
		"  serve networks join web-1\n  serve networks join web-1 --network backend"
	if !join {
		use, short, long, example = "leave <server>", "Take a server out of a private network",
			"Take a server out of a private network (--network, or the only one). It stops reaching the network's other servers, unless they share another network.",
			"  serve networks leave web-1 --network backend"
	}
	cmd := &cobra.Command{
		Use:     use,
		Short:   short,
		Long:    long,
		Example: example,
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			v, err := a.privateNetworks(ctx)
			if err != nil {
				return err
			}
			n, err := v.network(network)
			if err != nil {
				return err
			}
			s, err := v.server(args[0])
			in := false
			if err == nil {
				for _, m := range n.Servers {
					in = in || m.ID == s.ID
				}
			} else if !join {
				// A server the organization no longer sees can still be taken out by its id.
				for _, m := range n.Servers {
					if m.ID == args[0] || strings.EqualFold(m.Name, args[0]) {
						s, err, in = &api.NetworkServer{ID: m.ID, Name: m.Name, Joined: m.Joined}, nil, true
					}
				}
			}
			if err != nil {
				return err
			}
			if join && in {
				ui.Info("%s is in %s already.", s.Name, n.Name)
				return nil
			}
			if !join && !in {
				ui.Info("%s is not in %s.", s.Name, n.Name)
				return nil
			}
			if join && !s.Joined {
				return fmt.Errorf("%s has not joined the private network yet. Join it from its Private network page in the dashboard first", s.Name)
			}
			if err := a.client.PutJSON(ctx, "/private-networks/"+api.P(n.ID)+"/members", map[string]any{"serverId": s.ID, "member": join}, nil); err != nil {
				return needs(err, "an admin token (the admin permission)")
			}
			if join {
				ui.Success("Put %s in %s.", s.Name, n.Name)
			} else {
				ui.Success("Took %s out of %s.", s.Name, n.Name)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&network, "network", "", "the private network (`name` or id); the only one by default")
	return cmd
}
