# Harvy

> **Parallel Coding Agent Platform & Architecture Knowledge Graph Orchestrator**

Harvy is an intelligent multi-agent coding platform built into an enhanced fork of [T3 Code](https://github.com/pingdotgg/t3code). Harvy orchestrates parallel coding agents across independent git worktrees, synchronizes their work through a unified AST knowledge graph, coordinates contract handoffs with the Jev decision engine, and automatically verifies integrated code against approved test suites.

---

## Key Features

- **Parallel Agent Orchestration**: Divides features across specialized backend, frontend, and testing agents working concurrently in isolated worktrees without workspace pollution.
- **AST Knowledge Graph & Explorer**: Powered by [Graphify](https://github.com/Graphify-Labs/graphify), indexing codebases locally to visualize call chains, dependencies, and file relationships in an interactive graph and tree inspector.
- **Jev AI Decision Engine**: Intelligent task routing, API contract arbitration, architectural risk scoring, and automated failure triage with deterministic rule-based fallbacks.
- **Project Decision Governance**: Define global architecture and security constraints (e.g., JWT auth, database patterns) that are injected into every agent prompt and tracked across missions.
- **Conflict-Free Integration & Verification**: Merges parallel agent commits into a dedicated integration branch and runs test verification commands before touching your checkout.
- **Integrated Mission Control**: Access Harvy directly via the topbar header button, sidebar, or `Ctrl + K` command palette with a sleek, rounded dark-mode UI.

---

## Repository Layout

| Directory / File | Description |
|---|---|
| `t3code-main/t3code-main/` | Core Harvy workspace (server: `apps/server/src/goagent`, web UI: `apps/web/src/components/goagent`) |
| `graphify-8/graphify-8/` | Local Graphify engine source for AST codebase indexing |
| `fixtures/profile-app/` | Demo full-stack application (React, Express, SQLite, JWT, Vitest) for live mission evaluation |
| `scripts/setup-fixture.ps1` | PowerShell script to scaffold the demo fixture in an external repository |
| `GoAgent.md` | Architectural technical specification |
| `IMPLEMENTATION_PLAN.md` | Feature roadmap, milestone checklist, and verification records |

---

## Prerequisites

- **[Vite+](https://vite.plus)** (`vp`): Unified toolchain providing Node 26.12.1 and pnpm 12.14.0.
- **[uv](https://docs.astral.sh/uv/)**: Fast Python package manager for Graphify installation.
- **Agent CLI**: A supported agent runner (e.g., Claude Code or OpenCode).
- **Git**: Version 2.30+ with worktree support.

---

## Setup Guide

### 1. Toolchain Installation
```powershell
# Install Vite+
irm https://vite.plus/ps1 | iex

# Install Graphify locally via uv
uv tool install .\graphify-8\graphify-8
```

### 2. Harvy Dependencies
```powershell
cd t3code-main\t3code-main

# Install dependencies via Vite+
vp i

# Configure environment variables (optional: set TYPESAFE_API_KEY for Jev AI decisions)
copy .env.example .env

cd ..\..
```

### 3. Initialize Demo Fixture
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-fixture.ps1
```

---

## Running Harvy

Start the development server:

```powershell
cd t3code-main\t3code-main
vp run dev --home-dir D:\GoAgent\.t3-dev --no-seed
```

Once running, navigate to the local URL (e.g., `http://localhost:5734/`):

1. **Add Project**: Click **Add Project** in the sidebar or press `Ctrl + K` and select the demo fixture path (`D:\GoAgent-fixtures\profile-app`).
2. **Model Configuration**: Navigate to **Settings → Projects** and configure the default model.
3. **Launch Harvy**: Click the **Open Harvy** button in the top navigation bar.
4. **Index Repository**: In the **Knowledge Graph** tab, select **Index repository** to generate the dependency graph.
5. **Execute Mission**:
   - Enter your feature requirement (e.g., *"Add avatar image upload with thumbnail generation"*).
   - Click **Plan Mission** to let Harvy decompose the tasks.
   - Review and click **Approve Plan**, then **Start Agents**.
   - Monitor real-time agent threads, review contracts, and click **Integrate** & **Verify**.

---

## Running Tests

Harvy includes automated unit and integration tests across both the server and web applications:

```powershell
# Server test suite (GoAgent mission service, Jev decisions, planner, store)
cd t3code-main\t3code-main\apps\server
vp test run src/goagent

# Web UI test suite (Knowledge Explorer, layout, graph view)
cd ..\web
vp test run src/components/goagent
```

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
