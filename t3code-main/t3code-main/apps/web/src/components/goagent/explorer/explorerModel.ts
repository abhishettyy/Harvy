import type {
  GoAgentEvidence,
  GoAgentGraphDelta,
  GoAgentGraphEdge,
  GoAgentGraphNode,
} from "@t3tools/contracts";

/**
 * The knowledge graph as a navigable tree: repository → directories → files → classes and
 * functions (→ methods). Everything here is derived from the Graphify graph GoAgent stores; when
 * the graph does not carry something (signatures, summaries), the model does not invent it.
 */
export type ExplorerKind =
  | "root"
  | "directory"
  | "file"
  | "class"
  | "function"
  | "method"
  | "rationale"
  | "package"
  | "decision";

export interface TreeNode {
  readonly id: string;
  readonly kind: ExplorerKind;
  /** Display name: a directory segment (possibly compacted, e.g. `apps/web/src`), file or symbol. */
  readonly name: string;
  /** Repository path for directories and files; the containing file for symbols. */
  readonly path: string | null;
  readonly sourceLocation: string | null;
  readonly parentId: string | null;
  readonly childIds: ReadonlyArray<string>;
  /** Files below a directory (for counts). */
  readonly fileCount: number;
  readonly graphNode: GoAgentGraphNode | null;
}

export type RelationGroup = "imports" | "calls" | "inherits" | "governs" | "rationale" | "other";

export const RELATION_GROUPS: ReadonlyArray<{
  readonly group: RelationGroup;
  readonly label: string;
}> = [
  { group: "imports", label: "Imports" },
  { group: "calls", label: "Calls" },
  { group: "inherits", label: "Inherits" },
  { group: "governs", label: "Decision applies to" },
  { group: "rationale", label: "Explains (WHY)" },
  { group: "other", label: "Other" },
];

export const relationGroupOf = (relation: string): RelationGroup => {
  if (relation === "imports" || relation === "imports_from") return "imports";
  if (relation === "calls") return "calls";
  if (relation === "inherits" || relation === "extends" || relation === "implements")
    return "inherits";
  if (relation === "governs") return "governs";
  if (relation === "rationale_for") return "rationale";
  return "other";
};

/** Hierarchy relations are shown as nesting, never as lines. */
const HIERARCHY_RELATIONS = new Set(["contains", "method"]);

export const ROOT_ID = "root";
const PACKAGES_ID = "dir:@packages";

export interface ExplorerModel {
  readonly nodes: ReadonlyMap<string, TreeNode>;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}

const symbolKind = (node: GoAgentGraphNode): ExplorerKind => {
  switch (node.kind) {
    case "file":
      return "file";
    case "decision":
      return "decision";
    case "rationale":
      return "rationale";
    case "concept":
      return "package";
    case "symbol":
      // Graphify labels callables `name()` and methods `.name()`; other symbols are classes/types.
      if (node.label.startsWith(".") && node.label.endsWith("()")) return "method";
      if (node.label.endsWith("()")) return "function";
      return "class";
  }
};

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** Builds the tree from graph nodes and edges, plus what a task added or removed. */
export function buildExplorerModel(
  graphNodes: ReadonlyArray<GoAgentGraphNode>,
  graphEdges: ReadonlyArray<GoAgentGraphEdge>,
  delta: GoAgentGraphDelta | null = null,
): ExplorerModel {
  const allNodes =
    delta === null
      ? graphNodes
      : [
          ...graphNodes,
          ...delta.removedNodes.filter((n) => !graphNodes.some((m) => m.id === n.id)),
        ];
  const allEdges = delta === null ? graphEdges : [...graphEdges, ...delta.removedEdges];
  type Building = { -readonly [K in keyof TreeNode]: TreeNode[K] } & { childIds: Array<string> };
  const mutable = new Map<string, Building>();
  const add = (node: Omit<TreeNode, "childIds" | "fileCount">) => {
    if (!mutable.has(node.id)) mutable.set(node.id, { ...node, childIds: [], fileCount: 0 });
    return mutable.get(node.id)!;
  };
  add({
    id: ROOT_ID,
    kind: "root",
    name: "Project",
    path: null,
    sourceLocation: null,
    parentId: null,
    graphNode: null,
  });

  const ensureDir = (path: string): string => {
    if (path === "") return ROOT_ID;
    const id = `dir:${path}`;
    if (!mutable.has(id)) {
      const parentPath = path.split("/").slice(0, -1).join("/");
      add({
        id,
        kind: "directory",
        name: fileName(path),
        path,
        sourceLocation: null,
        parentId: ensureDir(parentPath),
        graphNode: null,
      });
    }
    return id;
  };

  const fileIdByPath = new Map<string, string>();
  for (const node of allNodes) {
    if (node.kind !== "file" || node.sourceFile === null) continue;
    const dir = node.sourceFile.split("/").slice(0, -1).join("/");
    add({
      id: node.id,
      kind: "file",
      name: fileName(node.sourceFile),
      path: node.sourceFile,
      sourceLocation: node.sourceLocation,
      parentId: ensureDir(dir),
      graphNode: node,
    });
    fileIdByPath.set(node.sourceFile, node.id);
  }

  // A method belongs to the class that declares it (Graphify's `method` relation).
  const classOfMethod = new Map<string, string>();
  for (const edge of allEdges)
    if (edge.relation === "method") classOfMethod.set(edge.target, edge.source);

  for (const node of allNodes) {
    if (node.kind === "file") continue;
    const kind = symbolKind(node);
    if (kind === "decision") {
      add({
        id: node.id,
        kind,
        name: node.label,
        path: node.sourceFile,
        sourceLocation: null,
        parentId: ROOT_ID,
        graphNode: node,
      });
      continue;
    }
    if (kind === "package") {
      if (!mutable.has(PACKAGES_ID))
        add({
          id: PACKAGES_ID,
          kind: "directory",
          name: "External packages",
          path: null,
          sourceLocation: null,
          parentId: ROOT_ID,
          graphNode: null,
        });
      add({
        id: node.id,
        kind,
        name: node.label,
        path: null,
        sourceLocation: null,
        parentId: PACKAGES_ID,
        graphNode: node,
      });
      continue;
    }
    const fileId = node.sourceFile === null ? undefined : fileIdByPath.get(node.sourceFile);
    if (fileId === undefined) continue; // A symbol without a file in this scan has no place.
    const declaringClass = classOfMethod.get(node.id);
    add({
      id: node.id,
      kind,
      name: kind === "method" ? node.label.slice(1) : node.label,
      path: node.sourceFile,
      sourceLocation: node.sourceLocation,
      parentId: declaringClass !== undefined ? declaringClass : fileId,
      graphNode: node,
    });
  }
  // A method whose class is not in this scan falls back to its file.
  for (const node of mutable.values())
    if (node.parentId !== null && !mutable.has(node.parentId)) {
      const fileId = node.path === null ? undefined : fileIdByPath.get(node.path);
      mutable.set(node.id, { ...node, parentId: fileId ?? ROOT_ID });
    }

  for (const node of mutable.values())
    if (node.parentId !== null) mutable.get(node.parentId)!.childIds.push(node.id);

  // VS Code style compact folders: a directory whose only child is a directory merges into it.
  for (const node of Array.from(mutable.values())) {
    if (node.kind !== "directory" || node.id === PACKAGES_ID || !mutable.has(node.id)) continue;
    let current = node;
    while (current.childIds.length === 1) {
      const only = mutable.get(current.childIds[0]!)!;
      if (only.kind !== "directory" || only.id === PACKAGES_ID) break;
      const merged = {
        ...current,
        name: `${current.name}/${only.name}`,
        path: only.path,
        childIds: only.childIds,
      };
      for (const childId of only.childIds) mutable.get(childId)!.parentId = current.id;
      mutable.delete(only.id);
      mutable.set(current.id, merged);
      current = merged;
    }
  }

  const countFiles = (id: string): number => {
    const node = mutable.get(id)!;
    const count =
      node.kind === "file" ? 1 : node.childIds.reduce((sum, child) => sum + countFiles(child), 0);
    node.fileCount = count;
    return count;
  };
  countFiles(ROOT_ID);

  const order = (a: TreeNode, b: TreeNode) => {
    const rank = (n: TreeNode) =>
      n.kind === "decision" ? 0 : n.kind === "directory" ? (n.id === PACKAGES_ID ? 3 : 1) : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  };
  for (const node of mutable.values())
    node.childIds.sort((a, b) => order(mutable.get(a)!, mutable.get(b)!));

  return {
    nodes: mutable,
    edges: allEdges,
    added: new Set(delta?.addedNodes.map((n) => n.id) ?? []),
    removed: new Set(delta?.removedNodes.map((n) => n.id) ?? []),
  };
}

/** Root first, down to `id`. */
export function ancestorsOf(model: ExplorerModel, id: string): ReadonlyArray<TreeNode> {
  const chain: Array<TreeNode> = [];
  let current = model.nodes.get(id);
  while (current !== undefined) {
    chain.unshift(current);
    current = current.parentId === null ? undefined : model.nodes.get(current.parentId);
  }
  return chain;
}

/** Every container that must be expanded for `id` to be visible. */
export function revealIds(model: ExplorerModel, id: string): ReadonlyArray<string> {
  return ancestorsOf(model, id)
    .slice(0, -1)
    .map((node) => node.id);
}

export const isContainerKind = (kind: ExplorerKind) =>
  kind === "root" || kind === "directory" || kind === "file" || kind === "class";

export interface ExplorerFilters {
  readonly hiddenKinds: ReadonlySet<ExplorerKind>;
  readonly hiddenRelations: ReadonlySet<RelationGroup>;
}

const hiddenByFilter = (
  node: TreeNode,
  filters: ExplorerFilters,
  model: ExplorerModel,
): boolean => {
  if (filters.hiddenKinds.has(node.kind)) return true;
  if (node.id === PACKAGES_ID) return filters.hiddenKinds.has("package");
  return node.parentId !== null && hiddenByFilter(model.nodes.get(node.parentId)!, filters, model);
};

/** The node a collapsed or filtered-out node is drawn as: its nearest visible ancestor. */
export function visibleRepresentative(
  model: ExplorerModel,
  id: string,
  expanded: ReadonlySet<string>,
  filters: ExplorerFilters,
): string | null {
  const chain = ancestorsOf(model, id);
  if (chain.length === 0) return null;
  // Walk down from the root while containers are expanded.
  let shown: TreeNode = chain[0]!;
  for (const node of chain.slice(1)) {
    if (hiddenByFilter(node, filters, model)) break;
    shown = node;
    if (!expanded.has(node.id)) break;
  }
  return shown.kind === "root" ? null : shown.id;
}

export interface AggregatedEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly group: RelationGroup;
  readonly relations: ReadonlyArray<string>;
  readonly count: number;
  /** Weakest evidence among the underlying edges, so an aggregate never looks surer than its parts. */
  readonly evidence: GoAgentEvidence;
  readonly examples: ReadonlyArray<GoAgentGraphEdge>;
  readonly changed: "added" | "removed" | null;
}

const EVIDENCE_RANK: Record<GoAgentEvidence, number> = {
  explicit_human: 3,
  verified_static: 2,
  inferred: 1,
  ambiguous: 0,
};

const edgeKey = (edge: Pick<GoAgentGraphEdge, "source" | "target" | "relation">) =>
  `${edge.source}|${edge.target}|${edge.relation}`;

/** Graph relationships lifted to the visible nodes; hierarchy relations are not lines. */
export function aggregateEdges(
  model: ExplorerModel,
  expanded: ReadonlySet<string>,
  filters: ExplorerFilters,
  delta: GoAgentGraphDelta | null = null,
): ReadonlyArray<AggregatedEdge> {
  const added = new Set(delta?.addedEdges.map(edgeKey) ?? []);
  const removed = new Set(delta?.removedEdges.map(edgeKey) ?? []);
  const repCache = new Map<string, string | null>();
  const rep = (id: string) => {
    if (!repCache.has(id)) repCache.set(id, visibleRepresentative(model, id, expanded, filters));
    return repCache.get(id)!;
  };
  const merged = new Map<
    string,
    {
      id: string;
      source: string;
      target: string;
      group: RelationGroup;
      relations: Set<string>;
      examples: Array<GoAgentGraphEdge>;
      count: number;
      evidence: GoAgentEvidence;
      changed: AggregatedEdge["changed"];
    }
  >();
  for (const edge of model.edges) {
    if (HIERARCHY_RELATIONS.has(edge.relation)) continue;
    const group = relationGroupOf(edge.relation);
    if (filters.hiddenRelations.has(group)) continue;
    const source = rep(edge.source);
    const target = rep(edge.target);
    if (source === null || target === null || source === target) continue;
    // A container's line to its own descendant says nothing the nesting does not.
    if (revealIds(model, target).includes(source) || revealIds(model, source).includes(target))
      continue;
    const id = `${source}->${target}:${group}`;
    const changed = added.has(edgeKey(edge))
      ? "added"
      : removed.has(edgeKey(edge))
        ? "removed"
        : null;
    const entry = merged.get(id) ?? {
      id,
      source,
      target,
      group,
      relations: new Set<string>(),
      examples: [],
      count: 0,
      evidence: edge.evidence,
      changed: null,
    };
    entry.relations.add(edge.relation);
    entry.count += 1;
    if (entry.examples.length < 8) entry.examples.push(edge);
    if (EVIDENCE_RANK[edge.evidence] < EVIDENCE_RANK[entry.evidence])
      entry.evidence = edge.evidence;
    if (changed === "added" || (changed === "removed" && entry.changed === null))
      entry.changed = changed;
    merged.set(id, entry);
  }
  return [...merged.values()].map((entry) => ({ ...entry, relations: [...entry.relations] }));
}
// Layout: nested layered layout. Each expanded container lays out its visible children in
// columns by dependency (users left of what they use), then sizes itself around them.
export const NODE_SIZE: Record<ExplorerKind, { readonly width: number; readonly height: number }> =
  {
    root: { width: 0, height: 0 },
    directory: { width: 240, height: 64 },
    file: { width: 250, height: 70 },
    class: { width: 210, height: 44 },
    function: { width: 210, height: 40 },
    method: { width: 190, height: 36 },
    rationale: { width: 220, height: 40 },
    package: { width: 190, height: 40 },
    decision: { width: 250, height: 58 },
  };

const PADDING = 18;
const HEADER = 40;
const COLUMN_GAP = 90;
const ROW_GAP = 16;
const MAX_ROWS = 10;

export interface PlacedNode {
  readonly id: string;
  readonly node: TreeNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Drawn as a frame around its children. */
  readonly expanded: boolean;
  readonly depth: number;
}

interface Box {
  readonly width: number;
  readonly height: number;
  readonly placed: ReadonlyArray<PlacedNode>;
}

export function layoutExplorer(
  model: ExplorerModel,
  expanded: ReadonlySet<string>,
  filters: ExplorerFilters,
  edges: ReadonlyArray<AggregatedEdge>,
): ReadonlyArray<PlacedNode> {
  // Which child of a container a visible node sits under, for lifting edges to sibling level.
  const childUnder = (containerId: string, id: string): string | null => {
    const chain = ancestorsOf(model, id);
    const index = chain.findIndex((n) => n.id === containerId);
    return index === -1 || index === chain.length - 1 ? null : chain[index + 1]!.id;
  };

  const layoutContainer = (containerId: string, depth: number): Box => {
    const container = model.nodes.get(containerId)!;
    const children = container.childIds.filter(
      (id) => !hiddenByFilter(model.nodes.get(id)!, filters, model),
    );
    const boxes = new Map<string, Box & { readonly expanded: boolean }>();
    for (const id of children) {
      const child = model.nodes.get(id)!;
      const open = isContainerKind(child.kind) && expanded.has(id) && child.childIds.length > 0;
      if (open) {
        const inner = layoutContainer(id, depth + 1);
        boxes.set(id, { ...inner, expanded: true });
      } else {
        const size = NODE_SIZE[child.kind];
        boxes.set(id, { width: size.width, height: size.height, placed: [], expanded: false });
      }
    }

    // Sibling-level dependency graph: a -> b when something under a uses something under b.
    const siblingEdges = new Map<string, Set<string>>();
    for (const edge of edges) {
      const a = childUnder(containerId, edge.source);
      const b = childUnder(containerId, edge.target);
      if (a === null || b === null || a === b) continue;
      if (!siblingEdges.has(a)) siblingEdges.set(a, new Set());
      siblingEdges.get(a)!.add(b);
    }
    const layer = layersOf(children, siblingEdges);
    const columns: Array<Array<string>> = [];
    for (const id of children) {
      const l = layer.get(id) ?? 0;
      (columns[l] ??= []).push(id);
    }
    // Wrap very tall columns so a big directory stays readable.
    const wrapped = columns.filter(Boolean).flatMap((column) => {
      const chunks: Array<Array<string>> = [];
      for (let i = 0; i < column.length; i += MAX_ROWS) chunks.push(column.slice(i, i + MAX_ROWS));
      return chunks;
    });
    // Order within a column next to what it connects to in the previous column (barycenter).
    const rowOf = new Map<string, number>();
    wrapped.forEach((column, columnIndex) => {
      if (columnIndex > 0)
        column.sort(
          (a, b) => barycenter(a, siblingEdges, rowOf) - barycenter(b, siblingEdges, rowOf),
        );
      column.forEach((id, row) => rowOf.set(id, row));
    });

    const top = containerId === ROOT_ID ? 0 : HEADER;
    const left = containerId === ROOT_ID ? 0 : PADDING;
    const placed: Array<PlacedNode> = [];
    let x = left;
    let height = 0;
    for (const column of wrapped) {
      let y = top;
      let width = 0;
      for (const id of column) {
        const box = boxes.get(id)!;
        placed.push({
          id,
          node: model.nodes.get(id)!,
          x,
          y,
          width: box.width,
          height: box.height,
          expanded: box.expanded,
          depth,
        });
        for (const inner of box.placed) placed.push({ ...inner, x: inner.x + x, y: inner.y + y });
        y += box.height + ROW_GAP;
        width = Math.max(width, box.width);
      }
      height = Math.max(height, y - ROW_GAP);
      x += width + COLUMN_GAP;
    }
    const contentWidth = Math.max(x - COLUMN_GAP, left);
    return {
      width: Math.max(contentWidth + PADDING, NODE_SIZE[container.kind].width),
      height: Math.max(height + PADDING, NODE_SIZE[container.kind].height),
      placed,
    };
  };
  return layoutContainer(ROOT_ID, 0).placed;
}

/** Longest-path layering; edges that would close a cycle are ignored. */
function layersOf(
  ids: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, number> {
  const state = new Map<string, "visiting" | "done">();
  const forward = new Map<string, Array<string>>();
  const visit = (id: string) => {
    state.set(id, "visiting");
    for (const next of edges.get(id) ?? []) {
      if (!ids.includes(next)) continue;
      if (state.get(next) === "visiting") continue; // back edge: breaks the cycle
      (forward.get(id) ?? forward.set(id, []).get(id)!).push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const layer = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    // Users sit left of what they use: a node's column is one past its deepest user.
    let deepest = -1;
    for (const [user, targets] of forward)
      if (targets.includes(id)) deepest = Math.max(deepest, depthOf(user, seen));
    const value = deepest + 1;
    layer.set(id, value);
    return value;
  };
  for (const id of ids) depthOf(id, new Set());
  return layer;
}

function barycenter(
  id: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  rowOf: ReadonlyMap<string, number>,
): number {
  const rows: Array<number> = [];
  for (const [user, targets] of edges)
    if (targets.has(id) && rowOf.has(user)) rows.push(rowOf.get(user)!);
  for (const target of edges.get(id) ?? []) if (rowOf.has(target)) rows.push(rowOf.get(target)!);
  return rows.length === 0
    ? Number.MAX_SAFE_INTEGER
    : rows.reduce((a, b) => a + b, 0) / rows.length;
}
// Queries used by the inspector, focus mode and search.
/** Incoming and outgoing aggregated edges of a visible node. */
export function focusOf(
  edges: ReadonlyArray<AggregatedEdge>,
  id: string,
): {
  readonly nodeIds: ReadonlySet<string>;
  readonly outgoing: ReadonlySet<string>;
  readonly incoming: ReadonlySet<string>;
} {
  const nodeIds = new Set([id]);
  const outgoing = new Set<string>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (edge.source === id) {
      outgoing.add(edge.id);
      nodeIds.add(edge.target);
    } else if (edge.target === id) {
      incoming.add(edge.id);
      nodeIds.add(edge.source);
    }
  }
  return { nodeIds, outgoing, incoming };
}

/** Raw graph relationships of a tree node (and, for files and classes, of what they contain). */
export function relationsOf(
  model: ExplorerModel,
  id: string,
): {
  readonly outgoing: ReadonlyArray<GoAgentGraphEdge>;
  readonly incoming: ReadonlyArray<GoAgentGraphEdge>;
} {
  const inside = new Set<string>();
  const collect = (nodeId: string) => {
    inside.add(nodeId);
    for (const child of model.nodes.get(nodeId)?.childIds ?? []) collect(child);
  };
  collect(id);
  const outgoing: Array<GoAgentGraphEdge> = [];
  const incoming: Array<GoAgentGraphEdge> = [];
  for (const edge of model.edges) {
    if (HIERARCHY_RELATIONS.has(edge.relation)) continue;
    const from = inside.has(edge.source);
    const to = inside.has(edge.target);
    if (from && !to) outgoing.push(edge);
    else if (to && !from) incoming.push(edge);
  }
  return { outgoing, incoming };
}

/** Project decisions that apply to a node or to any container it sits in. */
export function decisionsFor(model: ExplorerModel, id: string): ReadonlyArray<TreeNode> {
  const chain = new Set(ancestorsOf(model, id).map((n) => n.id));
  const found = new Map<string, TreeNode>();
  for (const edge of model.edges) {
    if (edge.relation !== "governs" || !chain.has(edge.target)) continue;
    const decision = model.nodes.get(edge.source);
    if (decision !== undefined) found.set(decision.id, decision);
  }
  return [...found.values()];
}

/** Case-insensitive search over names and paths of files and symbols. */
export function searchTree(
  model: ExplorerModel,
  query: string,
  limit = 60,
): ReadonlyArray<TreeNode> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const hits: Array<TreeNode> = [];
  for (const node of model.nodes.values()) {
    if (node.kind === "root" || node.kind === "directory") continue;
    if (
      node.name.toLowerCase().includes(q) ||
      (node.kind === "file" && (node.path ?? "").toLowerCase().includes(q))
    )
      hits.push(node);
    if (hits.length >= limit) break;
  }
  return hits.toSorted(
    (a, b) =>
      Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) ||
      a.name.localeCompare(b.name),
  );
}

/** How many nodes under `id` (inclusive) a task added or removed. */
export function changeCount(
  model: ExplorerModel,
  id: string,
): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  const walk = (nodeId: string) => {
    if (model.added.has(nodeId)) added += 1;
    if (model.removed.has(nodeId)) removed += 1;
    for (const child of model.nodes.get(nodeId)?.childIds ?? []) walk(child);
  };
  walk(id);
  return { added, removed };
}

/** Graphify community id → the files in it, used to describe a file's subsystem. */
export function communityPeers(model: ExplorerModel, fileId: string): ReadonlyArray<TreeNode> {
  const community = model.nodes.get(fileId)?.graphNode?.community;
  if (community === null || community === undefined) return [];
  return [...model.nodes.values()].filter(
    (n) => n.kind === "file" && n.id !== fileId && n.graphNode?.community === community,
  );
}

export interface NodeStats {
  /** Distinct nodes this one (or anything inside it) links to, outside itself. */
  readonly uses: number;
  /** Distinct nodes that link into it from outside. */
  readonly usedBy: number;
  readonly calls: number;
  readonly calledBy: number;
}

/** Per tree node link counts, computed once per model for card metadata and tooltips. */
export function nodeStats(model: ExplorerModel): ReadonlyMap<string, NodeStats> {
  const uses = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const calls = new Map<string, number>();
  const calledBy = new Map<string, number>();
  const bump = (map: Map<string, Set<string>>, key: string, other: string) =>
    (map.get(key) ?? map.set(key, new Set()).get(key)!).add(other);
  const chainCache = new Map<string, ReadonlyArray<string>>();
  const chain = (id: string) => {
    if (!chainCache.has(id))
      chainCache.set(
        id,
        ancestorsOf(model, id).map((n) => n.id),
      );
    return chainCache.get(id)!;
  };
  for (const edge of model.edges) {
    if (HIERARCHY_RELATIONS.has(edge.relation)) continue;
    const from = chain(edge.source);
    const to = chain(edge.target);
    if (from.length === 0 || to.length === 0) continue;
    const shared = new Set(from.filter((id) => to.includes(id)));
    for (const id of from) if (!shared.has(id)) bump(uses, id, edge.target);
    for (const id of to) if (!shared.has(id)) bump(usedBy, id, edge.source);
    if (edge.relation === "calls") {
      calls.set(edge.source, (calls.get(edge.source) ?? 0) + 1);
      calledBy.set(edge.target, (calledBy.get(edge.target) ?? 0) + 1);
    }
  }
  const stats = new Map<string, NodeStats>();
  for (const id of model.nodes.keys())
    stats.set(id, {
      uses: uses.get(id)?.size ?? 0,
      usedBy: usedBy.get(id)?.size ?? 0,
      calls: calls.get(id) ?? 0,
      calledBy: calledBy.get(id) ?? 0,
    });
  return stats;
}
