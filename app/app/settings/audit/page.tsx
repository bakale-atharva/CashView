import { auth } from "@clerk/nextjs/server";
import { AuditLogViewer } from "@/components/settings/audit-log-viewer";

export default async function AuditSettingsPage() {
  await auth.protect();
  return <AuditLogViewer />;
}
