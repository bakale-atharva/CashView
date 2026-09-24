"use client";

import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { LogoMark } from "@/components/brand/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useEntitlements } from "@/lib/use-entitlements";
import {
  primaryNavItems,
  visibleNavItems,
  workspaceNavItems,
  type NavItem,
} from "./nav-items";

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const isActive = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link href={item.href} />}
        isActive={isActive}
        tooltip={item.title}
      >
        <item.icon />
        <span>{item.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.me.getCurrentScope, isAuthenticated ? {} : "skip");
  const entitlements = useEntitlements();
  const loading = me === undefined || entitlements === undefined;

  const primary = visibleNavItems(primaryNavItems, me?.capabilities, entitlements?.features);
  const workspace = visibleNavItems(workspaceNavItems, me?.capabilities, entitlements?.features);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/app" className="text-sidebar-foreground" />}
              className="hover:bg-transparent"
            >
              <LogoMark className="size-6 shrink-0 text-sidebar-primary" />
              <span className="text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                CashView
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {loading
                ? ["a", "b", "c", "d"].map((key, i) => (
                    <SidebarMenuSkeleton key={key} showIcon index={i} />
                  ))
                : primary.map((item) => (
                    <NavLink key={item.href} item={item} pathname={pathname} />
                  ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {workspace.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {workspace.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
