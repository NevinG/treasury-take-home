// Fully-local fallback engine — NO outbound network traffic.
//  - parseApplicationLocal: deterministic parser for labeled application text
//  - verifyLabelLocal:      offline OCR (tesseract.js) of the label image(s)
//
// Used when the user enables "offline mode" (or when GEMINI_API_KEY is unset), for
// networks that block outbound calls to cloud ML endpoints. Accuracy is lower than
// the cloud engine — it's a best-effort fallback that keeps the tool usable offline.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createWorker, type Worker } from "tesseract.js";
import type { ApplicationRow, FieldCheck, VerificationResult, WarningReading } from "./types";
import type { ExpectedValues } from "./gemini";

// English model lives in backend/ocr-data (downloaded once; see scripts/fetch-ocr-model).
const OCR_DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ocr-data");

let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, { langPath: OCR_DATA, cachePath: OCR_DATA, gzip: false });
  }
  return workerPromise;
}

// ---------------------------------------------------------------------------
// Application text -> fields (deterministic; handles "Label: value" lines such
// as our <id>.txt format and most pasted key/value text)
// ---------------------------------------------------------------------------

function fieldFrom(text: string, labels: string[]): string {
  for (const lab of labels) {
    const re = new RegExp(`(?:^|\\n)[^\\n:]*\\b${lab}\\b[^\\n:]*:\\s*([^\\n]*)`, "i");
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

export function parseApplicationLocal(raw: string): ApplicationRow[] {
  if (!raw.trim()) return [];
  return [{
    file: "",
    brand_name: fieldFrom(raw, ["brand name"]),
    fanciful_name: fieldFrom(raw, ["fanciful name"]),
    class_type: fieldFrom(raw, ["class/?type description", "class/?type"]),
    alcohol_content: fieldFrom(raw, ["alcohol content"]),
    net_contents: fieldFrom(raw, ["net contents"]),
    producer_name: fieldFrom(raw, ["name and address of applicant", "name and address", "applicant"]),
    country_of_origin: fieldFrom(raw, ["source of product", "country of origin", "origin"]),
  }];
}

// ---------------------------------------------------------------------------
// Label image(s) -> VerificationResult via offline OCR
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const NAME_STOP = new Set(["the", "and", "of", "by", "wine", "wines", "brand", "company", "co", "llc", "inc"]);
function appearsOnLabel(needle: string, hayNorm: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  if (hayNorm.includes(n)) return true;
  const ns = n.replace(/ /g, ""), hs = hayNorm.replace(/ /g, "");
  if (ns.length >= 4 && hs.includes(ns)) return true;
  const toks = n.split(" ").filter((t) => t.length > 2 && !NAME_STOP.has(t));
  return toks.length > 0 && toks.every((t) => hayNorm.includes(t));
}

const fc = (label_value: string): FieldCheck => ({ status: "review", label_value, note: "" });

export async function verifyLabelLocal(
  images: { data: string; mimeType: string }[],
  expected: ExpectedValues
): Promise<VerificationResult> {
  const worker = await getWorker();
  let ocr = "";
  for (const im of images) {
    const { data } = await worker.recognize(Buffer.from(im.data, "base64"));
    ocr += "\n" + data.text;
  }
  const hayNorm = norm(ocr);
  const flat = ocr.replace(/\s+/g, " ").trim();

  const alcohol = (ocr.match(/(\d{1,2}(?:[.,]\d+)?)\s*%/) || [])[0] || "";
  const volume = (ocr.match(/(\d+(?:[.,]\d+)?)\s*(ml|milliliters?|cl|l\b|liters?|litres?|gal(?:lon)?s?|fl\.?\s*oz|oz)\b/i) || [])[0] || "";
  const address = (ocr.match(/[^\n]*\b\d{5}(?:-\d{4})?\b[^\n]*/) || [])[0]?.replace(/\s+/g, " ").trim() || "";

  const wm = ocr.match(/government\s+warning\s*:?/i);
  const warning: WarningReading = {
    present: !!wm,
    heading: wm ? wm[0].trim() : "",
    text: wm ? ocr.slice(wm.index).replace(/\s+/g, " ").trim() : "",
    prefix_all_caps: wm ? /^GOVERNMENT\s+WARNING/.test(wm[0]) : false,
    legible: true, // OCR can't judge obstruction — assume legible (cloud engine handles this)
  };

  return {
    brand: fc(""),
    brand_on_label: appearsOnLabel(expected.brand_name, hayNorm) || appearsOnLabel(expected.fanciful_name, hayNorm),
    class_type: fc(flat),        // classStatus() scans free text for the major-class keyword
    alcohol_content: fc(alcohol),
    net_contents: fc(volume),
    name_address: fc(address),
    country_of_origin: fc(flat), // countryStatus() scans free text for origin / US state
    government_warning: warning,
  };
}

export async function shutdownLocal(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}
