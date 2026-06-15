import type { FieldStatus } from "../types";

const LABELS: Record<FieldStatus, string> = {
  match: "Match",
  mismatch: "Mismatch",
  review: "Review",
  missing: "Missing",
};

export function StatusChip({ status }: { status: FieldStatus }) {
  return <span className={`chip ${status}`}>{LABELS[status]}</span>;
}
