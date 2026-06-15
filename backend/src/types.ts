// Shared types for the TTB label verification backend.

/**
 * A per-field comparison between the application's stated value and the label.
 *  - "match":    the label's value is consistent with the application's value
 *  - "mismatch": the label clearly shows a DIFFERENT, conflicting value (hard fail)
 *  - "review":   the value is not visible on the imaged label (soft flag — may be
 *                molded in glass or on a panel/strip that wasn't provided)
 */
export interface FieldCheck {
  status: "match" | "mismatch" | "review";
  label_value: string; // exactly what the label shows for this element ("" if absent)
  note: string; // short reason for the status
}

export interface WarningReading {
  present: boolean;
  heading: string; // the warning heading EXACTLY as printed, e.g. "GOVERNMENT WARNING:" (case preserved)
  text: string; // the full warning statement, verbatim
  prefix_all_caps: boolean; // fallback caps signal when no heading is captured
  legible: boolean; // is the warning fully legible — not scribbled over, struck through, or obscured?
}

/** Application-aware verification of all mandatory TTB label elements. */
export interface VerificationResult {
  brand: FieldCheck;
  class_type: FieldCheck;
  alcohol_content: FieldCheck;
  net_contents: FieldCheck;
  name_address: FieldCheck;
  country_of_origin: FieldCheck;
  government_warning: WarningReading;
}

/** One row parsed from the application text. */
export interface ApplicationRow {
  file: string;
  brand_name?: string;
  fanciful_name?: string;
  class_type?: string;
  alcohol_content?: string;
  net_contents?: string;
  producer_name?: string;
  country_of_origin?: string;
}

export type FieldStatus = "match" | "mismatch" | "review" | "missing";

export interface FieldVerdict {
  key: string;
  label: string;
  expected: string; // what the application says (may be empty)
  evidence: string; // the matching text found on the label
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
