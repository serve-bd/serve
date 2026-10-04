"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, BookOpen, Download, KeyRound } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CopyButton, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { useAction } from "@/hooks/use-action";
import { EXPIRY_OPTIONS, type TokenGrant } from "@/lib/api-scopes";
import { grafanaDashboard, metricsUrl, prometheusScrapeConfig } from "@/lib/metrics-export";
import { createApiToken } from "@/server/actions/org";

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CodeBlock({ value, copy }: { value: string; copy?: string }) {
  return (
    <div className="relative">
      <pre className="scrollbar-thin overflow-x-auto rounded-xl bg-log-bg p-3.5 pr-20 font-mono text-[12px] leading-relaxed text-log-fg">{value}</pre>
      <CopyButton value={copy ?? value} className="absolute top-2 right-2" />
    </div>
  );
}

export function MetricsExport({
  baseUrl,
  apiEnabled,
  canReadRequests,
  hostMetrics,
}: {
  baseUrl: string;
  apiEnabled: boolean;
  /** The member may read logs, so a scrape token can include request rates. */
  canReadRequests: boolean;
  /** Tokens made here also get the servers' own figures (Root admins in the Root organization). */
  hostMetrics: boolean;
}) {
  const [name, setName] = React.useState("Prometheus");
  const [expiry, setExpiry] = React.useState("never");
  const [token, setToken] = React.useState<string | null>(null);
  const grants: TokenGrant[] = canReadRequests ? ["projects.view", "logs.view"] : ["projects.view"];
  const create = useAction(
    () => createApiToken({ name: name.trim() || "Prometheus", scopes: grants, expiresInDays: expiry === "never" ? null : Number(expiry), projectIds: null }),
    { onSuccess: (d) => setToken(d.token), refresh: false },
  );
  const endpoint = metricsUrl(baseUrl);
  const config = prometheusScrapeConfig(baseUrl, token);

  return (
    <>
      <PageHeader
        title="Metrics"
        description="Scrape your services' CPU, memory, network, requests and deployments with your own Prometheus, and chart them in Grafana."
        actions={
          <a href="https://serve.bd/docs/metrics-export" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <BookOpen /> Docs
          </a>
        }
      />
      <PageBody className="flex max-w-4xl flex-col gap-6">
        {!apiEnabled && (
          <p className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <AlertTriangle className="mt-0.5 size-4 flex-none" />
            The API is turned off on this Serve instance, so scrapes get an error. An admin of the Root organization can turn it on in Settings, Security.
          </p>
        )}

        <Card>
          <CardHeader title="Endpoint" description="Prometheus text format. Send a token of this organization as a Bearer token." />
          <div className="flex flex-col gap-3 px-5 py-4">
            <CopyField value={endpoint} />
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted">
              <li>Every service of this organization the token can reach: CPU, memory, network, running containers, restarts, status and deployments.</li>
              <li>
                Request and 5xx rates per service, when the token may read logs.
                {!canReadRequests && " Your role cannot read logs, so tokens you make leave them out."}
              </li>
              {hostMetrics && <li>The servers' own CPU, memory, disk and load: your tokens in this organization get them because you are a Root admin.</li>}
              <li>Figures come from the samples Serve takes every 30 seconds; the answer is cached for 5 seconds.</li>
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Scrape token"
            description={
              token ? (
                "Copy it now: you won't see it again. It is already filled in below."
              ) : (
                <>
                  A read-only token that can only view projects{canReadRequests ? " and read logs" : ""}. Revoke it any time in{" "}
                  <Link href="/keys/api-tokens" className="text-accent hover:underline">
                    Keys & tokens
                  </Link>
                  .
                </>
              )
            }
          />
          <div className="px-5 py-4">
            {token ? (
              <CopyField value={token} secret />
            ) : (
              <form
                className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create.run();
                }}
              >
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Prometheus" />
                </Field>
                <Field label="Expires in">
                  <Select value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                </Field>
                <Button type="submit" variant="primary" size="sm" className="h-9" loading={create.pending}>
                  <KeyRound /> Create scrape token
                </Button>
              </form>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="prometheus.yml" description="Add this to scrape_configs. Each Prometheus can use its own token." />
          <div className="px-5 py-4">
            <CodeBlock value={token ? prometheusScrapeConfig(baseUrl, `${token.slice(0, 10)}…`) : config} copy={config} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Grafana dashboard"
            className="border-b-0"
            description="CPU, memory, network, running containers, requests and 5xx per service, with project and service pickers. In Grafana: Dashboards, New, Import, then pick your Prometheus."
            actions={
              <Button size="sm" onClick={() => download("serve-grafana-dashboard.json", `${JSON.stringify(grafanaDashboard(), null, 2)}\n`)}>
                <Download /> Download JSON
              </Button>
            }
          />
        </Card>
      </PageBody>
    </>
  );
}
