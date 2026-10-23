import type { GoAgentGraphEdge, GoAgentGraphNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateEdges,
  buildExplorerModel,
  decisionsFor,
  focusOf,
  layoutExplorer,
  revealIds,
  searchTree,
  visibleRepresentative,
  type ExplorerFilters,
} from "./explorerModel";

// Shapes as Graphify emits them for the profile-app fixture (labels, kinds, source files).
const n = (
  id: string,
  kind: GoAgentGraphNode["kind"],
  label: string,
  sourceFile: string | null,
): GoAgentGraphNode => ({ id, label, kind, sourceFile, sourceLocation: "L1", community: 0 });
const e = (source: string, target: string, relation: string): GoAgentGraphEdge => ({
  source,
  target,
  relation,
  evidence: relation === "governs" ? "explicit_human" : "verified_static",
  confidenceScore: 1,
  sourceFile: null,
  sourceLocation: "L2",
});

const nodes = [
  n("f_app", "file", "app.ts", "server/app.ts"),
  n("f_profile", "file", "profile.ts", "server/routes/profile.ts"),
  n("f_client", "file", "client.ts", "web/src/api/client.ts"),
  n("f_test", "file", "profile.test.ts", "tests/server/profile.test.ts"),
  n("s_create", "symbol", "createApp()", "server/app.ts"),
  n("s_router", "symbol", "profileRouter()", "server/routes/profile.ts"),
  n("s_error", "symbol", "ApiError", "web/src/api/client.ts"),
  n("s_ctor", "symbol", ".constructor()", "web/src/api/client.ts"),
  n("s_request", "symbol", "apiRequest()", "web/src/api/client.ts"),
  n("why", "rationale", "Tokens are verified on every request", "server/app.ts"),
  n("pkg", "concept", "express", null),
  n("decision:d1", "decision", "Use the JWT auth in server/app.ts", "DECISIONS.md"),
];
const edges = [
  e("f_app", "s_create", "contains"),
  e("f_profile", "s_router", "contains"),
  e("f_client", "s_error", "contains"),
  e("s_error", "s_ctor", "method"),
  e("f_app", "f_profile", "imports_from"),
  e("s_create", "s_router", "calls"),
  e("f_test", "f_app", "imports"),
  e("s_request", "s_error", "calls"),
  e("decision:d1", "f_app", "governs"),
  e("f_app", "pkg", "imports_from"),
];
const none: ExplorerFilters = { hiddenKinds: new Set(), hiddenRelations: new Set() };
const model = buildExplorerModel(nodes, edges);

describe("buildExplorerModel", () => {
  it("builds directories from paths, compacting single-child folder chains", () => {
    const root = model.nodes.get("root")!;
    const names = root.childIds.map((id) => model.nodes.get(id)!.name);
    expect(names).toEqual([
      "Use the JWT auth in server/app.ts",
      "server",
      "tests/server",
      "web/src/api",
      "External packages",
    ]);
    expect(model.nodes.get("dir:server")!.fileCount).toBe(2);
  });

  it("classifies Graphify symbols and nests methods under their class", () => {
    expect(model.nodes.get("s_create")!.kind).toBe("function");
    expect(model.nodes.get("s_error")!.kind).toBe("class");
    const ctor = model.nodes.get("s_ctor")!;
    expect([ctor.kind, ctor.name, ctor.parentId]).toEqual(["method", "constructor()", "s_error"]);
    expect(model.nodes.get("why")!.parentId).toBe("f_app");
  });
});

describe("progressive disclosure", () => {
  it("draws collapsed content as its nearest visible container", () => {
    expect(visibleRepresentative(model, "s_router", new Set(), none)).toBe("dir:server");
    const open = new Set(["dir:server", "dir:server/routes"]);
    expect(visibleRepresentative(model, "s_router", open, none)).toBe("f_profile");
    expect(revealIds(model, "s_ctor")).toEqual(["root", "dir:web", "f_client", "s_error"]);
  });

  it("lifts links to visible nodes and never draws hierarchy as lines", () => {
    const top = aggregateEdges(model, new Set(), none);
    expect(top.map((edge) => edge.id).toSorted()).toEqual([
      "decision:d1->dir:server:governs",
      "dir:server->dir:@packages:imports",
      "dir:tests->dir:server:imports",
    ]);
    // Inside an open directory, a link between its own files shows; contains/method never do.
    const open = aggregateEdges(model, new Set(["dir:server", "dir:server/routes"]), none);
    expect(open.some((edge) => edge.id === "f_app->f_profile:imports")).toBe(true);
    expect(open.some((edge) => edge.group === "other")).toBe(false);
  });

  it("respects relation and kind filters", () => {
    const filtered = aggregateEdges(model, new Set(), {
      hiddenKinds: new Set(["package", "decision"]),
      hiddenRelations: new Set(),
    });
    expect(filtered.map((edge) => edge.id)).toEqual(["dir:tests->dir:server:imports"]);
  });
});

describe("layoutExplorer", () => {
  it("puts users left of what they use and keeps children inside their open container", () => {
    const expanded = new Set(["dir:server"]);
    const edgesNow = aggregateEdges(model, expanded, none);
    const placed = layoutExplorer(model, expanded, none, edgesNow);
    const at = new Map(placed.map((p) => [p.id, p]));
    expect(at.get("dir:tests")!.x).toBeLessThan(at.get("dir:server")!.x);
    const frame = at.get("dir:server")!;
    expect(frame.expanded).toBe(true);
    for (const id of ["f_app", "dir:server/routes"]) {
      const child = at.get(id)!;
      expect(child.x).toBeGreaterThanOrEqual(frame.x);
      expect(child.y).toBeGreaterThan(frame.y);
      expect(child.x + child.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(child.y + child.height).toBeLessThanOrEqual(frame.y + frame.height);
    }
    // No two top-level boxes overlap.
    const top = placed.filter((p) => model.nodes.get(p.id)!.parentId === "root");
    for (const a of top)
      for (const b of top) {
        if (a === b) continue;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
  });
});

describe("queries", () => {
  it("finds the decisions that apply to a node through its containers", () => {
    expect(decisionsFor(model, "s_create").map((d) => d.id)).toEqual(["decision:d1"]);
    expect(decisionsFor(model, "s_router")).toEqual([]);
  });

  it("searches files and symbols, best prefix matches first", () => {
    expect(searchTree(model, "api").map((hit) => hit.name)).toEqual([
      "ApiError",
      "apiRequest()",
      "client.ts",
    ]);
    expect(searchTree(model, "   ")).toEqual([]);
  });

  it("separates incoming and outgoing links for highlighting", () => {
    const edgesNow = aggregateEdges(model, new Set(), none);
    const focus = focusOf(edgesNow, "dir:server");
    expect([...focus.incoming].toSorted()).toEqual([
      "decision:d1->dir:server:governs",
      "dir:tests->dir:server:imports",
    ]);
    expect([...focus.outgoing]).toEqual(["dir:server->dir:@packages:imports"]);
  });
});
