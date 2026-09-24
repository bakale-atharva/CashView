import { auth } from "@clerk/nextjs/server";
import { TeamPanel } from "@/components/settings/team-panel";

export default async function TeamSettingsPage() {
  await auth.protect();
  return <TeamPanel />;
}
