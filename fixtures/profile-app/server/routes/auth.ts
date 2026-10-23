import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { findUserByEmail } from "../db.ts";
import { signToken } from "../auth/jwt.ts";
import { verifyPassword } from "../auth/password.ts";

export function authRouter(db: DatabaseSync, secret: string): Router {
  const router = Router();
  router.post("/login", (req, res) => {
    const { email, password } = req.body ?? {};
    const user = typeof email === "string" ? findUserByEmail(db, email) : undefined;
    if (!user || typeof password !== "string" || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    res.json({ token: signToken(user.id, secret) });
  });
  return router;
}
