import type { SVGProps } from "react";

/**
 * Harvy brand logomark — a geometric "H" with a diagonal crossbar slash,
 * evoking parallel agents (two pillars) connected by a smart bridge.
 * Uses fill="currentColor" so it adapts to any theme color.
 */
export function HarvyWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      viewBox="0 0 100 74"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Harvy"
    >
      {/* Left pillar */}
      <rect x="0" y="0" width="18" height="74" rx="5" ry="5" fill="currentColor" />
      {/* Right pillar */}
      <rect x="82" y="0" width="18" height="74" rx="5" ry="5" fill="currentColor" />
      {/* Diagonal crossbar — the "smart bridge" between agents */}
      <path
        d="M16 48 L84 26"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
