import { auth } from "@clerk/nextjs/server";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export default async function AppHome() {
  await auth.protect();

  return <DashboardView />;
}
