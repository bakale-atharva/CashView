import { auth } from "@clerk/nextjs/server";
import { BillingPanel } from "@/components/settings/billing-panel";

export default async function BillingPage() {
  await auth.protect();

  return <BillingPanel />;
}
