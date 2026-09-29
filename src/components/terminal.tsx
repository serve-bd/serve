"use client";

import * as React from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";

export type TerminalStatus = "connecting" | "connected" | "exited" | "error";

export type TerminalHandle = {
  /** Type text into the shell, as if pasted. */
  send: (data: string) => void;
  focus: () => void;
  clear: () => void;
};

const THEME = {
  foreground: "#e5e5ea",
  cursor: "#0a84ff",
  cursorAccent: "#0a0a0b",
  selectionBackground: "rgba(10, 132, 255, 0.35)",
  black: "#1c1c1e",
  red: "#ff6961",
  green: "#30d158",
  yellow: "#ffd60a",
  blue: "#0a84ff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#e5e5ea",
  brightBlack: "#636366",
  brightRed: "#ff8a84",
  brightGreen: "#5de07e",
  brightYellow: "#ffe45c",
  brightBlue: "#409cff",
  brightMagenta: "#da8fff",
  brightCyan: "#8ee0ff",
  brightWhite: "#ffffff",
};

function decode(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Interactive shell in a service container, rendered with xterm.js.
 * Output arrives over Server-Sent Events; keystrokes are posted in order.
 * Remount (change `key`) to start a new session.
 */
export function Terminal({
  endpoint,
  target = null,
  onStatus,
  ref,
  className,
}: {
  /** Session API base, like `/api/services/<id>/terminal` or `/api/server/terminal`. */
  endpoint: string;
  /** Container to open the shell in, for services with several. */
  target?: string | null;
  onStatus?: (status: TerminalStatus, detail?: string) => void;
  ref?: React.Ref<TerminalHandle>;
  className?: string;
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const term = React.useRef<XTerm | null>(null);
  const sendRef = React.useRef<(data: string) => void>(() => {});
  const statusRef = React.useRef(onStatus);
  React.useLayoutEffect(() => {
    statusRef.current = onStatus;
  });

  React.useImperativeHandle(ref, () => ({
    send: (data) => sendRef.current(data),
    focus: () => term.current?.focus(),
    clear: () => term.current?.clear(),
  }));

  React.useEffect(() => {
    let disposed = false;
    let sessionUrl: string | null = null;
    let events: EventSource | null = null;
    let observer: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const report = (status: TerminalStatus, detail?: string) => !disposed && statusRef.current?.(status, detail);

    // Keystrokes are batched and sent one request at a time so they never reorder.
    let pending = "";
    let flushing = false;
    const flush = async () => {
      if (flushing || !sessionUrl) return;
      flushing = true;
      while (pending && !disposed) {
        const data = pending;
        pending = "";
        const res = await fetch(sessionUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "input", data }) }).catch(() => null);
        if (res?.status === 404) break;
      }
      flushing = false;
    };
    sendRef.current = (data) => {
      pending += data;
      void flush();
    };

    void (async () => {
      const [{ Terminal: XTermCtor }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      await document.fonts?.ready;
      if (disposed || !host.current) return;
      const code = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
      const xterm = new XTermCtor({
        fontFamily: `${code ? `${code}, ` : ""}ui-monospace, "SF Mono", Menlo, monospace`,
        fontSize: window.innerWidth < 640 ? 12 : 13,
        lineHeight: 1.25,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 5000,
        allowProposedApi: false,
        macOptionIsMeta: true,
        theme: { ...THEME, background: getComputedStyle(host.current.parentElement ?? host.current).backgroundColor || "#0a0a0b" },
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(host.current);
      fit.fit();
      term.current = xterm;
      xterm.onData((data) => sendRef.current(data));
      xterm.focus();

      report("connecting");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, cols: xterm.cols, rows: xterm.rows }),
      }).catch(() => null);
      if (disposed) {
        const body = await res?.json().catch(() => null);
        if (body?.id) void fetch(`${endpoint}/${body.id}`, { method: "DELETE", keepalive: true });
        return;
      }
      const body = (await res?.json().catch(() => null)) as { id?: string; error?: string } | null;
      if (!res?.ok || !body?.id) {
        const message = body?.error ?? "Could not reach the server.";
        xterm.write(`\x1b[31m${message}\x1b[0m\r\n`);
        report("error", message);
        return;
      }
      sessionUrl = `${endpoint}/${body.id}`;
      void flush();

      events = new EventSource(sessionUrl);
      events.onopen = () => report("connected");
      events.onmessage = (e) => xterm.write(decode(e.data));
      events.addEventListener("exit", (e) => {
        const { code } = JSON.parse((e as MessageEvent).data) as { code: number | null };
        xterm.write(`\r\n\x1b[2m[Session ended${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`);
        events?.close();
        sessionUrl = null;
        report("exited");
      });
      events.onerror = () => {
        // EventSource retries on its own; CLOSED means the session is gone.
        if (events?.readyState === EventSource.CLOSED) {
          sessionUrl = null;
          report("exited");
        } else report("connecting");
      };

      observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed) return;
          fit.fit();
          if (sessionUrl) void fetch(sessionUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }) });
        }, 80);
      });
      observer.observe(host.current);
    })();

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      events?.close();
      if (sessionUrl) void fetch(sessionUrl, { method: "DELETE", keepalive: true });
      term.current?.dispose();
      term.current = null;
    };
  }, [endpoint, target]);

  // Padding lives on the wrapper so the fit addon measures the exact drawing area.
  return (
    <div className={cn("bg-log-bg", className)} onClick={() => term.current?.focus()}>
      <div ref={host} className="size-full" />
    </div>
  );
}
