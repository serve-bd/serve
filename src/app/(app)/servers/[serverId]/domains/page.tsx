import { DomainSettings } from "./domain-settings";
import { loadServer } from "../_lib/load";
import { env } from "@/server/env";

export const metadata = { title: "Domains" };

export default async function ServerDomainsPage(props: PageProps<"/servers/[serverId]/domains">) {
  const { serverId } = await props.params;
  const { row } = await loadServer(serverId);
  return (
    <DomainSettings
      serverId={serverId}
      isLocal={row.isLocal}
      host={row.host}
      addressing={{ publicIp: row.publicIp ?? "", wildcardDomain: row.wildcardDomain ?? "", sslipFallback: row.sslipFallback }}
      ports={row.isLocal ? { proxyHttpPort: env.proxyHttpPort, proxyHttpsPort: env.proxyHttpsPort } : { proxyHttpPort: row.proxyHttpPort, proxyHttpsPort: row.proxyHttpsPort }}
    />
  );
}
