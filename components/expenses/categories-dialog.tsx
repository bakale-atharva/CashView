"use client";

import { useMutation, useQuery } from "convex/react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function CategoryRow({ id, name }: { id: Id<"expenseCategories">; name: string }) {
  const rename = useMutation(api.expenseCategories.rename);
  const remove = useMutation(api.expenseCategories.remove);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  if (editing) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          rename({ id, name: value })
            .then(() => setEditing(false))
            .catch((err) => toast.error(describeError(err)));
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="h-8" />
        <Button type="submit" size="sm">
          Save
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span>{name}</span>
      <div className="flex gap-1">
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(true)}>
          <Pencil />
          <span className="sr-only">Rename</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => remove({ id }).catch((err) => toast.error(describeError(err)))}
        >
          <Trash2 />
          <span className="sr-only">Delete</span>
        </Button>
      </div>
    </div>
  );
}

export function CategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const categories = useQuery(api.expenseCategories.list, {});
  const create = useMutation(api.expenseCategories.create);
  const [name, setName] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Expense categories</DialogTitle>
        </DialogHeader>
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {categories?.map((c) => (
            <CategoryRow key={c._id} id={c._id} name={c.name} />
          ))}
        </div>
        <form
          className="flex gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            create({ name })
              .then(() => setName(""))
              .catch((err) => toast.error(describeError(err)));
          }}
        >
          <Input
            placeholder="New category"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
          <Button type="submit" size="sm">
            <Plus />
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
