import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./jwt.ts";

export type AuthedRequest = Request & { userId?: number };

export function requireAuth(secret: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const claims = token ? verifyToken(token, secret) : null;
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.userId = claims.sub;
    next();
  };
}
