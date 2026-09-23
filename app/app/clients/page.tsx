import { auth } from "@clerk/nextjs/server";
import { ClientsView } from "@/components/clients/clients-view";

export default async function ClientsPage() {
  await auth.protect();
  return <ClientsView />;
}
