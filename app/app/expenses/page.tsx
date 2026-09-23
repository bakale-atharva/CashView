import { auth } from "@clerk/nextjs/server";
import { ExpensesView } from "@/components/expenses/expenses-view";

export default async function ExpensesPage() {
  await auth.protect();
  return <ExpensesView />;
}
