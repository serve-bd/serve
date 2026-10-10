"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A field whose value is hidden until the eye is pressed (an IP address on a shared screen).
 * Not a password: the text is masked with CSS so password managers leave it alone; browsers
 * without text masking fall back to a password field.
 */
export function MaskedInput({ className, label = "value", style, ...props }: Omit<React.ComponentProps<typeof Input>, "type"> & { label?: string }) {
  const [visible, setVisible] = React.useState(false);
  const [cssMask, setCssMask] = React.useState(true);
  React.useEffect(() => setCssMask(CSS.supports("-webkit-text-security", "disc")), []);
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible || cssMask ? "text" : "password"}
        className={cn("pr-10", className as string)}
        style={visible || !cssMask ? style : ({ ...style, WebkitTextSecurity: "disc" } as React.CSSProperties)}
        data-1p-ignore
        data-lpignore="true"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-faint transition-colors hover:text-fg-2 focus-visible:text-fg-2 focus-visible:outline-none"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
