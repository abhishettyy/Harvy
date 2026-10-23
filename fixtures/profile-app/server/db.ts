import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./auth/password.ts";

export type User = {
  id: number;
  email: string;
  displayName: string;
  bio: string;
};

type UserRow = {
  id: number;
  email: string;
  display_name: string;
  bio: string;
  password_hash: string;
};

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL
    )
  `);
  return db;
}

export function seedDemoUser(db: DatabaseSync): User {
  const existing = findUserByEmail(db, "demo@example.com");
  if (existing) return toUser(existing);
  db.prepare(
    "INSERT INTO users (email, display_name, bio, password_hash) VALUES (?, ?, ?, ?)",
  ).run("demo@example.com", "Demo User", "Hello!", hashPassword("demo-password"));
  return toUser(findUserByEmail(db, "demo@example.com")!);
}

export function findUserByEmail(db: DatabaseSync, email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export function findUserById(db: DatabaseSync, id: number): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name, bio: row.bio };
}
