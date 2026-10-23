import { createHmac, timingSafeEqual } from "node:crypto";

// WHY: the project deliberately keeps a small in-house HS256 JWT service instead of an external
// auth provider. See DECISIONS.md.

export type TokenClaims = { sub: number; exp: number };

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function signToken(userId: number, secret: string, ttlSeconds = 3600): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims: TokenClaims = { sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as TokenClaims;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
