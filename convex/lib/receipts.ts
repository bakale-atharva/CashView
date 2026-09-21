/** What a receipt may be. Anything else is rejected and deleted. */
export const RECEIPT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/**
 * Why an uploaded file cannot be a receipt, or null if it can. Reads the
 * file's metadata from the `_storage` system table, which the client cannot
 * forge. Returns a reason rather than throwing so the caller can delete the
 * file and still return normally (a thrown error would roll the delete back).
 */
export function receiptProblem(meta: { contentType?: string; size: number }): string | null {
  const type = meta.contentType?.toLowerCase().split(";")[0].trim();
  if (!type || !(RECEIPT_TYPES as readonly string[]).includes(type)) {
    return "Upload a JPG, PNG, WebP, HEIC or PDF file.";
  }
  if (meta.size <= 0 || meta.size > MAX_RECEIPT_BYTES) {
    return "The file must be 10 MB or smaller.";
  }
  return null;
}
