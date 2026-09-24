import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/convex-error";

/**
 * A form's submit state. `run` flags it as submitting while `action` runs and
 * shows any thrown error as a toast; success handling stays in `action`.
 */
export function useSubmit() {
  const [submitting, setSubmitting] = useState(false);

  async function run(action: () => Promise<void>) {
    setSubmitting(true);
    try {
      await action();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, run };
}
