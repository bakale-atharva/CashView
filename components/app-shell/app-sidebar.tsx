"use client";

import { useQuery } from "convex/react";
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
import { primaryNavItems, workspaceNavItems, type NavItem } from "./nav-items";

function visibleItems(
  items: NavItem[],
  capabilities: string[] | undefined,
): NavItem[] {
  // While the query is loading, show nothing rather than everything: a role
  // is either known or the item stays hidden — never briefly over-permissive.
  if (capabilities === undefined) return [];
  return items.filter((item) => !item.requires || capabilities.includes(item.requires));
}

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
  const me = useQuery(api.me.getCurrentScope, {});
  const loading = me === undefined;

  const primary = visibleItems(primaryNavItems, me?.capabilities);
  const workspace = visibleItems(workspaceNavItems, me?.capabilities);

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
                ? ["a", "b", "c", "d"].map((key) => (
                    <SidebarMenuSkeleton key={key} showIcon />
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
