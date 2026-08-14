import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_COOKIE,
  hashPassword,
  issueSession,
  readCookie,
  verifyPassword,
  verifySession,
} from "../src/control-api/session.js";

test("password hashing round-trips and rejects wrong passwords", () => {
  const stored = hashPassword("correct-horse-battery");
  assert.ok(stored.includes(":"));
  assert.equal(verifyPassword("correct-horse-battery", stored), true);
  assert.equal(verifyPassword("wrong-password", stored), false);
  assert.equal(verifyPassword("", stored), false);
  // Two hashes of the same password differ (random salt) but both verify.
  const again = hashPassword("correct-horse-battery");
  assert.notEqual(again, stored);
  assert.equal(verifyPassword("correct-horse-battery", again), true);
});

test("session token verifies while unexpired and is rejected after expiry", () => {
  const secret = "session-secret";
  const now = 1_000_000_000_000;
  const token = issueSession(secret, now + 3_600_000);
  assert.equal(verifySession(secret, token, now), true);
  assert.equal(verifySession(secret, token, now + 3_600_001), false);
});

test("a forged or tampered session token does not verify", () => {
  const secret = "session-secret";
  const token = issueSession(secret, 2_000_000_000_000);
  const [expiry, mac] = token.split(".");
  // Tampering with the MAC must fail, even if the expiry is kept valid.
  const tampered = `${expiry}.${"0".repeat(mac!.length)}`;
  assert.equal(verifySession(secret, tampered, 1_000_000_000_000), false);
  // A different secret must not accept the token.
  assert.equal(verifySession("other-secret", token, 1_000_000_000_000), false);
});

test("readCookie extracts the named cookie and ignores others", () => {
  const header = "other=1; polyp_session=abc.def; tail=2";
  assert.equal(readCookie(header, SESSION_COOKIE), "abc.def");
  assert.equal(readCookie(header, "missing"), undefined);
  assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
});
