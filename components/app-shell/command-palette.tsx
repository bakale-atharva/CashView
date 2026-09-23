"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "@/convex/_generated/api";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useEntitlements } from "@/lib/use-entitlements";
import { primaryNavItems, visibleNavItems, workspaceNavItems } from "./nav-items";

type CommandPaletteContextValue = {
  open: () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  }
  return ctx;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.me.getCurrentScope, isAuthenticated ? {} : "skip");

  const open = useCallback(() => setIsOpen(true), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const entitlements = useEntitlements();

  const navItems = useMemo(
    () =>
      visibleNavItems(
        [...primaryNavItems, ...workspaceNavItems],
        me?.capabilities,
        entitlements?.features,
      ),
    [me, entitlements],
  );

  const runNavigate = useCallback(
    (href: string) => {
      setIsOpen(false);
      router.push(href);
    },
    [router],
  );

  const value = useMemo(() => ({ open }), [open]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandDialog open={isOpen} onOpenChange={setIsOpen}>
        <CommandInput placeholder="Jump to…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {navItems.map((item) => (
              <CommandItem key={item.href} onSelect={() => runNavigate(item.href)}>
                <item.icon />
                <span>{item.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </CommandPaletteContext.Provider>
  );
}
