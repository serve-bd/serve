package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// findDomain finds a domain of the service by host name (or URL) or id.
func (a *App) findDomain(ctx context.Context, s *api.Service, ref string) (*api.Domain, error) {
	list, err := a.client.Domains(ctx, s.ID)
	if err != nil {
		return nil, err
	}
	host := hostOnly(ref)
	for i, d := range list {
		if strings.EqualFold(d.Hostname, host) || d.ID == ref {
			return &list[i], nil
		}
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("%s has no domains", s.Name)
	}
	names := make([]string, len(list))
	for i, d := range list {
		names[i] = d.Hostname
	}
	return nil, fmt.Errorf("%s has no domain %s. It has: %s", s.Name, host, strings.Join(names, ", "))
}

func (a *App) domainGenerateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "generate",
		Short: "Add a generated domain (a free address on the server's wildcard domain)",
		Long: `Add a generated domain to the service: a free address on the server's wildcard
domain, or on sslip.io when the server has none. Useful when you have no domain of your own yet,
or removed the one Serve made.`,
		Example: "  serve domains generate\n  serve domains generate --service api",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			before, err := a.client.Domains(ctx, s.ID)
			if err != nil {
				return err
			}
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/domains/generate", nil, nil); err != nil {
				return err
			}
			had := map[string]bool{}
			for _, d := range before {
				had[d.ID] = true
			}
			after, err := a.client.Domains(ctx, s.ID)
			if err == nil {
				for _, d := range after {
					if !had[d.ID] {
						ui.Success("Added %s to %s.", ui.Bold(d.URL), s.Name)
						return nil
					}
				}
			}
			ui.Success("Added a generated domain to %s.", s.Name)
			return nil
		},
	}
}

func (a *App) domainCheckCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "check <domain>",
		Short: "Check where a domain's DNS points",
		Long: `Look up the domain in public DNS and say whether it points at the service's server.
Exits with 1 when it does not (yet), so scripts can wait for DNS.`,
		Example: "  serve domains check shop.example.com\n  serve domains check shop.example.com --json",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			d, err := a.findDomain(ctx, s, args[0])
			if err != nil {
				return err
			}
			var r struct{ DNS api.DNSCheck }
			if err := a.client.Post(ctx, "/domains/"+api.P(d.ID)+"/check-dns", nil, &r); err != nil {
				return err
			}
			if asJSON {
				return printJSON(r.DNS)
			}
			host, records := ui.Bold(d.Hostname), strings.Join(r.DNS.Records, ", ")
			switch r.DNS.Status {
			case "ok":
				if records == "" {
					ui.Success("%s works without a DNS record (it names the server's address).", host)
				} else {
					ui.Success("%s points at the server (%s).", host, records)
				}
				return nil
			case "proxied":
				ui.Warn("%s points at a proxy (%s), so where it ends up cannot be seen from here.", host, records)
				ui.Line(ui.Dim("Connect the DNS account in the dashboard to check it, or open the site to see whether it works."))
				return nil
			case "missing":
				ui.Warn("%s has no A record yet. Add one pointing at the server, then check again.", host)
			case "wrong":
				ui.Warn("%s points at %s, not at the service's server.", host, records)
			default:
				ui.Warn("%s points at %s, but the server's public address is not known, so Serve cannot tell whether that is right.", host, records)
			}
			return silentExit(ExitError)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) domainRetryCertCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "retry-cert <domain>",
		Aliases: []string{"retry-certificate"},
		Short:   "Ask for the domain's HTTPS certificate again",
		Long: `Ask for the domain's free HTTPS certificate again, for example after fixing its DNS.
The certificate comes in the background, usually within a minute.`,
		Example: "  serve domains retry-cert shop.example.com",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			d, err := a.findDomain(ctx, s, args[0])
			if err != nil {
				return err
			}
			if !d.HTTPS {
				return fmt.Errorf("%s is served over plain HTTP, so it has no certificate. Turn HTTPS on with `serve domains set %s --https`", d.Hostname, d.Hostname)
			}
			if err := a.client.Post(ctx, "/domains/"+api.P(d.ID)+"/retry-certificate", nil, nil); err != nil {
				return err
			}
			ui.Success("Asked for the certificate of %s again. It usually comes within a minute.", ui.Bold(d.Hostname))
			ui.Line(ui.Dim("Check that DNS points at the server with `serve domains check " + d.Hostname + "`."))
			return nil
		},
	}
}

func (a *App) domainSetCmd() *cobra.Command {
	var redirect, composeService string
	var port int
	var primary, https, forceHTTPS, noRedirect bool
	cmd := &cobra.Command{
		Use:   "set <domain>",
		Short: "Change a domain: main domain, redirect, port, HTTPS",
		Long: `Change the settings of one of the service's domains. Only the flags you pass change.
--primary makes it the main domain, --redirect sends every visit to another address, --port
picks the container port it reaches, --https and --force-https turn HTTPS on or off.`,
		Example: "  serve domains set shop.example.com --primary\n  serve domains set www.shop.example.com --redirect https://shop.example.com\n  serve domains set api.example.com --port 8080",
		Args:    exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f := cmd.Flags()
			body := map[string]any{}
			if f.Changed("redirect") && noRedirect {
				return usagef("pass --redirect or --no-redirect, not both")
			}
			if f.Changed("redirect") {
				if redirect == "" {
					return usagef("--redirect needs an address. To stop redirecting, pass --no-redirect")
				}
				body["redirectTo"] = redirect
			}
			if noRedirect {
				body["redirectTo"] = nil
			}
			if f.Changed("port") {
				if port < 0 || port > 65535 {
					return usagef("--port must be from 1 to 65535, or 0 for the service's own port")
				}
				if port == 0 {
					body["port"] = nil
				} else {
					body["port"] = port
				}
			}
			if f.Changed("https") {
				body["https"] = https
			}
			if f.Changed("force-https") {
				body["forceHttps"] = forceHTTPS
			}
			if f.Changed("compose-service") {
				if composeService == "" {
					body["composeService"] = nil
				} else {
					body["composeService"] = composeService
				}
			}
			if f.Changed("primary") {
				if !primary {
					return usagef("a domain stops being the main one when another becomes it: pass --primary on that one")
				}
				body["primary"] = true
			}
			if len(body) == 0 {
				return usagef("nothing to change: pass at least one flag (see --help)")
			}
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", anyService)
			if err != nil {
				return err
			}
			d, err := a.findDomain(ctx, s, args[0])
			if err != nil {
				return err
			}
			var r struct{ Domain api.Domain }
			if err := a.client.Patch(ctx, "/domains/"+api.P(d.ID), body, &r); err != nil {
				return err
			}
			ui.Success("Updated %s.", ui.Bold(d.Hostname))
			if v, ok := body["https"].(bool); ok && v && !r.Domain.HTTPS {
				ui.Warn("%s is reached through a tunnel, which gives it HTTPS itself: HTTPS at the server stays off.", d.Hostname)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.BoolVar(&primary, "primary", false, "make it the main domain")
	f.StringVar(&redirect, "redirect", "", "send visits to this `url`")
	f.BoolVar(&noRedirect, "no-redirect", false, "stop redirecting and serve the app")
	f.IntVar(&port, "port", 0, "the container `port` it reaches (0 for the service's own)")
	f.BoolVar(&https, "https", false, "HTTPS with a free certificate (--https=false for plain HTTP)")
	f.BoolVar(&forceHTTPS, "force-https", false, "send http:// visits to https:// (--force-https=false to stop)")
	f.StringVar(&composeService, "compose-service", "", "for a compose stack: the `service` it reaches")
	return cmd
}
