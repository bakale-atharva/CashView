"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { Paperclip, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CategoriesDialog } from "./categories-dialog";
import { ExpenseFormDialog } from "./expense-form-dialog";

const PAGE_SIZE = 25;

export function ExpensesView() {
  const [categoryId, setCategoryId] = useState<Id<"expenseCategories"> | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const categories = useQuery(api.expenseCategories.list, {});

  const { results, status, loadMore } = usePaginatedQuery(
    api.expenses.list,
    { categoryId },
    { initialNumItems: PAGE_SIZE },
  );
  const loading = status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
            Categories
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            New expense
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={categoryId ?? "all"}
          onValueChange={(value) => setCategoryId(value === "all" ? undefined : (value as Id<"expenseCategories">))}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories?.map((c) => (
              <SelectItem key={c._id} value={c._id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              ["a", "b", "c", "d", "e"].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!loading && results.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  {categoryId ? "No expenses in this category." : "No expenses yet."}
                </TableCell>
              </TableRow>
            )}
            {results.map((expense) => (
              <TableRow key={expense._id}>
                <TableCell>
                  <Link href={`/app/expenses/${expense._id}`} className="font-medium hover:underline">
                    {expense.vendor}
                  </Link>
                  {expense.isBillable && (
                    <span className="ml-2 text-xs text-muted-foreground">Billable</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {expense.categoryName ?? "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(expense.spentAt)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {expense.clientName ?? "—"}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(expense.amountCents, expense.currency)}
                </TableCell>
                <TableCell>
                  {expense.hasReceipt && <Paperclip className="size-3.5 text-muted-foreground" />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {status === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)} className="self-center">
          Load more
        </Button>
      )}

      <ExpenseFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CategoriesDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} />
    </div>
  );
}
