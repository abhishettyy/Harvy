import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { authRouter } from "./routes/auth.ts";
import { profileRouter } from "./routes/profile.ts";

export function createApp(db: DatabaseSync, secret: string) {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter(db, secret));
  app.use("/api/profile", profileRouter(db, secret));
  return app;
}
