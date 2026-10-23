import type { GoAgentEvidence, GoAgentGraphEdge } from "@t3tools/contracts";
import type { ReactNode } from "react";

import {
  ChevronGlyph,
  DecisionDiamond,
  KIND_COLOR,
  KIND_LABEL,
  KindGlyph,
  fileTypeOf,
} from "./ExplorerIcons";
import {
  ancestorsOf,
  changeCount,
  communityPeers,
  decisionsFor,
  relationGroupOf,
  relationsOf,
  type ExplorerModel,
  type TreeNode,
} from "./explorerModel";

const EVIDENCE: Record<GoAgentEvidence, { readonly label: string; readonly className: string }> = {
  verified_static: { label: "verified", className: "text-success-foreground" },
  inferred: { label: "inferred", className: "text-warning-foreground" },
  ambiguous: { label: "ambiguous", className: "text-warning-foreground" },
  explicit_human: { label: "by a person", className: "text-warning" },
};

const cite = (file: string | null, location: string | null) =>
  file === null ? null : `${file}${location === null ? "" : `:${location.replace(/^L/, "")}`}`;

export function ExplorerInspector({
  model,
  selectedId,
  onSelect,
}: {
  readonly model: ExplorerModel;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const node = selectedId === null ? undefined : model.nodes.get(selectedId);
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l bg-card/40">
      {node === undefined ? (
        <div className="flex flex-col gap-2 p-4 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Inspector
          </span>
          <p className="text-muted-foreground">
            Select a directory, file, function or decision to see what it contains, what it uses,
            what uses it, and which project decisions apply to it.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            <li>Click — select and highlight links</li>
            <li>Double-click — expand or collapse</li>
            <li>F — fit · Esc — clear · / — search · R — reset</li>
          </ul>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Header model={model} node={node} />
          <div className="flex flex-col gap-1 px-2 pb-6">
            <Body model={model} node={node} onSelect={onSelect} />
          </div>
        </div>
      )}
    </aside>
  );
}

function Header({ model, node }: { readonly model: ExplorerModel; readonly node: TreeNode }) {
  const changes = changeCount(model, node.id);
  return (
    <div className="flex flex-col gap-1.5 border-b px-4 py-3">
      <span className="flex items-center gap-2">
        <KindGlyph kind={node.kind} name={node.name} open size={18} />
        <span className="min-w-0 flex-1 truncate text-base font-semibold">{node.name}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-xs">
        <span
          className="rounded px-1.5 py-0.5 font-medium"
          style={{
            color: KIND_COLOR[node.kind],
            background: `color-mix(in srgb, ${KIND_COLOR[node.kind]} 14%, transparent)`,
          }}
        >
          {node.kind === "file" ? fileTypeOf(node.name).label : KIND_LABEL[node.kind]}
        </span>
        {changes.added > 0 ? (
          <span className="rounded bg-success/12 px-1.5 py-0.5 text-success-foreground">
            +{changes.added} added in this step
          </span>
        ) : null}
        {changes.removed > 0 ? (
          <span className="rounded bg-destructive/12 px-1.5 py-0.5 text-destructive-foreground">
            −{changes.removed} removed
          </span>
        ) : null}
      </span>
      {node.path === null ? null : (
        <code className="truncate text-xs text-muted-foreground">
          {node.kind === "directory" || node.kind === "file"
            ? node.path
            : cite(node.path, node.sourceLocation)}
        </code>
      )}
    </div>
  );
}

function Body({
  model,
  node,
  onSelect,
}: {
  readonly model: ExplorerModel;
  readonly node: TreeNode;
  readonly onSelect: (id: string) => void;
}) {
  const { outgoing, incoming } = relationsOf(model, node.id);
  const decisions = decisionsFor(model, node.id).filter((d) => d.id !== node.id);
  const byGroup = (edges: ReadonlyArray<GoAgentGraphEdge>, group: string) =>
    edges.filter((edge) => relationGroupOf(edge.relation) === group);
  const children = node.childIds.map((id) => model.nodes.get(id)!);

  if (node.kind === "decision") {
    const affected = outgoing.filter((edge) => edge.relation === "governs");
    return (
      <>
        <Section title="Decision" defaultOpen>
          <p className="px-2 text-sm leading-relaxed">{node.name}</p>
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            {node.path === null
              ? "Recorded by the project's owner in GoAgent."
              : `Imported from ${node.path} (seeded).`}{" "}
            Every mission agent is told to follow it.
          </p>
        </Section>
        <Section title="Applies to" count={affected.length} defaultOpen>
          {affected.length === 0 ? (
            <Empty>Its text names no file in the graph, so it applies to the whole project.</Empty>
          ) : (
            affected.map((edge) => (
              <EdgeRow
                key={`${edge.target}`}
                model={model}
                edge={edge}
                end="target"
                onSelect={onSelect}
              />
            ))
          )}
        </Section>
      </>
    );
  }

  const symbols = children.filter((c) => c.kind !== "rationale");
  const notes = children.filter((c) => c.kind === "rationale");
  const isCallable = node.kind === "function" || node.kind === "method" || node.kind === "class";
  return (
    <>
      {node.kind === "directory" ? (
        <Section title="Contents" count={children.length} defaultOpen>
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            {node.fileCount} file{node.fileCount === 1 ? "" : "s"} in total
          </p>
          {children.map((child) => (
            <NodeRow key={child.id} node={child} onSelect={onSelect} />
          ))}
        </Section>
      ) : null}

      {node.kind === "file" ? (
        <>
          <Section title="Notes from the code" count={notes.length} defaultOpen={notes.length > 0}>
            {notes.length === 0 ? (
              <Empty>
                No summary: GoAgent indexes code without an LLM pass, and this file has no WHY /
                NOTE comments.
              </Empty>
            ) : (
              notes.map((note) => (
                <p key={note.id} className="px-2 py-1 text-xs leading-relaxed">
                  {note.name}
                </p>
              ))
            )}
          </Section>
          <Section title="Defines" count={symbols.length} defaultOpen>
            {symbols.length === 0 ? (
              <Empty>No functions or classes found in this file.</Empty>
            ) : (
              symbols.map((child) => <NodeRow key={child.id} node={child} onSelect={onSelect} />)
            )}
          </Section>
        </>
      ) : null}

      {node.kind === "class" && children.length > 0 ? (
        <Section title="Methods" count={children.length} defaultOpen>
          {children.map((child) => (
            <NodeRow key={child.id} node={child} onSelect={onSelect} />
          ))}
        </Section>
      ) : null}

      {isCallable ? (
        <>
          <Section title="Declared in" defaultOpen>
            {ancestorsOf(model, node.id)
              .slice(1, -1)
              .filter((a) => a.kind === "file" || a.kind === "class")
              .map((parent) => (
                <NodeRow key={parent.id} node={parent} onSelect={onSelect} />
              ))}
            <Empty>
              Signature, parameters and return type are not in the graph: Graphify's code pass
              records names, locations and links.
            </Empty>
          </Section>
          <Section title="Called by" count={byGroup(incoming, "calls").length} defaultOpen>
            <EdgeList
              model={model}
              edges={byGroup(incoming, "calls")}
              end="source"
              onSelect={onSelect}
              empty="No callers found."
            />
          </Section>
          <Section title="Calls" count={byGroup(outgoing, "calls").length} defaultOpen>
            <EdgeList
              model={model}
              edges={byGroup(outgoing, "calls")}
              end="target"
              onSelect={onSelect}
              empty="Calls nothing outside itself."
            />
          </Section>
        </>
      ) : null}

      {node.kind === "file" || node.kind === "directory" ? (
        <>
          <Section title="Uses" count={outgoing.length} defaultOpen={node.kind === "file"}>
            <EdgeList
              model={model}
              edges={outgoing}
              end="target"
              onSelect={onSelect}
              empty="Uses nothing outside itself."
              grouped
            />
          </Section>
          <Section title="Used by" count={incoming.length} defaultOpen={node.kind === "file"}>
            <EdgeList
              model={model}
              edges={incoming}
              end="source"
              onSelect={onSelect}
              empty="Nothing else uses it."
              grouped
            />
          </Section>
        </>
      ) : (
        <>
          {byGroup(outgoing, "imports").length + byGroup(incoming, "imports").length > 0 ? (
            <Section
              title="Other links"
              count={
                outgoing.length +
                incoming.length -
                byGroup(outgoing, "calls").length -
                byGroup(incoming, "calls").length
              }
            >
              <EdgeList
                model={model}
                edges={outgoing.filter((e) => e.relation !== "calls")}
                end="target"
                onSelect={onSelect}
                empty=""
                grouped
              />
              <EdgeList
                model={model}
                edges={incoming.filter((e) => e.relation !== "calls")}
                end="source"
                onSelect={onSelect}
                empty=""
                grouped
              />
            </Section>
          ) : null}
        </>
      )}

      <Section
        title="Project decisions"
        count={decisions.length}
        defaultOpen={decisions.length > 0}
      >
        {decisions.length === 0 ? (
          <Empty>No recorded decision names this code.</Empty>
        ) : (
          decisions.map((decision) => (
            <button
              key={decision.id}
              type="button"
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => onSelect(decision.id)}
            >
              <DecisionDiamond size={14} filled className="mt-0.5 shrink-0 text-warning" />
              <span className="line-clamp-3">{decision.name}</span>
            </button>
          ))
        )}
      </Section>

      {node.kind === "file" ? <Peers model={model} node={node} onSelect={onSelect} /> : null}
    </>
  );
}

function Peers({
  model,
  node,
  onSelect,
}: {
  readonly model: ExplorerModel;
  readonly node: TreeNode;
  readonly onSelect: (id: string) => void;
}) {
  const peers = communityPeers(model, node.id);
  if (peers.length === 0) return null;
  return (
    <Section title="Same subsystem" count={peers.length}>
      <p className="px-2 pb-1 text-xs text-muted-foreground">
        Files Graphify clusters with this one (community {node.graphNode?.community}).
      </p>
      {peers.slice(0, 20).map((peer) => (
        <NodeRow key={peer.id} node={peer} onSelect={onSelect} showPath />
      ))}
    </Section>
  );
}

function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group/section rounded-md">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronGlyph size={12} className="transition-transform group-open/section:rotate-90" />
        {title}
        {count === undefined ? null : <span className="font-normal normal-case">{count}</span>}
      </summary>
      <div className="flex flex-col pb-2">{children}</div>
    </details>
  );
}

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>
);

function NodeRow({
  node,
  onSelect,
  showPath = false,
}: {
  readonly node: TreeNode;
  readonly onSelect: (id: string) => void;
  readonly showPath?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
      onClick={() => onSelect(node.id)}
    >
      <KindGlyph kind={node.kind} name={node.name} size={14} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <span className="truncate text-muted-foreground">
        {showPath
          ? node.path
          : (node.sourceLocation ?? (node.kind === "directory" ? `${node.fileCount}` : ""))}
      </span>
    </button>
  );
}

function EdgeList({
  model,
  edges,
  end,
  onSelect,
  empty,
  grouped = false,
}: {
  readonly model: ExplorerModel;
  readonly edges: ReadonlyArray<GoAgentGraphEdge>;
  readonly end: "source" | "target";
  readonly onSelect: (id: string) => void;
  readonly empty: string;
  readonly grouped?: boolean;
}) {
  if (edges.length === 0) return empty === "" ? null : <Empty>{empty}</Empty>;
  const shown = edges.slice(0, 40);
  if (!grouped)
    return (
      <>
        {shown.map((edge) => (
          <EdgeRow
            key={`${edge.source}|${edge.target}|${edge.relation}`}
            model={model}
            edge={edge}
            end={end}
            onSelect={onSelect}
          />
        ))}
        {edges.length > shown.length ? (
          <Empty>…and {edges.length - shown.length} more</Empty>
        ) : null}
      </>
    );
  const groups = new Map<string, Array<GoAgentGraphEdge>>();
  for (const edge of shown) {
    const key = edge.relation;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  return (
    <>
      {[...groups.entries()].map(([relation, list]) => (
        <div key={relation} className="flex flex-col">
          <span className="px-2 pt-1 text-2xs text-muted-foreground">
            {relation.replace("_", " ")}
          </span>
          {list.map((edge) => (
            <EdgeRow
              key={`${edge.source}|${edge.target}|${edge.relation}`}
              model={model}
              edge={edge}
              end={end}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
      {edges.length > shown.length ? <Empty>…and {edges.length - shown.length} more</Empty> : null}
    </>
  );
}

function EdgeRow({
  model,
  edge,
  end,
  onSelect,
}: {
  readonly model: ExplorerModel;
  readonly edge: GoAgentGraphEdge;
  readonly end: "source" | "target";
  readonly onSelect: (id: string) => void;
}) {
  const otherId = end === "target" ? edge.target : edge.source;
  const other = model.nodes.get(otherId);
  const evidence = EVIDENCE[edge.evidence];
  const where = cite(edge.sourceFile, edge.sourceLocation);
  return (
    <button
      type="button"
      className="flex w-full flex-col rounded px-2 py-1 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      onClick={() => other !== undefined && onSelect(other.id)}
      disabled={other === undefined}
    >
      <span className="flex w-full items-center gap-2">
        {other === undefined ? null : <KindGlyph kind={other.kind} name={other.name} size={14} />}
        <span className="min-w-0 flex-1 truncate">{other?.name ?? otherId}</span>
        <span className={evidence.className}>{evidence.label}</span>
      </span>
      {where === null ? null : (
        <code className="truncate pl-6 text-2xs text-muted-foreground">{where}</code>
      )}
    </button>
  );
}
