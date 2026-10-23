# GoAgent

GoAgent splits a feature across parallel coding agents that share one knowledge graph of the
codebase, records every decision and handoff, and verifies the combined result with commands you
approve. It is built into a fork of [T3 Code](https://github.com/pingdotgg/t3code).

- Spec: [GoAgent.md](GoAgent.md)
- Build plan and progress: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- User guide: [t3code-main/t3code-main/docs/user/goagent.md](t3code-main/t3code-main/docs/user/goagent.md)

## Layout

| Path | What it is |
|---|---|
| `t3code-main/t3code-main/` | T3 Code fork with GoAgent (server: `apps/server/src/goagent`, UI: `apps/web/src/components/goagent`) |
| `graphify-8/graphify-8/` | Graphify source, installed locally to build the knowledge graph |
| `fixtures/profile-app/` | Demo app (React + Express + SQLite, JWT login, Vitest) that missions run against |
| `scripts/setup-fixture.ps1` | Copies the fixture out to its own git repo |

## Requirements

- [Vite+](https://vite.plus) (`vp`), which provides Node 26.12.1 and pnpm 12.14.0
- [uv](https://docs.astral.sh/uv/) for installing Graphify
- A coding-agent CLI that T3 Code supports (Claude Code or OpenCode)

## Setup (Windows, PowerShell)

```powershell
# 1. Toolchain
irm https://vite.plus/ps1 | iex
uv tool install .\graphify-8\graphify-8

# 2. T3 Code + GoAgent dependencies
cd t3code-main\t3code-main
vp i
copy .env.example .env    # optional: set TYPESAFE_API_KEY to enable Jev decisions
cd ..\..

# 3. Demo project: a standalone git repo outside this one
powershell -ExecutionPolicy Bypass -File scripts\setup-fixture.ps1
```

## Run

```powershell
cd t3code-main\t3code-main
vp run dev --home-dir D:\GoAgent\.t3-dev --no-seed
```

Open the web URL it prints, then:

1. **Add project** (sidebar or Ctrl+K) → `D:\GoAgent-fixtures\profile-app`.
2. **Settings → Projects** → set a default model for it.
3. Open **GoAgent** → pick the project → **Index repository** → **Knowledge graph** tab.
4. Describe a feature → **Plan mission** → **Approve plan** → **Start agents** → **Integrate** → **Verify**.

## Tests

```powershell
cd t3code-main\t3code-main\apps\server
vp test run src/goagent
cd ..\web
vp test run src/components/goagent
```
