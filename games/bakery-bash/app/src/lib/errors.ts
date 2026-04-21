import type { FunctionsError } from "firebase/functions";

/**
 * Extract a user-facing message from a Firebase callable error, falling
 * back to `fallback` if the error has no readable message. Checks for
 * either `code` or `message` so it accepts both `FunctionsError` (which
 * always has both) and plain `Error`-shaped rejections.
 */
export function humanizeFunctionError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && ("code" in err || "message" in err)) {
    const fnErr = err as FunctionsError;
    if (fnErr.message) return fnErr.message;
  }
  return fallback;
}
