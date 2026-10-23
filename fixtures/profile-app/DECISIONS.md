# Project decisions

- **Auth:** Use the existing JWT auth service in `server/auth/jwt.ts`. Do not introduce a new auth
  provider (Auth0, Clerk, sessions). All authenticated routes go through `requireAuth`.
- **Database:** SQLite via `node:sqlite`. No ORM.
- **API shape:** JSON only, errors as `{ "error": string }` with a matching HTTP status.
