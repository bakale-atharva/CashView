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
import type { Capability } from "@/convex/lib/scope";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Omit for an item every authenticated scope can see. */
  requires?: Capability;
};

export const primaryNavItems: NavItem[] = [
  { title: "Dashboard", href: "/app", icon: LayoutDashboard },
  { title: "Clients", href: "/app/clients", icon: BookUser, requires: "clients.read" },
  { title: "Invoices", href: "/app/invoices", icon: Receipt, requires: "invoices.read" },
  { title: "Expenses", href: "/app/expenses", icon: Wallet, requires: "expenses.read" },
  { title: "Reports", href: "/app/reports", icon: ScrollText, requires: "reports.read" },
];

export const workspaceNavItems: NavItem[] = [
  { title: "Team", href: "/app/settings/team", icon: Users, requires: "members.manage" },
  { title: "Settings", href: "/app/settings", icon: Settings, requires: "settings.manage" },
];
