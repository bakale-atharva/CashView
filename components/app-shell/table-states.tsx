import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

const KEYS = "abcdefghij".split("");

/** Placeholder rows while a table's first page loads. */
export function SkeletonRows({ count, colSpan }: { count: number; colSpan: number }) {
  return KEYS.slice(0, count).map((key) => (
    <TableRow key={key}>
      <TableCell colSpan={colSpan}>
        <Skeleton className="h-6 w-full" />
      </TableCell>
    </TableRow>
  ));
}

/** The single row a table shows when it has nothing to list. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** Shown under a paginated table while more pages remain. */
export function LoadMoreButton({ status, onLoadMore }: { status: string; onLoadMore: () => void }) {
  if (status !== "CanLoadMore") return null;
  return (
    <Button variant="outline" onClick={onLoadMore} className="self-center">
      Load more
    </Button>
  );
}
