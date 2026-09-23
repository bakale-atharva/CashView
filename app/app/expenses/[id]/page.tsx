import { auth } from "@clerk/nextjs/server";
import type { Id } from "@/convex/_generated/dataModel";
import { ExpenseDetail } from "@/components/expenses/expense-detail";

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await auth.protect();
  const { id } = await params;
  return <ExpenseDetail expenseId={id as Id<"expenses">} />;
}
