/**
 * The sections of a service's Domains & ports page, in menu order. Plain module: the page picks
 * the one shown (?section=…) and the service's menu lists them under Domains & ports.
 */
export function domainsNav(s: { type: string; composeServiceCount: number; proxy: boolean }) {
  const showPorts = s.type === "app" || (s.type === "compose" && s.composeServiceCount > 0);
  return [
    { id: "domains", label: "Domains" },
    ...(showPorts ? [{ id: "ports", label: "Ports" }] : []),
    ...(s.proxy
      ? [
          { id: "traffic", label: "Limits & balancing" },
          { id: "access", label: "Access" },
          { id: "headers", label: "Headers" },
          { id: "performance", label: "Performance" },
          { id: "proxy", label: "Proxy" },
        ]
      : []),
  ];
}
