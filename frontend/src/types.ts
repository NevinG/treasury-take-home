// Mirrors the backend response shapes.

export type FieldStatus = "match" | "mismatch" | "review" | "missing";

export interface FieldVerdict {
  key: string;
  label: string;
  expected: string;
  evidence: string;
  status: FieldStatus;
  note: string;
}

export interface WarningVerdict {
  status: FieldStatus;
  note: string;
  extractedText: string;
}

export interface LabelVerdict {
  matchedApplication: boolean;
  overall: "pass" | "flag" | "fail";
  fields: FieldVerdict[];
  warning: WarningVerdict;
}

/** Response from POST /api/verify. */
export interface VerifyResponse {
  verdict: LabelVerdict;
}
