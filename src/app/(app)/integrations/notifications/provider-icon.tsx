import {
  Bell,
  BellRing,
  Grid3x3,
  Hash,
  Mail,
  MessageCircle,
  MessageCircleMore,
  MessageSquareText,
  MessagesSquare,
  Rocket,
  Send,
  ShieldAlert,
  Siren,
  Smartphone,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { providerInfo } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const icons: Record<string, LucideIcon> = {
  slack: Hash,
  discord: MessagesSquare,
  teams: UsersRound,
  googlechat: MessageCircle,
  mattermost: MessageSquareText,
  rocketchat: Rocket,
  telegram: Send,
  matrix: Grid3x3,
  ntfy: BellRing,
  gotify: Bell,
  pushover: Smartphone,
  pushbullet: Zap,
  pagerduty: Siren,
  opsgenie: ShieldAlert,
  email: Mail,
  twilio: MessageCircleMore,
  webhook: Webhook,
};

/** Colored tile for a provider. No logos: an icon on the provider's color. */
export function ProviderIcon({ kind, size = "md", className }: { kind: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const Icon = icons[kind] ?? Bell;
  const color = providerInfo(kind)?.color ?? "#6B7280";
  return (
    <span
      className={cn(
        "flex flex-none items-center justify-center text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]",
        size === "sm" ? "size-6 rounded-md [&_svg]:size-3.5" : size === "lg" ? "size-11 rounded-xl [&_svg]:size-5" : "size-9 rounded-[10px] [&_svg]:size-[18px]",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      <Icon />
    </span>
  );
}
