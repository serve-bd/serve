"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// IPv4, and IPv6 (two colons or more, so host:port stays readable).
const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi;

/**
 * Text with its IP addresses blurred until clicked, so a shared screen does not show where the
 * servers are. The rest of the text (user, port, host names) stays readable.
 */
export function HiddenIp({ text, className }: { text: string; className?: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(IP)) {
    parts.push(text.slice(last, m.index));
    parts.push(<BlurredIp key={m.index} ip={m[0]} />);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <span className={className}>{parts}</span>;
}

function BlurredIp({ ip }: { ip: string }) {
  const [shown, setShown] = React.useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      title={shown ? "Click to hide" : "Click to show the IP address"}
      aria-label={shown ? ip : "Hidden IP address, click to show"}
      onClick={(e) => {
        // Inside a link (a server card), showing or hiding the address never opens the link.
        e.preventDefault();
        e.stopPropagation();
        setShown((v) => !v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          setShown((v) => !v);
        }
      }}
      // A little padding makes the target bigger than the blurred text, so a click beside it does not open the card.
      className={cn("-mx-1 cursor-pointer rounded-sm px-1 transition-[filter]", !shown && "blur-[4px] select-none")}
    >
      {ip}
    </span>
  );
}
