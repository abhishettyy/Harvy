import { describe, expect, it, vi } from "vitest";
import { getProfile } from "../../web/src/api/profile.ts";
import { ApiError } from "../../web/src/api/client.ts";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getProfile", () => {
  it("sends the bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 1 }));
    await getProfile("abc", fetchImpl as typeof fetch);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer abc");
  });

  it("throws ApiError on failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));
    await expect(getProfile("x", fetchImpl as typeof fetch)).rejects.toBeInstanceOf(ApiError);
  });
});
