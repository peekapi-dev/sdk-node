import { createHash } from "crypto";

/**
 * Hash sensitive auth values to a short, stable, non-reversible identifier.
 * Uses SHA-256 truncated to 12 hex chars — enough for grouping, not reversible.
 */
export function hashConsumerId(raw: string): string {
  return "hash_" + createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * Extract a safe consumer identifier from request headers.
 * - x-api-key: stored as-is (consumer's own key, not a secret to the org)
 * - Authorization Bearer: hashed (JWTs contain secrets)
 * - Authorization Basic: hashed (contains credentials)
 */
export function defaultIdentifyConsumer(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const apiKey = headers["x-api-key"];
  if (apiKey && typeof apiKey === "string") return apiKey;

  const auth = headers["authorization"];
  if (auth && typeof auth === "string") return hashConsumerId(auth);

  return undefined;
}
