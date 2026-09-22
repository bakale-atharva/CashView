"use client";

import { OrganizationSwitcher, useOrganization, UserButton } from "@clerk/nextjs";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useCommandPalette } from "./command-palette";

const clerkAppearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorBackground: "var(--popover)",
    colorForeground: "var(--popover-foreground)",
    colorMutedForeground: "var(--muted-foreground)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-sans)",
  },
};

/** Never ambiguous which books are open, even with the switcher closed. */
function ScopeIndicator() {
  const { organization, isLoaded } = useOrganization();
  if (!isLoaded) {
    return <Badge variant="secondary" className="h-6 w-24 animate-pulse" aria-hidden />;
  }
  return (
    <Badge variant="secondary" className="h-6 font-normal">
      {organization ? organization.name : "Personal account"}
    </Badge>
  );
}

export function TopBar() {
  const { open } = useCommandPalette();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-5" />
      <ScopeIndicator />
      <OrganizationSwitcher
        hidePersonal={false}
        appearance={clerkAppearance}
        afterSelectOrganizationUrl="/app"
        afterSelectPersonalUrl="/app"
        afterCreateOrganizationUrl="/app"
      />
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground"
          onClick={open}
        >
          <Search />
          Search
          <kbd className="ml-2 rounded border border-border bg-muted px-1.5 font-mono text-[0.7rem]">
            ⌘K
          </kbd>
        </Button>
        <UserButton appearance={clerkAppearance} />
      </div>
    </header>
  );
}
