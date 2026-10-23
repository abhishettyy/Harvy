# GoAgent missions

GoAgent splits a feature across parallel coding agents that share one map of your code, records
every decision and handoff, and checks the combined result with commands you approve. Open
**GoAgent** from the sidebar or the command palette, then pick a project.

## Before you start

- The project must be a git repository with at least one commit. Agents work in their own
  worktrees from the current commit; uncommitted changes in your checkout are not included.
- Set a default model for the project in **Settings → Projects**. Every mission agent uses it.
- Install [Graphify](https://github.com/Graphify-Labs/graphify) on the server
  (`uv tool install graphifyy`) to build the knowledge graph. GoAgent indexes code locally with
  `--code-only`; no repository text is sent anywhere to build the graph. Set
  `GOAGENT_GRAPHIFY_PATH` if `graphify` is not on the server's `PATH`.
- Optional: set `TYPESAFE_API_KEY` on the server to let Jev make routing, risk, contract and
  failure-triage decisions. Without it, GoAgent uses fixed rules and labels every such decision
  as a fallback. `GOAGENT_JEV_MODEL` selects the model (default `jev-latest`) and
  `GOAGENT_JEV_ENABLED=false` turns Jev off. Jev receives short summaries, not your files.

## Run a mission

1. **Index repository** builds the knowledge graph. Click any edge in **Knowledge graph** to see
   the file and line it was read from. Dashed edges are inferred, not proven.
2. Describe the feature and choose **Plan mission**. GoAgent drafts tasks from the repository
   layout, and Jev (or the fallback rule) decides whether to split the work.
3. Edit the plan: what each agent owns, its brief, and whether a task waits for the API contract.
   **Approve plan**, then **Start agents**.
4. Each agent runs as a normal thread in its own worktree; **Open agent thread** shows it. An agent
   that waits for the contract starts only after the contract owner proposes it, and integration
   waits until it acknowledges the latest version.
5. When every agent finishes, choose **Integrate**. GoAgent applies their commits in a separate
   integration worktree and stops on conflicts; your checkout is never changed.
6. In **Verify**, approve the commands to run (suggested from `package.json`), then
   **Run verification**. A run passes only when the command exits with code 0.

**Audit** lists every event in order; select one to see what caused it and what it caused.
Worktrees are kept after a mission ends so you can review or merge them yourself.
