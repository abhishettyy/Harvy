import { afterEach, describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../../server/auth/jwt.ts";
import { startTestServer } from "./helpers.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe("jwt", () => {
  it("round-trips a token", () => {
    const token = signToken(7, "s");
    expect(verifyToken(token, "s")?.sub).toBe(7);
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyToken(signToken(7, "a"), "b")).toBeNull();
  });
});

describe("POST /api/auth/login", () => {
  it("rejects bad credentials", async () => {
    const server = await startTestServer();
    close = server.close;
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "demo@example.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});
