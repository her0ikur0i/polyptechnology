import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// Self-contained owner authentication for ACCESS_AUTH_MODE=password. No
// Cloudflare Access required: the app itself verifies a password and issues a
// stateless, HMAC-signed session cookie. The cookie is signed so the server
// needs no in-memory session table and a restart does not log the owner out.

export const SESSION_COOKIE = "polyp_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// scrypt is memory-hard, which is the right cost profile for a password that
// only one person types occasionally. `salt:hash`, both hex -- the salt is
// random per password so two identical passwords do not share a hash.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const separator = stored.indexOf(":");
  if (separator <= 0) return false;
  const salt = stored.slice(0, separator);
  const expected = Buffer.from(stored.slice(separator + 1), "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const candidate = scryptSync(password, salt, expected.length);
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

// A session token is `expiryBase36.hmacHex`. The HMAC binds the expiry to the
// secret, so a token cannot be extended by editing the expiry, and verify()
// compares the MAC with timingSafeEqual rather than string equality.
export function issueSession(secret: string, expiresAtMs: number): string {
  const expiry = expiresAtMs.toString(36);
  const mac = createHmac("sha256", secret)
    .update(`polyp-session:${expiry}`)
    .digest("hex");
  return `${expiry}.${mac}`;
}

export function verifySession(
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiry = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  const expiresAt = Number.parseInt(expiry, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowMs) return false;
  const expected = createHmac("sha256", secret)
    .update(`polyp-session:${expiry}`)
    .digest("hex");
  const provided = Buffer.from(mac, "hex");
  const wanted = Buffer.from(expected, "hex");
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

// Minimal cookie extraction for the one cookie this app sets. The session
// token is base36 + hex, so no percent-decoding is needed, and a hand-rolled
// reader avoids pulling in cookie-parser for a single value.
export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const pair = part.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}
