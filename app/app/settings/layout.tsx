import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          For the workspace that&rsquo;s open now. Switch workspaces from the top bar.
        </p>
      </header>
      <SettingsNav />
      {children}
    </div>
  );
}
