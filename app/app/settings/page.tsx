import { auth } from "@clerk/nextjs/server";
import { SettingsOverview } from "@/components/settings/settings-overview";

export default async function SettingsPage() {
  await auth.protect();

  return <SettingsOverview />;
}
