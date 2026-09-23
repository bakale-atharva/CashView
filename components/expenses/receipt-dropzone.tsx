"use client";

import { useMutation } from "convex/react";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { cn } from "@/lib/utils";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

/** Upload (or replace) an expense's receipt: drag-drop or click to browse. */
export function ReceiptDropzone({ expenseId }: { expenseId: Id<"expenses"> }) {
  const generateUploadUrl = useMutation(api.expenses.generateReceiptUploadUrl);
  const attachReceipt = useMutation(api.expenses.attachReceipt);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    try {
      const postUrl = await generateUploadUrl();
      const response = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed. Try again.");
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const result = await attachReceipt({ id: expenseId, storageId });
      if (!result.ok) {
        toast.error(result.reason);
      } else {
        toast.success("Receipt attached");
      }
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void upload(file);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-8 text-center transition-colors",
        dragging && "border-primary bg-muted/50",
        uploading && "pointer-events-none opacity-60",
      )}
    >
      <Upload className="size-5 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {uploading ? "Uploading…" : "Drag a receipt here, or click to browse"}
      </p>
      <p className="text-xs text-muted-foreground">JPG, PNG, WebP, HEIC or PDF, up to 10 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
