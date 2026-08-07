import { createHash, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseApprovalToken(value: string): string | undefined {
  return TOKEN_PATTERN.test(value) ? value : undefined;
}
