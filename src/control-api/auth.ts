import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { SESSION_COOKIE, readCookie, verifySession } from "./session.js";

export interface OwnerIdentity {
  authenticated: boolean;
  actorId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    owner?: OwnerIdentity;
  }
}

const CLOUDFLARE_ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

// ACCESS_AUTH_MODE=disabled is local-dev only (config.ts throws if it's
// still disabled at NODE_ENV=production). ACCESS_AUTH_MODE=cloudflare trusts
// Cloudflare Access to have already authenticated the request upstream and
// reads its standard identity header -- this server never performs a login
// flow itself, matching docs/architecture/adr-0003 ("backend authentication
// remains authoritative", not this app inventing its own).
// ACCESS_AUTH_MODE=password is the self-contained owner login: the app issues
// a signed session cookie at /api/v1/auth/login and this middleware checks it.
export function identifyOwner(config: AppConfig, sessionSecret?: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.accessAuthMode === "disabled") {
      req.owner = { authenticated: true, actorId: "local-owner" };
      next();
      return;
    }
    if (config.accessAuthMode === "password") {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      req.owner =
        sessionSecret !== undefined &&
        token !== undefined &&
        verifySession(sessionSecret, token, Date.now())
          ? { authenticated: true, actorId: "owner" }
          : { authenticated: false, actorId: "" };
      next();
      return;
    }
    const email = req.header(CLOUDFLARE_ACCESS_EMAIL_HEADER);
    req.owner =
      email !== undefined && email.trim().length > 0
        ? { authenticated: true, actorId: email.trim() }
        : { authenticated: false, actorId: "" };
    next();
  };
}

// Classic double-submit pattern: the token is handed to the browser only
// inside an authenticated, same-origin JSON response (commandPolicy.csrfToken
// in the dashboard snapshot); a cross-site attacker's page can't read that
// response body, so it can't learn the token even though the victim's own
// browser is authenticated. Matches src/operations/owner-commands.ts's
// existing OwnerCommandService.authorize() comparison exactly.
export function requireCsrf(secret: string) {
  const expected = Buffer.from(secret);
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.header("x-csrf-token") ?? "";
    const actual = Buffer.from(provided);
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      res.status(403).json({ error: "csrf token invalid" });
      return;
    }
    next();
  };
}

export function requireOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.owner?.authenticated !== true) {
    res.status(401).json({ error: "owner authentication required" });
    return;
  }
  next();
}
