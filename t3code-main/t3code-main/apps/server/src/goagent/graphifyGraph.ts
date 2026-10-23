import type {
  GoAgentEvidence,
  GoAgentGraphEdge,
  GoAgentGraphNode,
  GoAgentGraphNodeKind,
} from "@t3tools/contracts";

/** `graph.json` schema versions this parser understands. */
const SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

export interface ParsedGraph {
  readonly graphifyVersion: string | null;
  readonly schemaVersion: number;
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
}

export type ParseGraphResult =
  | { readonly ok: true; readonly graph: ParsedGraph }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unsupported_schema";
      readonly detail: string;
    };

const MAX_LABEL_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// Graphify labels come from source text; drop control characters so they render as plain text.
const sanitizeLabel = (label: string) =>
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  label.replace(/[\u0000-\u001f\u007f�]/g, "").slice(0, MAX_LABEL_LENGTH);

const evidenceOf = (confidence: unknown): GoAgentEvidence => {
  switch (confidence) {
    case "EXTRACTED":
      return "verified_static";
    case "INFERRED":
      return "inferred";
    default:
      return "ambiguous";
  }
};

const kindOf = (node: Record<string, unknown>, label: string): GoAgentGraphNodeKind => {
  const fileType = node["file_type"];
  if (fileType === "rationale") return "rationale";
  if (fileType === "concept") return "concept";
  const sourceFile = str(node["source_file"]);
  // Graphify labels a file node with the file's (possibly disambiguated) path suffix.
  if (sourceFile !== null && label.includes(".") && sourceFile.endsWith(label)) return "file";
  return "symbol";
};

/**
 * Converts Graphify's node-link `graph.json` into GoAgent rows. Edge direction follows arc order,
 * except where Graphify stamped `_src`/`_tgt` on an older canonicalized file.
 */
export function parseGraphifyGraph(raw: unknown): ParseGraphResult {
  if (!isRecord(raw))
    return { ok: false, reason: "malformed", detail: "graph.json is not an object" };
  const meta = isRecord(raw["graph"]) ? raw["graph"] : {};
  const schemaVersion = meta["schema_version"];
  if (typeof schemaVersion !== "number")
    return { ok: false, reason: "malformed", detail: "graph.schema_version is missing" };
  if (!SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS.has(schemaVersion))
    return {
      ok: false,
      reason: "unsupported_schema",
      detail: `graph.schema_version ${schemaVersion} is not supported`,
    };
  const rawNodes = raw["nodes"];
  const rawLinks = raw["links"] ?? raw["edges"];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawLinks))
    return { ok: false, reason: "malformed", detail: "nodes or links are missing" };

  const nodes = new Map<string, GoAgentGraphNode>();
  for (const node of rawNodes) {
    if (!isRecord(node)) continue;
    const id = str(node["id"]);
    if (id === null || nodes.has(id)) continue;
    const label = sanitizeLabel(str(node["label"]) ?? id);
    const community = node["community"];
    nodes.set(id, {
      id,
      label,
      kind: kindOf(node, label),
      sourceFile: str(node["source_file"]),
      sourceLocation: str(node["source_location"]),
      community: typeof community === "number" && Number.isInteger(community) ? community : null,
    });
  }

  const edges = new Map<string, GoAgentGraphEdge>();
  for (const link of rawLinks) {
    if (!isRecord(link)) continue;
    const source = str(link["_src"]) ?? str(link["source"]);
    const target = str(link["_tgt"]) ?? str(link["target"]);
    const relation = str(link["relation"]);
    if (source === null || target === null || relation === null) continue;
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const key = edgeKey({ source, target, relation });
    if (edges.has(key)) continue;
    const score = link["confidence_score"];
    edges.set(key, {
      source,
      target,
      relation,
      evidence: evidenceOf(link["confidence"]),
      confidenceScore:
        typeof score === "number" ? score : link["confidence"] === "EXTRACTED" ? 1 : 0,
      sourceFile: str(link["source_file"]),
      sourceLocation: str(link["source_location"]),
    });
  }

  return {
    ok: true,
    graph: {
      graphifyVersion: str(meta["graphify_version"]),
      schemaVersion,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    },
  };
}

const edgeKey = (edge: Pick<GoAgentGraphEdge, "source" | "target" | "relation">) =>
  `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;

export interface GraphDiff {
  readonly addedNodes: ReadonlyArray<GoAgentGraphNode>;
  readonly removedNodes: ReadonlyArray<GoAgentGraphNode>;
  readonly addedEdges: ReadonlyArray<GoAgentGraphEdge>;
  readonly removedEdges: ReadonlyArray<GoAgentGraphEdge>;
}

/** Same semantics as Graphify's `analyze.graph_diff`, but keyed on directed edges. */
export function diffGraphs(
  base: {
    readonly nodes: ReadonlyArray<GoAgentGraphNode>;
    readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  },
  next: {
    readonly nodes: ReadonlyArray<GoAgentGraphNode>;
    readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  },
): GraphDiff {
  const baseNodes = new Set(base.nodes.map((node) => node.id));
  const nextNodes = new Set(next.nodes.map((node) => node.id));
  const baseEdges = new Set(base.edges.map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  return {
    addedNodes: next.nodes.filter((node) => !baseNodes.has(node.id)),
    removedNodes: base.nodes.filter((node) => !nextNodes.has(node.id)),
    addedEdges: next.edges.filter((edge) => !baseEdges.has(edgeKey(edge))),
    removedEdges: base.edges.filter((edge) => !nextEdges.has(edgeKey(edge))),
  };
}

/**
 * Breadth-first neighbourhood of the seed nodes, ignoring edge direction, capped at `maxNodes`.
 * Seeds are kept first so a tight cap still returns them.
 */
export function neighbourhood(
  graph: {
    readonly nodes: ReadonlyArray<GoAgentGraphNode>;
    readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  },
  seedIds: ReadonlyArray<string>,
  options: { readonly hops: number; readonly maxNodes: number },
): {
  readonly nodes: ReadonlyArray<GoAgentGraphNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
} {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Array<string>>();
  for (const edge of graph.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge.source]);
  }
  const selected = new Set<string>();
  let frontier = seedIds.filter((id) => byId.has(id));
  for (const id of frontier) {
    if (selected.size >= options.maxNodes) break;
    selected.add(id);
  }
  for (let hop = 0; hop < options.hops && selected.size < options.maxNodes; hop++) {
    const next: Array<string> = [];
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (selected.has(neighbour) || selected.size >= options.maxNodes) continue;
        selected.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return {
    nodes: [...selected].flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    }),
    edges: graph.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
  };
}

/** Nodes whose source file, label or id matches the query, file nodes first. */
export function searchNodes(
  nodes: ReadonlyArray<GoAgentGraphNode>,
  query: string,
  limit: number,
): ReadonlyArray<GoAgentGraphNode> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const score = (node: GoAgentGraphNode) => {
    const label = node.label.toLowerCase();
    if (label === needle || node.id === needle) return 0;
    if (node.sourceFile?.toLowerCase() === needle) return 1;
    if (label.includes(needle)) return 2;
    if (node.sourceFile?.toLowerCase().includes(needle)) return 3;
    return 4;
  };
  return nodes
    .map((node) => ({ node, rank: score(node) }))
    .filter(({ rank }) => rank < 4)
    .toSorted(
      (a, b) => a.rank - b.rank || Number(b.node.kind === "file") - Number(a.node.kind === "file"),
    )
    .slice(0, limit)
    .map(({ node }) => node);
}
