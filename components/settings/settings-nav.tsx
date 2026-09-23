"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { api } from "@/convex/_generated/api";

const TABS = [
  { title: "Overview", href: "/app/settings" },
  { title: "Branding", href: "/app/settings/branding", requires: "settings.manage" },
  { title: "Plan & billing", href: "/app/settings/billing" },
  { title: "Team", href: "/app/settings/team", orgOnly: true, requires: "members.manage" },
  { title: "Audit log", href: "/app/settings/audit", requires: "audit.read" },
] as const;

export function SettingsNav() {
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.me.getCurrentScope, isAuthenticated ? {} : "skip");

  // While the scope is still loading, show only the ungated tabs rather than
  // briefly flashing Team/Audit to someone who won't keep access to them
  // (nav-items.ts's visibleNavItems follows the same rule).
  const tabs = TABS.filter((tab) => {
    if ("requires" in tab && me === undefined) return false;
    if ("orgOnly" in tab && tab.orgOnly && me?.scopeKind !== "org") return false;
    if ("requires" in tab && me !== undefined && !me.capabilities.includes(tab.requires)) return false;
    return true;
  });

  return (
    <nav className="flex gap-1 border-b border-border" aria-label="Settings">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.title}
          </Link>
        );
      })}
    </nav>
  );
}
