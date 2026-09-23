import type { LucideIcon } from "lucide-react";
import {
  BookUser,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Settings,
  Users,
  Wallet,
} from "lucide-react";
import type { Feature } from "@/convex/lib/entitlements";
import type { Capability } from "@/convex/lib/scope";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Role gate. Omit for an item every authenticated scope can see. */
  requires?: Capability;
  /** Plan gate: hidden unless the active scope's plan includes it. */
  feature?: Feature;
};

export const primaryNavItems: NavItem[] = [
  { title: "Dashboard", href: "/app", icon: LayoutDashboard },
  { title: "Clients", href: "/app/clients", icon: BookUser, requires: "clients.read" },
  { title: "Invoices", href: "/app/invoices", icon: Receipt, requires: "invoices.read" },
  { title: "Expenses", href: "/app/expenses", icon: Wallet, requires: "expenses.read" },
  {
    title: "Reports",
    href: "/app/reports",
    icon: ScrollText,
    requires: "reports.read",
    feature: "reports",
  },
];

/**
 * Items the active scope may see: its role grants the capability *and* its
 * plan includes the feature. While either is loading, show nothing rather
 * than everything — never briefly over-permissive.
 */
export function visibleNavItems(
  items: NavItem[],
  capabilities: readonly string[] | undefined,
  features: readonly string[] | undefined,
): NavItem[] {
  if (capabilities === undefined || features === undefined) return [];
  return items.filter(
    (item) =>
      (!item.requires || capabilities.includes(item.requires)) &&
      (!item.feature || features.includes(item.feature)),
  );
}

export const workspaceNavItems: NavItem[] = [
  { title: "Team", href: "/app/settings/team", icon: Users, requires: "members.manage" },
  { title: "Settings", href: "/app/settings", icon: Settings, requires: "settings.manage" },
];
