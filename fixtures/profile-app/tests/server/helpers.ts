import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../../server/app.ts";
import { openDatabase, seedDemoUser } from "../../server/db.ts";

export const TEST_SECRET = "test-secret";

export async function startTestServer() {
  const db = openDatabase();
  const user = seedDemoUser(db);
  const server: Server = await new Promise((resolve) => {
    const s = createApp(db, TEST_SECRET).listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    db,
    user,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function loginAsDemo(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@example.com", password: "demo-password" }),
  });
  return ((await res.json()) as { token: string }).token;
}
