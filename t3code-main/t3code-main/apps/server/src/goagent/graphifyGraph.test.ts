import { describe, expect, it } from "@effect/vitest";

import { diffGraphs, neighbourhood, parseGraphifyGraph, searchNodes } from "./graphifyGraph.ts";

// Trimmed from a real `graphify extract --code-only` run on fixtures/profile-app.
const sample = {
  directed: false,
  multigraph: false,
  graph: { schema_version: 1, graphify_version: "0.9.93" },
  nodes: [
    {
      id: "server_app",
      label: "app.ts",
      file_type: "code",
      source_file: "server/app.ts",
      source_location: "L1",
      community: 3,
    },
    {
      id: "server_app_createapp",
      label: "createApp()",
      file_type: "code",
      source_file: "server/app.ts",
      source_location: "L6",
      community: 3,
    },
    {
      id: "server_routes_profile",
      label: "profile.ts",
      file_type: "code",
      source_file: "server/routes/profile.ts",
      source_location: "L1",
      community: 1,
    },
    {
      id: "server_routes_profile_profilerouter",
      label: "profileRouter()",
      file_type: "code",
      source_file: "server/routes/profile.ts",
      source_location: "L6",
      community: 1,
    },
    {
      id: "web_src_api_profile",
      label: "api/profile.ts",
      file_type: "code",
      source_file: "web/src/api/profile.ts",
      source_location: "L1",
      community: 0,
    },
    {
      id: "server_auth_jwt_rationale_3",
      label: "WHY: keep in-house JWT\u0007",
      file_type: "rationale",
      source_file: "server/auth/jwt.ts",
      source_location: "L3",
      community: 3,
    },
    {
      id: "ref_express",
      label: "express",
      file_type: "concept",
      source_file: "package.json",
      source_location: "L12",
      community: 3,
    },
  ],
  links: [
    {
      source: "server_app",
      target: "server_routes_profile_profilerouter",
      relation: "imports",
      confidence: "EXTRACTED",
      confidence_score: 1,
      source_file: "server/app.ts",
      source_location: "L4",
    },
    {
      source: "server_app_createapp",
      target: "server_routes_profile_profilerouter",
      relation: "calls",
      confidence: "EXTRACTED",
      confidence_score: 1,
      source_file: "server/app.ts",
      source_location: "L10",
    },
    {
      source: "server_routes_profile",
      target: "server_routes_profile_profilerouter",
      relation: "contains",
      confidence: "EXTRACTED",
      confidence_score: 1,
    },
    // Arc order says web -> server, but the canonicalized markers say the reverse and win.
    {
      source: "web_src_api_profile",
      target: "server_routes_profile",
      relation: "calls",
      confidence: "INFERRED",
      confidence_score: 0.75,
      _src: "server_routes_profile",
      _tgt: "web_src_api_profile",
    },
    { source: "server_app", target: "missing_node", relation: "imports", confidence: "EXTRACTED" },
    {
      source: "server_app",
      target: "ref_express",
      relation: "imports",
      confidence: "AMBIGUOUS",
      confidence_score: 0.2,
    },
  ],
};

const parse = () => {
  const result = parseGraphifyGraph(sample);
  if (!result.ok) throw new Error(result.detail);
  return result.graph;
};

describe("parseGraphifyGraph", () => {
  it("maps node kinds from Graphify file types and file labels", () => {
    const kinds = Object.fromEntries(parse().nodes.map((node) => [node.id, node.kind]));
    expect(kinds).toEqual({
      server_app: "file",
      server_app_createapp: "symbol",
      server_routes_profile: "file",
      server_routes_profile_profilerouter: "symbol",
      web_src_api_profile: "file",
      server_auth_jwt_rationale_3: "rationale",
      ref_express: "concept",
    });
  });

  it("maps confidence to evidence and drops edges to unknown nodes", () => {
    const graph = parse();
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges.map((edge) => edge.evidence)).toEqual([
      "verified_static",
      "verified_static",
      "verified_static",
      "inferred",
      "ambiguous",
    ]);
  });

  it("honours _src/_tgt direction markers", () => {
    const inferred = parse().edges.find((edge) => edge.evidence === "inferred");
    expect(inferred).toMatchObject({
      source: "server_routes_profile",
      target: "web_src_api_profile",
    });
  });

  it("strips control characters from labels", () => {
    const rationale = parse().nodes.find((node) => node.kind === "rationale");
    expect(rationale?.label).toBe("WHY: keep in-house JWT");
  });

  it("rejects unsupported schema versions", () => {
    const result = parseGraphifyGraph({ ...sample, graph: { schema_version: 99 } });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_schema" });
  });

  it("rejects malformed input", () => {
    expect(parseGraphifyGraph([])).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseGraphifyGraph({ graph: { schema_version: 1 } })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("diffGraphs", () => {
  it("reports added and removed nodes and directed edges", () => {
    const base = parse();
    const next = {
      nodes: [
        ...base.nodes.filter((node) => node.id !== "ref_express"),
        {
          id: "server_routes_profile_patch",
          label: "updateProfile()",
          kind: "symbol" as const,
          sourceFile: "server/routes/profile.ts",
          sourceLocation: "L20",
          community: 1,
        },
      ],
      edges: [
        ...base.edges.filter((edge) => edge.target !== "ref_express"),
        {
          source: "server_routes_profile",
          target: "server_routes_profile_patch",
          relation: "contains",
          evidence: "verified_static" as const,
          confidenceScore: 1,
          sourceFile: null,
          sourceLocation: null,
        },
      ],
    };
    const diff = diffGraphs(base, next);
    expect(diff.addedNodes.map((node) => node.id)).toEqual(["server_routes_profile_patch"]);
    expect(diff.removedNodes.map((node) => node.id)).toEqual(["ref_express"]);
    expect(diff.addedEdges.map((edge) => edge.target)).toEqual(["server_routes_profile_patch"]);
    expect(diff.removedEdges.map((edge) => edge.target)).toEqual(["ref_express"]);
  });

  it("is empty for identical graphs", () => {
    const graph = parse();
    const diff = diffGraphs(graph, graph);
    expect([diff.addedNodes, diff.removedNodes, diff.addedEdges, diff.removedEdges]).toEqual([
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("neighbourhood", () => {
  it("expands by hop count ignoring direction and respects the cap", () => {
    const graph = parse();
    const oneHop = neighbourhood(graph, ["server_routes_profile"], { hops: 1, maxNodes: 50 });
    expect(new Set(oneHop.nodes.map((node) => node.id))).toEqual(
      new Set([
        "server_routes_profile",
        "server_routes_profile_profilerouter",
        "web_src_api_profile",
      ]),
    );
    const capped = neighbourhood(graph, ["server_routes_profile"], { hops: 3, maxNodes: 2 });
    expect(capped.nodes).toHaveLength(2);
    expect(capped.nodes[0]?.id).toBe("server_routes_profile");
  });
});

describe("searchNodes", () => {
  it("ranks exact label matches first and files ahead of symbols", () => {
    const results = searchNodes(parse().nodes, "profile", 10).map((node) => node.id);
    expect(results.slice(0, 2)).toEqual(["server_routes_profile", "web_src_api_profile"]);
  });
});
