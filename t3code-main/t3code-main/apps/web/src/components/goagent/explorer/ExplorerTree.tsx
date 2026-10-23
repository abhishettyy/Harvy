import { Search, X } from "lucide-react";
import { useState } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { HintButton } from "./HintButton";
import { ChevronGlyph, KIND_LABEL, KindGlyph } from "./ExplorerIcons";
import {
  ROOT_ID,
  ancestorsOf,
  searchTree,
  type ExplorerModel,
  type TreeNode,
} from "./explorerModel";

/** VS Code style repository tree with search across files and symbols. */
export function ExplorerTree({
  model,
  selectedId,
  onSelect,
  collapsed,
  onCollapsedChange,
}: {
  readonly model: ExplorerModel;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The selected node's ancestors are always open so the selection is visible in the tree.
  const selectionPath = new Set(
    selectedId === null ? [] : ancestorsOf(model, selectedId).map((n) => n.id),
  );
  const isOpen = (id: string) => open.has(id) || selectionPath.has(id);
  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (isOpen(id)) {
        next.delete(id);
      } else next.add(id);
      return next;
    });
  const hits = searchTree(model, query);
  const root = model.nodes.get(ROOT_ID)!;

  if (collapsed)
    return (
      <HintButton
        label="Show repository explorer"
        className="flex w-9 shrink-0 flex-col items-center gap-2 border-r bg-card/40 py-3 text-muted-foreground hover:text-foreground"
        onClick={() => onCollapsedChange(false)}
      >
        <ChevronGlyph size={14} />
        <span className="text-xs [writing-mode:vertical-rl]">Explorer</span>
      </HintButton>
    );

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-card/40">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Explorer
        </span>
        <span className="text-xs text-muted-foreground">{root.fileCount} files</span>
        <HintButton
          label="Hide explorer"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onCollapsedChange(true)}
        >
          <ChevronGlyph size={14} open={false} style={{ transform: "rotate(180deg)" }} />
        </HintButton>
      </div>
      <div className="px-3 pb-2">
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Files, functions, classes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search files and symbols"
            data-explorer-search=""
          />
          {query.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <HintButton
                label="Clear search"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setQuery("")}
              >
                <X className="size-3.5" />
              </HintButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 text-sm">
        {query.trim().length > 0 ? (
          hits.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">Nothing matches “{query}”.</p>
          ) : (
            hits.map((node) => (
              <button
                key={node.id}
                type="button"
                className={rowClass(node.id === selectedId)}
                style={{ paddingLeft: 12 }}
                onClick={() => onSelect(node.id)}
              >
                <KindGlyph kind={node.kind} name={node.name} size={15} />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="max-w-28 truncate text-xs text-muted-foreground">
                  {node.kind === "file" ? parentPath(node.path) : KIND_LABEL[node.kind]}
                </span>
              </button>
            ))
          )
        ) : (
          root.childIds.map((id) => (
            <TreeRow
              key={id}
              model={model}
              id={id}
              depth={0}
              isOpen={isOpen}
              onToggle={toggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}

const parentPath = (path: string | null) =>
  path === null ? "" : path.split("/").slice(0, -1).join("/");

const rowClass = (selected: boolean) =>
  [
    "group flex w-full items-center gap-1.5 py-[3px] pr-3 text-left",
    selected
      ? "bg-info/12 text-foreground shadow-[inset_2px_0_0_var(--color-info)]"
      : "text-foreground/85 hover:bg-accent/60",
  ].join(" ");

function TreeRow({
  model,
  id,
  depth,
  isOpen,
  onToggle,
  selectedId,
  onSelect,
}: {
  readonly model: ExplorerModel;
  readonly id: string;
  readonly depth: number;
  readonly isOpen: (id: string) => boolean;
  readonly onToggle: (id: string) => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const node: TreeNode = model.nodes.get(id)!;
  const hasChildren = node.childIds.length > 0;
  const open = hasChildren && isOpen(id);
  return (
    <>
      <button
        type="button"
        className={rowClass(selectedId === id)}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelect(id);
          if (hasChildren && node.kind === "directory") onToggle(id);
        }}
        onDoubleClick={() => hasChildren && onToggle(id)}
      >
        <span
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) onToggle(id);
          }}
        >
          {hasChildren ? <ChevronGlyph size={12} open={open} /> : null}
        </span>
        <KindGlyph kind={node.kind} name={node.name} open={open} size={15} />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.kind === "directory" ? (
          <span className="text-xs text-muted-foreground">
            {node.fileCount || node.childIds.length}
          </span>
        ) : node.kind === "file" && node.childIds.length > 0 ? (
          <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">
            {node.childIds.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="relative">
          {/* Indent guide */}
          <span
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-border"
            style={{ left: 16 + depth * 14 }}
          />
          {node.childIds.map((childId) => (
            <TreeRow
              key={childId}
              model={model}
              id={childId}
              depth={depth + 1}
              isOpen={isOpen}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
