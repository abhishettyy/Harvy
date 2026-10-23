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

## Project decisions

Rules every mission agent must follow, such as "use the existing JWT auth service". Add them in the
left panel, or choose **Import DECISIONS.md** to turn each bullet of that file into a decision
labelled *seeded*. Active decisions are added to every agent's instructions, can be read by agents
with the `goagent_project_decisions` tool, and appear in **Knowledge graph** as decision nodes
linked to the files they name. Retire a decision to stop sending it.

## Run a mission

1. **Index repository** builds the knowledge graph. Click any edge in **Knowledge graph** to see
   the file and line it was read from. Dashed edges are inferred, not proven.
2. Describe the feature and choose **Plan mission**. GoAgent drafts tasks from the repository
   layout, and Jev (or the fallback rule) decides whether to split the work.
3. Edit the plan: what each agent owns, its brief, and whether a task waits for the API contract.
   **Approve plan**, then **Start agents**. If Jev rates the plan high risk, the plan is held for
   review and starts only after you choose **Approve despite high risk**.
4. Each agent runs as a normal thread in its own worktree; **Open agent thread** shows it. An agent
   that waits for the contract starts only after the contract owner proposes it, and integration
   waits until it acknowledges the latest version.
5. When every agent finishes, choose **Integrate**. GoAgent applies their commits in a separate
   integration worktree and stops on conflicts; your checkout is never changed.
6. In **Verify**, approve the commands to run (suggested from `package.json`), then
   **Run verification**. A run passes only when the command exits with code 0.
7. If verification fails, Jev (or a fallback rule) names the agent whose code most likely caused
   it. **Send repair to …** gives that agent the failing output and the contract. When it finishes,
   GoAgent integrates and verifies again by itself. Each mission gets one repair round.

## Three agents and coordination

In a repository with client, server and test code, GoAgent plans three agents: **backend** (owns the
server code and proposes the API contract), **frontend** and **tests** (both start as soon as the
contract exists). The plan records how the agents' code is linked in the knowledge graph, for
example `tests uses backend (3 graph links)`.

While they run, Jev makes the small coordination calls, each with a labelled fallback rule:

- **handoff.notify**: when an agent finishes, every other agent whose code uses the changed files
  (following the graph, up to three files away) is a candidate; Jev decides whether to switch to
  that agent now with a summary of the change.
- **handoff.route**: an agent can call `goagent_handoff` with a note; Jev picks which agent receives
  it, or nobody.

Each mission has a budget of handoffs and of Jev calls; after that the fallback rules decide.

**Agent decisions** shows one window per agent: the design decisions it recorded with
`goagent_record_decision`, the Jev coordination decisions about it, handoffs in and out, and its
knowledge-graph lookups.

**Audit** lists every event in order; select one to see what caused it and what it caused. Agent
graph lookups are recorded there too. If Jev doubts that an agent's contract acknowledgment
matches the contract, integration waits until you accept it by overriding that `contract.match`
decision. Integration uses each agent worktree's latest commit, so changes you commit there by
hand (for example after a conflict) are included.
Worktrees are kept after a mission ends so you can review or merge them yourself.
