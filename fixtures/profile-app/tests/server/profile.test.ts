import { afterEach, describe, expect, it } from "vitest";
import { loginAsDemo, startTestServer } from "./helpers.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe("GET /api/profile", () => {
  it("requires a token", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.baseUrl}/api/profile`);
    expect(res.status).toBe(401);
  });

  it("returns the current user's profile", async () => {
    const server = await startTestServer();
    close = server.close;
    const token = await loginAsDemo(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/api/profile`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "demo@example.com", displayName: "Demo User" });
  });
});
