// Batch verification helpers: group dropped files into applications, match each to
// its application text, and run them through /api/verify with bounded concurrency.
import { verify } from "../api";
import type { LabelVerdict, VerifyResponse } from "../types";

export type Overall = "pass" | "flag" | "fail";
export type ItemStatus = Overall | "pending" | "error" | "noimages";

export interface BatchItem {
  id: string;
  images: File[];
  appText: string;
  hasImages: boolean;
  hasAppData: boolean;
  status: ItemStatus;
  brand?: string;
  verdict?: LabelVerdict;
  issues?: string[];
  error?: string;
}

const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
const isTxt = (f: File) => /\.txt$/i.test(f.name);
const isCsv = (f: File) => /\.csv$/i.test(f.name);

/** Application id from an image filename: the part before the first underscore
 *  (our labels are <ttb_id>_<n>.jpg), else the whole stem. */
export function idFromImageName(name: string): string {
  const base = name.split(/[\\/]/).pop() || name;
  const stem = base.replace(/\.[^.]+$/, "");
  const i = stem.indexOf("_");
  return i > 0 ? stem.slice(0, i) : stem;
}

/** Minimal CSV parser that respects quoted fields and embedded newlines/commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* ignore */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export interface BuildResult {
  items: BatchItem[];
  hasAppFiles: boolean; // any .txt/.csv was uploaded
  imageGroupCount: number; // distinct applications that have images
}

/** Turn an arbitrary set of dropped files into one BatchItem per application —
 *  the UNION of ids seen in image names and in application files, so it works no
 *  matter which the user uploads first. */
export async function buildBatch(files: File[]): Promise<BuildResult> {
  const images = files.filter(isImage);
  const txts = files.filter(isTxt);
  const csvs = files.filter(isCsv);

  const groups = new Map<string, File[]>();
  for (const f of images) {
    const id = idFromImageName(f.name);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(f);
  }

  // Application text by id — CSV rows first, then .txt files (which take precedence).
  const appText = new Map<string, string>();
  for (const c of csvs) {
    const rows = parseCsv(await c.text());
    if (rows.length < 2) continue;
    const header = rows[0];
    const idIdx = header.findIndex((h) => /^\s*(ttb_?id|id)\s*$/i.test(h));
    if (idIdx < 0) continue;
    for (let r = 1; r < rows.length; r++) {
      const id = (rows[r][idIdx] || "").trim();
      if (!id) continue;
      const txt = header.map((h, j) => `${h.trim()}: ${(rows[r][j] || "").trim()}`).join("\n");
      appText.set(id, txt);
    }
  }
  for (const t of txts) {
    const id = (t.name.split(/[\\/]/).pop() || t.name).replace(/\.[^.]+$/, "");
    appText.set(id, await t.text());
  }

  const ids = new Set<string>([...groups.keys(), ...appText.keys()]);
  const items: BatchItem[] = [...ids].sort().map((id) => ({
    id,
    images: (groups.get(id) || []).sort((a, b) => a.name.localeCompare(b.name)),
    appText: appText.get(id) || "",
    hasImages: groups.has(id),
    hasAppData: appText.has(id),
    status: "pending" as ItemStatus,
  }));

  return { items, hasAppFiles: txts.length + csvs.length > 0, imageGroupCount: groups.size };
}

export function summarizeIssues(v: LabelVerdict): string[] {
  const out: string[] = [];
  for (const f of v.fields) if (f.status !== "match") out.push(`${f.label} (${f.status})`);
  if (v.warning.status !== "match") out.push(`Government warning (${v.warning.status})`);
  return out;
}

/** Run all items through /api/verify, at most `concurrency` at a time, reporting
 *  each result as it lands so the UI can fill in live. */
export async function runBatch(
  items: BatchItem[],
  concurrency: number,
  offline: boolean,
  onUpdate: (id: string, patch: Partial<BatchItem>) => void
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const it = items[idx++];
      if (!it.images.length) {
        onUpdate(it.id, { status: "noimages" }); // can't verify a label with no image
        continue;
      }
      try {
        const res: VerifyResponse = await verify(it.images, it.appText, offline);
        const brand = res.verdict.fields.find((f) => f.key === "brand_name")?.evidence;
        onUpdate(it.id, {
          status: res.verdict.overall,
          brand: brand || undefined,
          verdict: res.verdict,
          issues: summarizeIssues(res.verdict),
        });
      } catch (e) {
        onUpdate(it.id, { status: "error", error: e instanceof Error ? e.message : "Failed" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
