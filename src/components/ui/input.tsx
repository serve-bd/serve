"use client";

import * as React from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-[var(--ring)]/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-bad data-[invalid]:border-bad";

const noop = () => () => {};

function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
/** Whether the browser can mask a text field (-webkit-text-security). Assumed on the server. */
function useTextSecurity() {
  return React.useSyncExternalStore(
    noop,
    () => typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc"),
    () => true,
  );
}

/** Browser tests set window.__SERVE_E2E__ so they can fill fields without clicking them first. */
function useAutomatedBrowser() {
  return React.useSyncExternalStore(
    noop,
    () => typeof window !== "undefined" && (window as { __SERVE_E2E__?: boolean }).__SERVE_E2E__ === true,
    () => false,
  );
}

/** Values that mark a real sign-in field, where the browser's password manager should help. */
const ACCOUNT_AUTOCOMPLETE = new Set(["username", "email", "current-password", "new-password", "one-time-code", "name"]);

/**
 * Text input. Browsers and password managers stay out of it unless it is a
 * real account field (autoComplete="email", "current-password"…): otherwise
 * Chrome treats any text + password pair as a login form and fills in saved
 * credentials. Secret fields (type="password") are masked with CSS instead,
 * so they are not detected as passwords at all.
 */
export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<typeof BaseInput>>(function Input({ className, type, autoComplete, ...props }, ref) {
  const masking = useTextSecurity();
  const automated = useAutomatedBrowser();
  const [touched, setArmed] = React.useState(false);
  const armed = touched || automated;
  const account = typeof autoComplete === "string" && ACCOUNT_AUTOCOMPLETE.has(autoComplete);
  if (account) return <BaseInput ref={ref} type={type} autoComplete={autoComplete} className={cn(inputClass, className as string)} {...props} />;
  const secret = type === "password";
  // Without CSS masking support, fall back to a password field that managers never fill.
  const masked = secret && masking;
  return (
    <BaseInput
      ref={ref}
      type={masked ? "text" : type}
      autoComplete={autoComplete ?? (secret && !masked ? "new-password" : "off")}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={secret ? false : props.spellCheck}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      data-form-type="other"
      // Chrome ignores autocomplete="off" but never autofills read-only fields:
      // stay read-only until the person reaches for the field.
      readOnly={props.readOnly || !armed}
      onPointerDown={(e) => {
        setArmed(true);
        props.onPointerDown?.(e);
      }}
      onFocus={(e) => {
        setArmed(true);
        props.onFocus?.(e);
      }}
      className={cn(inputClass, masked && "[-webkit-text-security:disc]", !armed && !props.readOnly && "read-only:cursor-text", className as string)}
      {...omit(props, ["readOnly", "onPointerDown", "onFocus"])}
    />
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(inputClass, "h-auto min-h-24 py-2 leading-relaxed", className)} {...props} />;
});

/** Input with a fixed prefix/suffix, e.g. https:// or .example.com */
export function InputGroup({ prefix, suffix, className, children }: { prefix?: React.ReactNode; suffix?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex h-9 items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--ring)]/40 [&_input]:h-full [&_input]:rounded-none [&_input]:border-0 [&_input]:shadow-none [&_input]:ring-0 [&_input]:focus:ring-0",
        className,
      )}
    >
      {prefix && <span className="flex items-center border-r border-line bg-surface-2 px-2.5 text-[13px] text-muted">{prefix}</span>}
      {children}
      {suffix && <span className="flex items-center border-l border-line bg-surface-2 px-2.5 text-[13px] text-muted">{suffix}</span>}
    </div>
  );
}
