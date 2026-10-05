import { KeyRound } from "lucide-react";
import { GithubMark } from "@/components/github-mark";
import { cn } from "@/lib/utils";

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z" />
    </svg>
  );
}

function MicrosoftMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

function GitlabMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#FC6D26"
        d="m23.6 9.6-.03-.09-3.27-8.52a.85.85 0 0 0-1.62.06l-2.2 6.75H7.53L5.32 1.05a.85.85 0 0 0-1.62-.06L.43 9.5l-.03.09a6.07 6.07 0 0 0 2.01 7.01l.01.01.03.02 4.98 3.73 2.47 1.86 1.5 1.14a1 1 0 0 0 1.22 0l1.5-1.14 2.47-1.86 5.01-3.75.01-.01a6.08 6.08 0 0 0 2-7z"
      />
    </svg>
  );
}

function BitbucketMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#2684FF"
        d="M.78 1.21a.77.77 0 0 0-.77.89l3.26 19.81c.09.5.52.87 1.03.87h15.65c.38 0 .7-.27.77-.65l3.27-20.03a.77.77 0 0 0-.77-.89H.78zM14.52 15.53H9.52L8.17 8.47h7.56l-1.21 7.06z"
      />
    </svg>
  );
}

/** Mark of a sign-in provider. */
export function SsoMark({ provider, className }: { provider: string; className?: string }) {
  if (provider === "github") return <GithubMark className={cn("size-4", className)} />;
  if (provider === "google") return <GoogleMark className={cn("size-4", className)} />;
  if (provider === "microsoft") return <MicrosoftMark className={cn("size-4", className)} />;
  if (provider === "gitlab") return <GitlabMark className={cn("size-4", className)} />;
  if (provider === "bitbucket") return <BitbucketMark className={cn("size-4", className)} />;
  return <KeyRound className={cn("size-4", className)} />;
}
