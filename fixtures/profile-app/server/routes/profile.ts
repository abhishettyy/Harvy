import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "../db.ts";
import { requireAuth, type AuthedRequest } from "../auth/middleware.ts";

export function profileRouter(db: DatabaseSync, secret: string): Router {
  const router = Router();
  router.get("/", requireAuth(secret), (req: AuthedRequest, res) => {
    const user = findUserById(db, req.userId!);
    if (!user) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(user);
  });
  return router;
}
