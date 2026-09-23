import { auth } from "@clerk/nextjs/server";
import type { Id } from "@/convex/_generated/dataModel";
import { ClientDetail } from "@/components/clients/client-detail";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await auth.protect();
  const { id } = await params;
  return <ClientDetail clientId={id as Id<"clients">} />;
}
