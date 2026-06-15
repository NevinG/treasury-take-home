import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildBatch,
  runBatch,
  idFromImageName,
  type BatchItem,
  type ItemStatus,
} from "../lib/batch";
import { VerdictCard } from "./VerdictCard";
import { LabelGallery } from "./LabelGallery";
import { Lightbox } from "./Lightbox";
import { Spinner } from "./Spinner";

const STATUS_LABEL: Record<ItemStatus, string> = {
  pass: "Pass",
  flag: "Needs review",
  fail: "Does not match",
  error: "Error",
  pending: "Waiting…",
};
const RANK: Record<ItemStatus, number> = { fail: 0, error: 1, flag: 2, pass: 3, pending: 4 };
type Filter = "all" | "pass" | "flag" | "fail";
const CONCURRENCY = 5;
const PAGE_SIZE = 20;

const isImageFile = (f: File) =>
  f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
const isAcceptable = (f: File) => isImageFile(f) || /\.(txt|csv)$/i.test(f.name);
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export function VerifyFlow() {
  const [files, setFiles] = useState<File[]>([]);
  const [base, setBase] = useState<BatchItem[]>([]);
  const [unmatched, setUnmatched] = useState(0); // app records uploaded without images
  const [building, setBuilding] = useState(false);
  const [manualText, setManualText] = useState("");
  const manualTouched = useRef(false);

  const [phase, setPhase] = useState<"upload" | "results">("upload");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  // Rebuild the detected applications whenever the uploaded files change.
  useEffect(() => {
    let cancelled = false;
    if (!files.length) { setBase([]); setUnmatched(0); return; }
    setBuilding(true);
    buildBatch(files).then((r) => {
      if (cancelled) return;
      setBase(r.items);
      setUnmatched(r.unmatchedApps);
      setBuilding(false);
    });
    return () => { cancelled = true; };
  }, [files]);

  // For a single application, prefill the paste box from a matched .txt (once),
  // unless the user has typed their own text.
  useEffect(() => {
    if (!manualTouched.current && base.length === 1 && base[0].appText) setManualText(base[0].appText);
  }, [base]);

  const single = base.length === 1;

  function addFiles(incoming: File[]) {
    const accepted = incoming.filter(isAcceptable);
    if (!accepted.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      const merged = [...prev];
      for (const f of accepted) if (!seen.has(fileKey(f))) { merged.push(f); seen.add(fileKey(f)); }
      return merged;
    });
  }

  function removeApp(id: string) {
    setFiles((prev) =>
      prev.filter((f) => {
        if (isImageFile(f) && idFromImageName(f.name) === id) return false;
        const stem = (f.name.split(/[\\/]/).pop() || f.name).replace(/\.[^.]+$/, "");
        if (/\.txt$/i.test(f.name) && stem === id) return false;
        return true;
      })
    );
  }

  function clearAll() {
    setFiles([]);
    setManualText("");
    manualTouched.current = false;
    setBase([]);
    setUnmatched(0);
  }

  function start() {
    const finalItems = base.map((it) => {
      const appText = single ? (manualText.trim() || it.appText) : it.appText;
      return { ...it, appText, hasAppData: !!appText.trim(), status: "pending" as ItemStatus };
    });
    setItems(finalItems);
    setSelectedId(null);
    setFilter("all");
    setPage(1);
    setPhase("results");
    setRunning(true);
    runBatch(finalItems, CONCURRENCY, (id, patch) =>
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
    ).finally(() => setRunning(false));
  }

  const counts = useMemo(() => {
    const c = { pass: 0, flag: 0, fail: 0, error: 0, pending: 0 };
    for (const it of items) c[it.status]++;
    return c;
  }, [items]);
  const done = items.length - counts.pending;

  const visible = useMemo(() => {
    const f = items.filter((it) => {
      if (filter === "all") return true;
      if (filter === "fail") return it.status === "fail" || it.status === "error";
      return it.status === filter;
    });
    return [...f].sort((a, b) => RANK[a.status] - RANK[b.status] || a.id.localeCompare(b.id));
  }, [items, filter]);

  // Pagination over the filtered rows.
  useEffect(() => setPage(1), [filter]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const isSingleResult = phase === "results" && items.length === 1;
  const viewId = phase === "results" ? (isSingleResult ? items[0]?.id : selectedId) : null;
  const viewed = items.find((it) => it.id === viewId) || null;

  // Object URLs for the application currently being viewed in detail.
  useEffect(() => {
    if (!viewed) { setPreviews({}); return; }
    const map: Record<string, string> = {};
    viewed.images.forEach((f) => (map[f.name] = URL.createObjectURL(f)));
    setPreviews(map);
    return () => Object.values(map).forEach((u) => URL.revokeObjectURL(u));
  }, [viewId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- Detail / single result ----------------
  if (viewed) {
    return (
      <>
        <button className="linkbtn" onClick={() => (isSingleResult ? setPhase("upload") : setSelectedId(null))}>
          {isSingleResult ? "← Back to upload" : "← Back to results"}
        </button>
        <div className="detail-head">
          <div>
            <h2 className="detail-id">{viewed.id}</h2>
            {viewed.brand && <span className="detail-brand">{viewed.brand}</span>}
          </div>
          {viewed.status !== "pending" && (
            <span className={`badge ${viewed.status}`}>{STATUS_LABEL[viewed.status]}</span>
          )}
        </div>

        <h4 className="detail-section">Label images</h4>
        <LabelGallery images={viewed.images} previews={previews} busy={viewed.status === "pending"} onOpen={setLightbox} />

        <h4 className="detail-section">Verification</h4>
        {viewed.verdict ? (
          <VerdictCard verdict={viewed.verdict} />
        ) : viewed.error ? (
          <div className="error-banner">{viewed.error}</div>
        ) : (
          <div className="loading-row"><Spinner /> Checking the label against the application…</div>
        )}

        {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </>
    );
  }

  // ---------------- Batch results table ----------------
  if (phase === "results") {
    return (
      <>
        <div className="batch-summary">
          <SummaryChip label="All" n={items.length} active={filter === "all"} onClick={() => setFilter("all")} tone="all" />
          <SummaryChip label="Pass" n={counts.pass} active={filter === "pass"} onClick={() => setFilter("pass")} tone="pass" />
          <SummaryChip label="Needs review" n={counts.flag} active={filter === "flag"} onClick={() => setFilter("flag")} tone="flag" />
          <SummaryChip label="Does not match" n={counts.fail + counts.error} active={filter === "fail"} onClick={() => setFilter("fail")} tone="fail" />
          <span style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
            <button className="linkbtn" onClick={() => setPhase("upload")}>← Add / edit</button>
            <button className="linkbtn" onClick={clearAll}>New</button>
          </span>
        </div>

        {running && (
          <div className="progress-wrap">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${(done / Math.max(items.length, 1)) * 100}%` }} />
            </div>
            <span className="hint">Verifying… {done} of {items.length} done</span>
          </div>
        )}

        <table className="batch-table">
          <thead>
            <tr><th>Status</th><th>TTB ID</th><th>Brand (on label)</th><th>Issues</th></tr>
          </thead>
          <tbody>
            {pageRows.map((it) => (
              <tr key={it.id} className="batch-row" onClick={() => setSelectedId(it.id)}>
                <td>
                  {it.status === "pending"
                    ? <span className="row-pending"><Spinner /> </span>
                    : <span className={`badge ${it.status}`}>{STATUS_LABEL[it.status]}</span>}
                </td>
                <td className="mono">{it.id}</td>
                <td>{it.brand || <span className="muted">—</span>}</td>
                <td className="issues-cell">
                  {it.status === "pass" && <span className="muted">All elements match</span>}
                  {it.status === "error" && <span className="chip mismatch">{it.error}</span>}
                  {it.issues && it.issues.length > 0 ? it.issues.join(", ") : null}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No applications in this view.</td></tr>
            )}
          </tbody>
        </table>

        {pageCount > 1 && (
          <div className="pager">
            <button className="btn secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
              ← Prev
            </button>
            <span className="pager-info">
              Page {currentPage} of {pageCount}
              <span className="muted"> · showing {pageRows.length} of {visible.length}</span>
            </span>
            <button className="btn secondary" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
              Next →
            </button>
          </div>
        )}
      </>
    );
  }

  // ---------------- Upload ----------------
  return (
    <section className="step">
      <div className="step-head">
        <span className={`step-num ${base.length ? "done" : ""}`}>1</span>
        <div>
          <h3>Upload label images</h3>
          <span className="hint">
            Drop the label images for one product — or many products at once. Add application details
            below (or include a <code>.txt</code>/<code>.csv</code>). Upload more anytime; files add up.
          </span>
        </div>
      </div>

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); }}
      >
        <p className="big">Drop files here, or click to browse</p>
        <p>Label images (named like <code>id_1.jpg</code> to group multi-product batches) + optional .txt/.csv</p>
      </div>

      <input ref={fileInput} type="file" multiple accept="image/*,.txt,.csv" className="hidden-input"
        onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
      <input ref={dirInput} type="file" multiple className="hidden-input"
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />

      <div className="actions">
        <button className="btn secondary" onClick={() => fileInput.current?.click()}>Add files</button>
        <button className="btn secondary" onClick={() => dirInput.current?.click()}>Add a folder</button>
        {!!files.length && <button className="linkbtn" onClick={clearAll}>Clear all</button>}
      </div>

      {building && <div className="loading-row"><Spinner /> Reading files…</div>}

      {!building && base.length > 0 && (
        <>
          <div className="app-list">
            {base.map((it) => {
              const hasData = single ? !!(manualText.trim() || it.appText) : it.hasAppData;
              return (
                <div className="app-chip" key={it.id}>
                  <span className="mono">{it.id}</span>
                  <span className="muted">{it.images.length} image{it.images.length === 1 ? "" : "s"}</span>
                  <span className={`data-flag ${hasData ? "ok" : "no"}`}>{hasData ? "application ✓" : "no application"}</span>
                  <button className="chip-x" title="Remove" onClick={() => removeApp(it.id)}>×</button>
                </div>
              );
            })}
          </div>

          {single ? (
            <div className="single-app-text">
              <label className="hint" style={{ display: "block", marginBottom: 6 }}>
                Application details — paste the values for this product (the AI reads them; no fixed format).
              </label>
              <textarea
                className="appinput"
                placeholder={"Brand Name: OLD TOM DISTILLERY\nClass/Type: Kentucky Straight Bourbon Whiskey\nAlcohol Content: 45% Alc./Vol.\nNet Contents: 750 mL\n..."}
                value={manualText}
                onChange={(e) => { manualTouched.current = true; setManualText(e.target.value); }}
              />
            </div>
          ) : (
            <p className="note">
              {base.filter((i) => !i.hasAppData).length > 0
                ? `${base.filter((i) => !i.hasAppData).length} application(s) have no matching .txt/.csv and will be flagged for review.`
                : "Every application has matching application data."}
              {unmatched > 0 && ` ${unmatched} application record(s) had no images and were skipped.`}
            </p>
          )}

          <div className="actions">
            <button className="btn" onClick={start}>
              Verify {base.length} application{base.length === 1 ? "" : "s"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SummaryChip({
  label, n, active, onClick, tone,
}: { label: string; n: number; active: boolean; onClick: () => void; tone: string }) {
  return (
    <button className={`summary-chip ${tone} ${active ? "active" : ""}`} onClick={onClick}>
      <span className="summary-n">{n}</span>
      <span className="summary-label">{label}</span>
    </button>
  );
}
