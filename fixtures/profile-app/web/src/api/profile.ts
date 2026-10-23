import { apiRequest } from "./client.ts";

export type Profile = { id: number; email: string; displayName: string; bio: string };

export function getProfile(token: string, fetchImpl?: typeof fetch) {
  return apiRequest<Profile>("/api/profile", { token, fetchImpl });
}
