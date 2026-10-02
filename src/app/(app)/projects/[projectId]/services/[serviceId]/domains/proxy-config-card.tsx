"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, EmptyState, Copyable } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { CodeView } from "@/components/code-view";
import { saveServiceProxyCustom } from "@/server/actions/service-proxy";
import { cn } from "@/lib/utils";

type RunningKind = "nginx" | "caddy" | "traefik";
const LABEL: Record<RunningKind, string> = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik" };
const FORMAT: Record<RunningKind, string> = { nginx: "nginx server blocks", caddy: "Caddyfile site blocks", traefik: "Traefik dynamic configuration (YAML)" };

/** How the proxy serves this service: Serve's generated configuration or a full custom one for the current proxy. */
export function ProxyConfigCard({
  serviceId,
  kind,
  generated,
  custom,
  otherCustom,
  hasDomains,
  alias,
}: {
  serviceId: string;
  kind: RunningKind;
  generated: string | null;
  custom: string | null;
  /** Proxies (other than the current one) that have a custom configuration saved for this service. */
  otherCustom: RunningKind[];
  hasDomains: boolean;
  /** Stable upstream address (network alias and port) that survives redeploys. */
  alias: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [mode, setMode] = React.useState<"managed" | "custom">(custom ? "custom" : "managed");
  const [value, setValue] = React.useState(custom ?? generated ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const dirty = mode === "custom" ? value !== (custom ?? "") : !!custom;

  const save = async (content: string | null) => {
    setPending(true);
    setError(null);
    const res = await saveServiceProxyCustom(serviceId, content);
    setPending(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  };

  if (!hasDomains) {
    return (
      <Card>
        <CardHeader title="Proxy config" description={`How ${LABEL[kind]} serves this service.`} />
        <EmptyState title="No domains yet" description="Add a domain to configure how the proxy serves this service." />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Proxy config"
        description={`The ${LABEL[kind]} configuration for this service's domains. Root admins only.`}
        actions={
          custom && (
            <Button
              size="sm"
              variant="ghost"
              loading={pending && mode === "managed"}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Reset to defaults?",
                    description: "The custom configuration is removed and the generated configuration applies again.",
                    confirmLabel: "Reset",
                  })
                ) {
                  setMode("managed");
                  await save(null);
                }
              }}
            >
              <RotateCcw /> Reset to defaults
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        <div role="radiogroup" aria-label="Configuration mode" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              ["managed", "Generated", "Generated from the domains and HTTP options on this page."],
              ["custom", "Custom", `Your own ${FORMAT[kind]} replace the generated ones.`],
            ] as const
          ).map(([key, title, description]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              onClick={() => {
                setMode(key);
                setError(null);
                if (key === "custom" && !value) setValue(generated ?? "");
              }}
              className={cn(
                "flex flex-col gap-0.5 rounded-xl border px-4 py-3 text-left transition-colors",
                mode === key ? "border-accent bg-accent-soft/30" : "border-line hover:bg-surface-2",
              )}
            >
              <span className="text-[13px] font-medium text-fg">{title}</span>
              <span className="text-xs text-muted">{description}</span>
            </button>
          ))}
        </div>
        {otherCustom.length > 0 && !custom && (
          <p className="text-xs text-muted">
            A custom {otherCustom.map((k) => LABEL[k]).join(" and ")} configuration is saved for this service. This server runs {LABEL[kind]}, so the generated configuration
            applies. The saved one comes back if you switch the proxy back.
          </p>
        )}
        {mode === "custom" && (
          <div className="flex items-start gap-2.5 rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-3 text-[13px] text-fg-2">
            <TriangleAlert className="mt-0.5 size-4 flex-none text-warn" />
            <span>
              Changes to domains and HTTP options on this page do not apply while the configuration is custom. Container names change on every deploy
              {alias ? (
                <>
                  ; point the upstream at <code className="font-mono text-[12px]">{alias}</code> instead
                </>
              ) : null}
              .
            </span>
          </div>
        )}
        {mode === "managed" ? (
          generated ? (
            <CodeView code={generated} maxHeight="480px" />
          ) : (
            <p className="text-[13px] text-muted">No configuration is written for this service yet.</p>
          )
        ) : (
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={20}
            spellCheck={false}
            aria-label={`Custom ${LABEL[kind]} configuration`}
            className="font-mono text-[12.5px] leading-relaxed"
          />
        )}
        {error && (
          <Copyable value={error}>
            <div className="flex items-start gap-2.5 rounded-xl border border-bad/15 bg-bad-soft/60 py-3 pr-10 pl-3.5">
              <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />
              <pre className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{error}</pre>
            </div>
          </Copyable>
        )}
      </CardBody>
      {dirty && (
        <CardFooter>
          <span className="truncate text-xs text-muted">{mode === "managed" ? "Switch back to the generated configuration" : "Unsaved changes"}</span>
          <div className="flex flex-none gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode(custom ? "custom" : "managed");
                setValue(custom ?? generated ?? "");
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" size="sm" loading={pending} onClick={() => save(mode === "managed" ? null : value)}>
              Test and apply
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
