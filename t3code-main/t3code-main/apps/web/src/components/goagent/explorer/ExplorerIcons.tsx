import type { SVGProps } from "react";

import type { ExplorerKind } from "./explorerModel";

/**
 * Small, consistent SVG glyphs for the knowledge-graph explorer: 16×16 viewBox, 1.5px strokes,
 * `currentColor` unless the glyph carries a file-type identity colour.
 */
type GlyphProps = SVGProps<SVGSVGElement> & { readonly size?: number };

const Svg = ({ size = 16, children, ...props }: GlyphProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
);

export const FolderGlyph = ({
  open = false,
  ...props
}: GlyphProps & { readonly open?: boolean }) => (
  <Svg {...props}>
    {open ? (
      <>
        <path d="M1.75 4.25v7.5c0 .55.45 1 1 1h9.6c.42 0 .8-.27.94-.67l1.5-4.33a.75.75 0 0 0-.71-1H4.5c-.42 0-.8.27-.94.67L2 12" />
        <path d="M1.75 11V4.25c0-.55.45-1 1-1h3l1.5 1.5h4.5c.55 0 1 .45 1 1v1" />
      </>
    ) : (
      <path d="M1.75 4.25c0-.55.45-1 1-1h3l1.5 1.5h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />
    )}
  </Svg>
);

export const FunctionGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <path d="M10.5 2.75h-1c-1.1 0-1.75.75-2 2l-1.6 7c-.25 1.25-.9 2-2 2h-1" />
    <path d="M4.5 7h5.5" />
  </Svg>
);

export const MethodGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    <path d="M5.5 10.5V6.5l2.5 2.5 2.5-2.5v4" />
  </Svg>
);

export const ClassGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z" />
    <path d="M10 6.5a2.25 2.25 0 1 0 0 3" />
  </Svg>
);

export const DecisionDiamond = ({
  filled = false,
  ...props
}: GlyphProps & { readonly filled?: boolean }) => (
  <Svg {...props}>
    <path
      d="M8 1.75 14.25 8 8 14.25 1.75 8z"
      fill={filled ? "currentColor" : "none"}
      fillOpacity={0.2}
    />
    <path d="M8 5.25v3.25M8 10.75h.01" />
  </Svg>
);

export const RationaleGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <path d="M2.75 3.25h10.5v7.5H8.5l-3 2.5v-2.5H2.75z" />
    <path d="M6.5 6.1a1.5 1.5 0 1 1 2 1.4c-.35.15-.5.4-.5.75M8 9.6h.01" />
  </Svg>
);

export const PackageGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <path d="M8 1.75 13.75 4.9v6.2L8 14.25 2.25 11.1V4.9z" />
    <path d="M2.25 4.9 8 8.05l5.75-3.15M8 8.05v6.2" />
  </Svg>
);

export const ChevronGlyph = ({
  open = false,
  ...props
}: GlyphProps & { readonly open?: boolean }) => (
  <Svg
    {...props}
    style={{ transition: "transform 120ms ease", transform: open ? "rotate(90deg)" : undefined }}
  >
    <path d="M6 3.75 10.25 8 6 12.25" />
  </Svg>
);

export const ProjectGlyph = (props: GlyphProps) => (
  <Svg {...props}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M1.75 5.75h12.5M4.5 9h3M4.5 11h5" />
  </Svg>
);

type FileType = {
  readonly label: string;
  readonly color: string;
  /** Short mark drawn on the file badge. */
  readonly mark: string;
};

const FILE_TYPES: ReadonlyArray<{ readonly test: RegExp; readonly type: FileType }> = [
  { test: /\.(test|spec)\.[cm]?[jt]sx?$/, type: { label: "Test", color: "#14b8a6", mark: "T" } },
  { test: /\.tsx$/, type: { label: "TypeScript React", color: "#38bdf8", mark: "TSX" } },
  { test: /\.d\.ts$/, type: { label: "Type declarations", color: "#60a5fa", mark: "D" } },
  { test: /\.[cm]?ts$/, type: { label: "TypeScript", color: "#3b82f6", mark: "TS" } },
  { test: /\.jsx$/, type: { label: "JavaScript React", color: "#22d3ee", mark: "JSX" } },
  { test: /\.[cm]?js$/, type: { label: "JavaScript", color: "#eab308", mark: "JS" } },
  { test: /\.py$/, type: { label: "Python", color: "#3b82f6", mark: "PY" } },
  { test: /\.go$/, type: { label: "Go", color: "#22d3ee", mark: "GO" } },
  { test: /\.rs$/, type: { label: "Rust", color: "#f97316", mark: "RS" } },
  { test: /\.json$/, type: { label: "JSON", color: "#eab308", mark: "{}" } },
  { test: /\.(md|mdx)$/, type: { label: "Markdown", color: "#a1a1aa", mark: "MD" } },
  { test: /\.(css|scss|less)$/, type: { label: "Stylesheet", color: "#a855f7", mark: "#" } },
  { test: /\.html?$/, type: { label: "HTML", color: "#f97316", mark: "<>" } },
  { test: /\.(ya?ml|toml)$/, type: { label: "Config", color: "#f43f5e", mark: "CF" } },
  { test: /\.sql$/, type: { label: "SQL", color: "#f59e0b", mark: "SQL" } },
];

const OTHER_FILE: FileType = { label: "File", color: "#71717a", mark: "" };

export const fileTypeOf = (name: string): FileType =>
  FILE_TYPES.find((entry) => entry.test.test(name.toLowerCase()))?.type ?? OTHER_FILE;

/** A file sheet with a coloured type mark, e.g. TS, TSX, JSON. */
export const FileTypeIcon = ({
  name,
  size = 16,
}: {
  readonly name: string;
  readonly size?: number;
}) => {
  const type = fileTypeOf(name);
  const fontSize = type.mark.length >= 3 ? 3.6 : type.mark.length === 2 ? 4.4 : 5.6;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={type.label} role="img">
      <path
        d="M3.25 1.75h6.5l3 3v9.5H3.25z"
        fill="none"
        stroke={type.color}
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
      <path
        d="M9.75 1.75v3h3"
        fill="none"
        stroke={type.color}
        strokeWidth={1.25}
        strokeLinejoin="round"
      />
      {type.mark === "" ? null : (
        <text
          x="8"
          y="12.2"
          textAnchor="middle"
          fontSize={fontSize}
          fontWeight={700}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fill={type.color}
        >
          {type.mark}
        </text>
      )}
    </svg>
  );
};

/** One accent per node kind: cyan/violet/emerald/amber, as the design language asks. */
export const KIND_COLOR: Record<ExplorerKind, string> = {
  root: "#a1a1aa",
  directory: "#a1a1aa",
  file: "#38bdf8",
  class: "#a78bfa",
  function: "#34d399",
  method: "#6ee7b7",
  rationale: "#22d3ee",
  package: "#71717a",
  decision: "#f59e0b",
};

export const KIND_LABEL: Record<ExplorerKind, string> = {
  root: "Project",
  directory: "Directory",
  file: "File",
  class: "Class / type",
  function: "Function",
  method: "Method",
  rationale: "WHY comment",
  package: "External package",
  decision: "Project decision",
};

/** The glyph for a tree node of any kind. */
export function KindGlyph({
  kind,
  name,
  open,
  size = 16,
}: {
  readonly kind: ExplorerKind;
  readonly name: string;
  readonly open?: boolean;
  readonly size?: number;
}) {
  const color = KIND_COLOR[kind];
  switch (kind) {
    case "root":
      return <ProjectGlyph size={size} style={{ color }} />;
    case "directory":
      return <FolderGlyph size={size} open={open ?? false} style={{ color }} />;
    case "file":
      return <FileTypeIcon name={name} size={size} />;
    case "class":
      return <ClassGlyph size={size} style={{ color }} />;
    case "function":
      return <FunctionGlyph size={size} style={{ color }} />;
    case "method":
      return <MethodGlyph size={size} style={{ color }} />;
    case "rationale":
      return <RationaleGlyph size={size} style={{ color }} />;
    case "package":
      return <PackageGlyph size={size} style={{ color }} />;
    case "decision":
      return <DecisionDiamond size={size} filled style={{ color }} />;
  }
}

/** Empty-state illustration: three linked nodes, drawn with the same stroke language. */
export const EmptyGraphIllustration = () => (
  <svg width="120" height="80" viewBox="0 0 120 80" fill="none" aria-hidden="true">
    <path
      d="M38 24c14 0 18 16 32 16M38 56c14 0 18-16 32-16"
      stroke="currentColor"
      strokeOpacity={0.35}
      strokeWidth={1.5}
      strokeDasharray="3 4"
    />
    <rect
      x="8"
      y="14"
      width="30"
      height="20"
      rx="5"
      stroke="currentColor"
      strokeOpacity={0.6}
      strokeWidth={1.5}
    />
    <rect
      x="8"
      y="46"
      width="30"
      height="20"
      rx="5"
      stroke="currentColor"
      strokeOpacity={0.6}
      strokeWidth={1.5}
    />
    <rect
      x="70"
      y="30"
      width="42"
      height="20"
      rx="5"
      stroke="currentColor"
      strokeOpacity={0.9}
      strokeWidth={1.5}
    />
    <path
      d="M78 40h26"
      stroke="currentColor"
      strokeOpacity={0.5}
      strokeWidth={1.5}
      strokeLinecap="round"
    />
  </svg>
);
