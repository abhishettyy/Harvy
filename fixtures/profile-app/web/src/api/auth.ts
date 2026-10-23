import { apiRequest } from "./client.ts";

export async function login(email: string, password: string, fetchImpl?: typeof fetch) {
  const { token } = await apiRequest<{ token: string }>("/api/auth/login", {
    method: "POST",
    body: { email, password },
    fetchImpl,
  });
  return token;
}
