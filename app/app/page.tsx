import { auth } from "@clerk/nextjs/server";
import { LogoMark } from "@/components/brand/logo";

// The real dashboard (revenue, outstanding vs collected, cash flow, expense
// breakdown, recent activity) is Phase F2. This confirms the shell, the
// scope switch, and role-aware nav are wired end to end.
export default async function AppHome() {
  await auth.protect();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <LogoMark className="size-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">
          The books are open
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          The dashboard — revenue, outstanding vs. collected, cash flow —
          lands in the next phase.
        </p>
      </div>
    </div>
  );
}
