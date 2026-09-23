import { auth } from "@clerk/nextjs/server";
import { ReportsView } from "@/components/reports/reports-view";

export default async function ReportsPage() {
  await auth.protect();
  return <ReportsView />;
}
