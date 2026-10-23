import { Badge } from "../ui/badge";

type BadgeVariant = "success" | "error" | "warning" | "info" | "secondary" | "outline";

const VARIANT_BY_STATE: Record<string, BadgeVariant> = {
  completed: "success",
  passed: "success",
  acknowledged: "success",
  parallel: "info",
  single_agent: "info",
  running: "info",
  integrating: "info",
  verifying: "info",
  starting: "info",
  proposed: "info",
  approved: "info",
  blocked: "warning",
  queued: "secondary",
  draft: "secondary",
  planned: "secondary",
  not_started: "secondary",
  "not run": "secondary",
  "not proposed": "secondary",
  pending: "secondary",
  needs_review: "warning",
  conflict: "warning",
  interrupted: "warning",
  timed_out: "error",
  failed: "error",
  cancelled: "outline",
};

/** The literal backend state; the label is never softened or turned into a percentage. */
export function StateBadge({
  state,
  className,
}: {
  readonly state: string;
  readonly className?: string;
}) {
  return (
    <Badge
      size="sm"
      variant={VARIANT_BY_STATE[state] ?? "outline"}
      {...(className === undefined ? {} : { className })}
    >
      {state.replaceAll("_", " ")}
    </Badge>
  );
}
