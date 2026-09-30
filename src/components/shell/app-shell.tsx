"use client";

import { DeploymentsIndicator } from "./deployments-indicator";
import { LiveUpdates } from "./live-updates";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-router";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  Blocks,
  Cloud,
  Container,
  FolderGit2,
  Globe,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  Menu as MenuIcon,
  Moon,
  Search,
  Server,
  ShieldCheck,
  Sun,
  User,
  Users,
  Gauge,
  Bell,
  HardDriveUpload,
  KeyRound,
  Variable,
  Activity,
  AlertTriangle,
  HeartPulse,
  Settings,
  Waypoints,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Kbd } from "@/components/ui/misc";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { OrgSwitcher, type OrgItem } from "./org-switcher";
import { CommandPalette, useCommandPalette } from "./command-palette";
import { useTheme } from "@/hooks/use-client";
import { PermissionsProvider } from "@/components/permissions";
import type { Permission } from "@/lib/permissions";

type ShellProps = {
  user: { id: string; name: string; email: string; image: string | null };
  org: OrgItem;
  orgs: OrgItem[];
  projects: { id: string; name: string; color: string }[];
  isInstanceAdmin: boolean;
  /** Admins of this organization: they manage the servers it brings. */
  isOrgAdmin?: boolean;
  access: { permissions: Permission[]; roleName: string; isAdmin: boolean };
  canCreateOrg: boolean;
  instanceName: string;
  workerOnline: boolean;
  /** The worker runs older code than the dashboard (restart or rebuild it). */
  workerOutdated?: boolean;
  children: React.ReactNode;
};

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; exact?: boolean };

const mainNav: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutGrid, exact: true },
  { href: "/projects", label: "Projects", icon: Blocks },
  { href: "/domains", label: "Domains", icon: Globe },
  { href: "/certificates", label: "Certificates", icon: ShieldCheck },
  { href: "/monitoring", label: "Monitoring", icon: HeartPulse },
  { href: "/activity", label: "Activity", icon: Activity },
];

const integrationNav: NavItem[] = [
  { href: "/integrations/cloudflare", label: "Cloudflare", icon: Cloud },
  { href: "/integrations/git", label: "Git providers", icon: FolderGit2 },
  { href: "/integrations/storage", label: "S3 storage", icon: HardDriveUpload },
  { href: "/integrations/registries", label: "Registries", icon: Container },
  { href: "/integrations/notifications", label: "Notifications", icon: Bell },
];

const orgNav: NavItem[] = [
  { href: "/organization/members", label: "Members", icon: Users },
  { href: "/organization/usage", label: "Usage", icon: Gauge },
  { href: "/organization/roles", label: "Roles", icon: ShieldCheck },
  { href: "/shared-variables", label: "Shared variables", icon: Variable },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/keys", label: "Keys & tokens", icon: KeyRound },
];

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
        active ? "bg-fg/[0.06] text-fg" : "text-fg-2/80 hover:bg-fg/[0.04] hover:text-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-muted group-hover:text-fg-2")} />
      {item.label}
    </Link>
  );
}

function NavGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {title && <div className="px-2.5 pt-5 pb-1.5 text-[11px] font-semibold text-faint">{title}</div>}
      {children}
    </div>
  );
}

function SidebarContent({ props, onNavigate }: { props: ShellProps; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const palette = useCommandPalette();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/" onClick={onNavigate} className="flex min-w-0">
          <Logo />
        </Link>
      </div>
      <div className="px-3">
        <OrgSwitcher current={props.org} orgs={props.orgs} canCreate={props.canCreateOrg} />
      </div>
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => palette.setOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-faint shadow-sm transition-colors hover:border-line-strong hover:text-muted"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 pt-3 pb-4">
        <NavGroup>
          {mainNav.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </NavGroup>

        {props.access.permissions.includes("integrations.manage") && (
          <NavGroup title="Integrations">
            {integrationNav.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
          </NavGroup>
        )}

        <NavGroup title="Organization">
          {orgNav
            .filter((item) => item.href !== "/templates" || props.access.permissions.includes("integrations.manage"))
            .map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
            ))}
        </NavGroup>

        {(props.isInstanceAdmin || props.isOrgAdmin) && (
          <NavGroup title="Server">
            <NavLink item={{ href: "/servers", label: "Servers", icon: Server }} pathname={pathname} onNavigate={onNavigate} />
            <NavLink item={{ href: "/private-networks", label: "Private networks", icon: Waypoints }} pathname={pathname} onNavigate={onNavigate} />
            {props.isInstanceAdmin && <NavLink item={{ href: "/settings", label: "Settings", icon: Settings }} pathname={pathname} onNavigate={onNavigate} />}
          </NavGroup>
        )}
      </nav>

      <div className="border-t border-line p-3">
        <Menu>
          <MenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover data-[popup-open]:bg-hover">
            <Avatar name={props.user.name} src={props.user.image} />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium text-fg">{props.user.name}</span>
              <span className="truncate text-[11px] text-muted">{props.user.email}</span>
            </span>
          </MenuTrigger>
          <MenuContent side="top" align="start" className="w-60">
            <MenuItem onClick={() => router.push("/account")}>
              <User /> Account
            </MenuItem>
            <MenuItem onClick={toggle}>
              {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light theme" : "Dark theme"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={async () => {
                await authClient.signOut();
                router.replace("/login");
                router.refresh();
              }}
            >
              <LogOut /> Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

export function AppShell(props: ShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <PermissionsProvider value={props.access}>
      <CommandPalette projects={props.projects} isInstanceAdmin={props.isInstanceAdmin} isOrgAdmin={!!props.isOrgAdmin}>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-line bg-glass backdrop-blur-2xl lg:block">
            <SidebarContent props={props} />
          </aside>

          <BaseDialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
            <BaseDialog.Portal>
              <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-[var(--backdrop)] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 lg:hidden" />
              <BaseDialog.Popup className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-line bg-bg shadow-lg outline-none transition-transform duration-300 ease-[var(--ease-out-quint)] data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full lg:hidden">
                <BaseDialog.Title className="sr-only">Navigation</BaseDialog.Title>
                <SidebarContent props={props} onNavigate={() => setMobileOpen(false)} />
              </BaseDialog.Popup>
            </BaseDialog.Portal>
          </BaseDialog.Root>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur lg:hidden">
              <button type="button" onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Open navigation">
                <MenuIcon className="size-5" />
              </button>
              <Logo />
            </div>
            {(!props.workerOnline || props.workerOutdated) && (
              <div role="status" className="border-b border-warn/20 bg-warn-soft">
                <div className="flex w-full items-start gap-2.5 px-4 py-2.5 text-[13px] sm:items-center sm:px-8">
                  <AlertTriangle className="mt-0.5 size-4 flex-none text-warn sm:mt-0" />
                  {props.workerOnline ? (
                    <p className="min-w-0 text-fg-2">
                      <span className="font-medium text-fg">The worker is running older code.</span> Restart it so deployments use the latest version.
                    </p>
                  ) : (
                    <p className="min-w-0 text-fg-2">
                      <span className="font-medium text-fg">The worker is not running.</span> Deployments, backups and other jobs wait until it starts.
                    </p>
                  )}
                </div>
              </div>
            )}
            <main className="flex-1">{props.children}</main>
            <DeploymentsIndicator />
            <LiveUpdates scope={`${props.org.id}|${props.access.roleName}|${props.access.permissions.join(",")}`} />
          </div>
        </div>
      </CommandPalette>
    </PermissionsProvider>
  );
}
