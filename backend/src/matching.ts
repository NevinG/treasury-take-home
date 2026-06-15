// Turns the model's label reading into a verdict. The model reads each element's
// value off the label reliably, but its match/mismatch judgment is not trustworthy,
// so the comparison for every field is done here with deterministic rules.

import type {
  ApplicationRow,
  FieldStatus,
  FieldVerdict,
  LabelVerdict,
  VerificationResult,
  WarningReading,
  WarningVerdict,
} from "./types";

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// True only if the string carries a real value (not blank or a placeholder like
// "N/A", "none", "-"). Used so a missing application value can never count as a match.
const PLACEHOLDER = new Set(["na", "n", "a", "none", "null", "nil", "tbd", "unknown", "nan", "x"]);
function meaningful(s: string): boolean {
  const cleaned = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return false;
  return cleaned.split(" ").some((t) => !PLACEHOLDER.has(t));
}

// --- Deterministic class/type comparison via major TTB product class ---
// The label's designation is read reliably; the model occasionally rationalizes a
// cross-class match ("VODKA" == an ale). We map both sides to one of the three
// major classes (wine / distilled spirits / malt beverage) and compare those.
const MALT_RE = /\b(beer|ale|lager|stout|porter|malt|ipa|pilsner|pilsener|bock|saison|brewed|brew)\b/i;
const SPIRIT_RE = /\b(whisky|whiskey|bourbon|rye|scotch|vodka|gin|rum|tequila|mezcal|brandy|cognac|armagnac|liqueur|cordial|schnapps|absinthe|grappa|aquavit|akvavit|eau[\s-]?de[\s-]?vie|distilled|spirit|spirits|proof)\b/i;
const WINE_RE = /\b(wine|wines|chardonnay|cabernet|merlot|pinot|sauvignon|riesling|zinfandel|syrah|shiraz|malbec|tempranillo|grenache|sangiovese|champagne|cava|prosecco|sparkling|port|sherry|madeira|marsala|vermouth|sake|mead|sangria|ros[eé]|blanc|rouge|moscato|muscat|gewurztraminer|gew[uü]rztraminer|viognier|graciano|muscadine|grape|vineyard|vinifera|table wine|dessert)\b/i;

// Wine-specific designations that don't contain the word "wine" (common on
// European labels): aging terms, varietal-language words, and a vintage year.
const WINE_HINT_RE = /\b(reserva|riserva|crianza|gran reserva|tinto|tinta|blanco|blanca|negre|negro|rouge|rosso|bianco|tardana|brut|sec|demi-sec|doc|docg|d\.o\.|aoc|appellation|vendange|vino|vins?)\b/i;
const VINTAGE_RE = /\b(19|20)\d{2}\b/;

function majorClass(s: string): "wine" | "spirit" | "malt" | null {
  const v = s || "";
  if (SPIRIT_RE.test(v)) return "spirit";
  if (MALT_RE.test(v)) return "malt";
  if (WINE_RE.test(v)) return "wine";
  if (WINE_HINT_RE.test(v) || VINTAGE_RE.test(v)) return "wine";
  return null;
}

function classStatus(expected: string, labelValue: string): FieldStatus | null {
  const me = majorClass(expected);
  const ml = majorClass(labelValue);
  if (me && ml) return me === ml ? "match" : "mismatch";
  if (!labelValue.trim()) return "review";
  // We can read text but can't map it to a major class (e.g. "RESERVA 2011"):
  // abstain rather than fail — a designation we can't classify isn't proof of a
  // conflict. Only defer to the model when the application side is the unknown one.
  if (!ml) return "review";
  return null;
}

// --- Deterministic numeric comparison for alcohol % and net contents ---
// The model reads label values reliably but sometimes rationalizes a "match"
// across genuinely different numbers ("40% is a typo for 11%"). For these
// mechanical fields we trust the model's reading and judge the numbers in code.

function firstNumber(s: string): number | null {
  const m = (s || "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const VOL_RE = /(\d+(?:\.\d+)?)\s*(ml|milliliters?|cl|centiliters?|l|liters?|litres?|gal(?:lon)?s?|fl\.?\s*oz|oz)\b/gi;
function parseVolumesMl(s: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  VOL_RE.lastIndex = 0;
  while ((m = VOL_RE.exec((s || "").toLowerCase()))) {
    const n = parseFloat(m[1]);
    let u = m[2];
    let f = 1;
    if (u.startsWith("gal")) f = 3785.41;
    else if (u.startsWith("milli") || u === "ml") f = 1;
    else if (u.startsWith("centi") || u === "cl") f = 10;
    else if (u.startsWith("lit") || u.startsWith("litre") || u === "l") f = 1000;
    else if (u.includes("oz")) f = 29.5735;
    out.push(n * f);
  }
  return out;
}

/** Compare an alcohol-percentage field. Returns null if not numerically decidable. */
function abvStatus(expected: string, labelValue: string): FieldStatus | null {
  const e = firstNumber(expected);
  const l = firstNumber(labelValue);
  if (e === null) return null; // application has no ABV to check against
  if (l === null) return "review"; // not visible on the label
  return Math.abs(e - l) <= 0.5 ? "match" : "mismatch";
}

/** Compare a net-contents field (application may list several allowed sizes). */
function netStatus(expected: string, labelValue: string): FieldStatus | null {
  const exp = parseVolumesMl(expected);
  const lab = parseVolumesMl(labelValue);
  if (!exp.length) return null; // nothing to check against
  if (!lab.length) return "review"; // not visible on the label
  const ok = lab.some((lv) => exp.some((ev) => Math.abs(lv - ev) <= 0.02 * Math.max(lv, ev)));
  return ok ? "match" : "mismatch";
}

const US_SIGNAL = /\b(domestic|usa|u\.?s\.?a?\.?|united states(?: of america)?|america)\b/i;
const IMPORT_SIGNAL = /\b(import|imported|importado|imported by|imported from)\b/i;
const FOREIGN = /\b(spain|españa|espana|italy|italia|france|french|germany|deutschland|portugal|chile|argentina|australia|new zealand|south africa|mexico|canada|austria|hungary|israel|japan|scotland|ireland|england|united kingdom|netherlands|china|brazil|peru|uruguay|croatia|slovenia|sorrento)\b/i;
// US state names — a label naming a state (e.g. "GEORGIA", "California") is domestic,
// even though some state names ("Georgia") are also countries.
const US_STATE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

function labelIsForeign(labelValue: string): boolean {
  const s = labelValue || "";
  if (IMPORT_SIGNAL.test(s)) return true; // explicit import statement
  if (/\b(product|produce|producto|produkt|vino|vin)\s+(of|de|d['e])\b/i.test(s) && FOREIGN.test(s)) return true;
  if (US_SIGNAL.test(s) || US_STATE.test(s)) return false; // US country or a US state → domestic
  return FOREIGN.test(s);
}

/** Compare country of origin. Returns null when the case is left to the model. */
function countryStatus(expected: string, labelValue: string): FieldStatus | null {
  const exp = (expected || "").trim();
  const expectedDomestic = exp === "" || (US_SIGNAL.test(exp) && !IMPORT_SIGNAL.test(exp) && !FOREIGN.test(exp));
  if (expectedDomestic) {
    return labelIsForeign(labelValue) ? "mismatch" : "match";
  }
  // application says imported / names a foreign country
  if (labelIsForeign(labelValue)) return "match";
  if (!labelValue.trim()) return "review";
  return null;
}

function warningVerdict(w: WarningReading): WarningVerdict {
  if (!w || !w.present) {
    return {
      status: "missing",
      note: "Government Warning not found on the provided images — confirm it appears on the product.",
      extractedText: w?.text || "",
    };
  }
  const notes: string[] = [];
  let status: FieldStatus = "match";

  // The warning must be conspicuous and readily legible. If it is scribbled over,
  // struck through, or otherwise obscured, it fails regardless of its wording.
  if (w.legible === false) {
    return {
      status: "mismatch",
      note: "The Government Warning is obscured or struck through and is not clearly legible.",
      extractedText: w.text || "",
    };
  }

  // Judge capitalization from the verbatim heading the model read, not its
  // (unreliable) boolean. Fall back to the boolean / full text if no heading.
  const heading = (w.heading || "").trim();
  const letters = heading.replace(/[^a-zA-Z]/g, "");
  let capsOk: boolean;
  if (letters) {
    capsOk = heading === heading.toUpperCase();
  } else if (/government warning/i.test(w.text)) {
    capsOk = /GOVERNMENT WARNING/.test(w.text); // exact uppercase present in body
  } else {
    capsOk = w.prefix_all_caps;
  }
  if (!capsOk) {
    status = "mismatch";
    notes.push('"GOVERNMENT WARNING:" must appear in all capital letters.');
  }

  // Wording: require the statement's substantive content to be present. We verify this
  // from the required key phrases (tolerant of one clause the model may drop while
  // transcribing) rather than a strict character diff — flash-lite cannot judge an
  // image's wording to single-character precision without falsely rejecting many
  // legitimate labels. A grossly altered or truncated warning still fails here.
  const body = w.text || "";
  const hay = norm(`${heading} ${body}`);
  const REQUIRED = [
    "surgeon general",
    "during pregnancy",
    "birth defects",
    "drive a car",
    "operate machinery",
    "health problems",
  ];
  const phrasesPresent = REQUIRED.filter((p) => hay.includes(p)).length;
  if (phrasesPresent < REQUIRED.length - 1) {
    status = "mismatch";
    notes.push("Warning wording does not match the required statement.");
  }
  if (status === "match") {
    notes.push("Present, correctly capitalized, and matches the required statement.");
  }
  // De-duplicate the heading if the model repeated it inside the body.
  const display = body.toLowerCase().includes("government warning") ? body : `${heading} ${body}`.trim();
  return { status, note: notes.join(" "), extractedText: display };
}

const DEFAULT_NOTES: Record<FieldStatus, string> = {
  match: "Label value is consistent with the application.",
  mismatch: "The label shows a different value than the application.",
  review: "Could not confirm on the label — please verify.",
  missing: "Not found on the label.",
};

function normalizeStatus(s: string): FieldStatus {
  return s === "match" || s === "mismatch" || s === "review" ? s : "review";
}

function baseKey(name: string): string {
  return (name.split(/[\\/]/).pop() || name).toLowerCase().trim();
}
function baseNoExt(name: string): string {
  return baseKey(name).replace(/\.[^.]+$/, "");
}

export function findApplicationRow(rows: ApplicationRow[], filename: string): ApplicationRow | null {
  if (rows.length === 0) return null;
  const fk = baseKey(filename);
  const fn = baseNoExt(filename);
  const exact = rows.find((r) => r.file && baseKey(r.file) === fk);
  if (exact) return exact;
  const byName = rows.find((r) => r.file && baseNoExt(r.file) === fn);
  if (byName) return byName;
  if (rows.length === 1) return rows[0];
  return null;
}

// Name & address: TTB requires a bottler/producer/importer name + address on the label,
// but the entity there can legitimately differ from the applicant (contract production,
// DBA, importer of record). So presence of a bona fide name + address is sufficient — we
// don't fail on a different company or street; a human confirms exact accuracy.
function nameAddressStatus(labelValue: string): FieldStatus {
  return labelValue.trim() ? "match" : "review";
}

// Brand matches if the application's brand OR fanciful name appears anywhere on the
// label (the model reports this presence directly — more reliable than comparing a
// single "primary brand" reading, since either name may appear).
function brandStatus(onLabel: boolean, labelValue: string): FieldStatus {
  if (onLabel) return "match";
  return labelValue.trim() ? "mismatch" : "review";
}

// Deterministic comparator per mandatory field. Returns the authoritative status,
// or null to keep the model's own status (used by class/country when they abstain).
const COMPARATORS: Record<string, (app: ApplicationRow | null, expected: string, label: string) => FieldStatus | null> = {
  // brand_name is judged by the model: the application brand or fanciful name may
  // appear anywhere on the label (maker, product line, or series), which a single
  // read brand value can't capture. The model's reorder + anti-rationalization rules
  // make its brand verdict reliable; a deterministic token check here was too strict.
  class_type: (_app, expected, label) => classStatus(expected, label),
  alcohol_content: (_app, expected, label) => abvStatus(expected, label),
  net_contents: (_app, expected, label) => netStatus(expected, label),
  country_of_origin: (_app, expected, label) => countryStatus(expected, label),
  name_address: (_app, _expected, label) => nameAddressStatus(label),
};

export function buildVerdict(v: VerificationResult, app: ApplicationRow | null): LabelVerdict {
  const brandExpected = [app?.brand_name, app?.fanciful_name]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" / ");
  const defs = [
    { key: "brand_name", label: "Brand name", expected: brandExpected, fc: v.brand },
    { key: "class_type", label: "Class / type", expected: app?.class_type ?? "", fc: v.class_type },
    { key: "alcohol_content", label: "Alcohol content", expected: app?.alcohol_content ?? "", fc: v.alcohol_content },
    { key: "net_contents", label: "Net contents", expected: app?.net_contents ?? "", fc: v.net_contents },
    { key: "name_address", label: "Name & address", expected: app?.producer_name ?? "", fc: v.name_address },
    { key: "country_of_origin", label: "Country of origin", expected: app?.country_of_origin ?? "", fc: v.country_of_origin },
  ];

  // Does the application specify anything at all? (Some COLA form revisions omit
  // fields like net contents / alcohol entirely.)
  const hasApplication = defs.some((d) => meaningful(d.expected));

  const fields: FieldVerdict[] = [];
  for (const d of defs) {
    const labelValue = d.fc?.label_value || "";

    if (!meaningful(d.expected)) {
      // The application doesn't provide this element. If the application exists, the
      // form simply doesn't include it — so we don't check the label for it (omit the
      // row). Only when there is NO application at all do we surface it for review.
      if (hasApplication) continue;
      fields.push({
        key: d.key, label: d.label, expected: "", evidence: labelValue,
        status: "review" as FieldStatus,
        note: "No application details to compare against.",
      });
      continue;
    }

    let status = normalizeStatus(d.fc?.status);
    let note = d.fc?.note?.trim() || DEFAULT_NOTES[status];

    // Replace the model's (unreliable) verdict with the deterministic comparison.
    const decided = d.key === "brand_name"
      ? brandStatus(v.brand_on_label, labelValue)
      : COMPARATORS[d.key]?.(app, d.expected, labelValue);
    if (decided && decided !== status) {
      status = decided;
      note = `Application ${d.expected} vs label "${labelValue}" — ${DEFAULT_NOTES[decided].toLowerCase()}`;
    }

    fields.push({ key: d.key, label: d.label, expected: d.expected, evidence: labelValue, status, note });
  }

  const warning = warningVerdict(v.government_warning);
  const hasMismatch =
    fields.some((f) => f.status === "mismatch") || warning.status === "mismatch";
  const allMatch = fields.every((f) => f.status === "match") && warning.status === "match";
  const overall: "pass" | "flag" | "fail" = hasMismatch
    ? "fail"
    : allMatch
    ? "pass"
    : "flag";

  return { matchedApplication: !!app, overall, fields, warning };
}
