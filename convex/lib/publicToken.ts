/**
 * The capability behind an invoice's public link: 256 bits from the platform's
 * secure random source, URL-safe base64 (43 characters). Anyone holding it can
 * view that one invoice, so it must be unguessable and is never derived from
 * anything else.
 */
export function mintPublicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Cheap shape check, so obviously bogus input never reaches the database. */
export function looksLikePublicToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}
