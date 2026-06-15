import { useEffect, useMemo, useRef, useState } from "react";
import { buildBatch, runBatch, idFromImageName, type BatchItem, type ItemStatus } from "../lib/batch";
import { VerdictCard } from "./VerdictCard";
import { LabelGallery } from "./LabelGallery";
import { Lightbox } from "./Lightbox";
import { Spinner } from "./Spinner";

const STATUS_LABEL: Record<ItemStatus, string> = {
  pass: "Pass",
  flag: "Needs review",
  fail: "Does not match",
  error: "Error",
  noimages: "No images",
  pending: "Waiting…",
};
const RANK: Record<ItemStatus, number> = { fail: 0, error: 1, noimages: 2, flag: 3, pass: 4, pending: 5 };
type Filter = "all" | "pass" | "flag" | "fail" | "noapp" | "noimg";
const CONCURRENCY = 5;
const PAGE_SIZE = 20;

const isImageFile = (f: File) =>
  f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
const isAcceptable = (f: File) => isImageFile(f) || /\.(txt|csv)$/i.test(f.name);
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

export function VerifyFlow({ offline }: { offline: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [base, setBase] = useState<BatchItem[]>([]);
  const [hasAppFiles, setHasAppFiles] = useState(false);
  const [imageGroups, setImageGroups] = useState(0);
  const [building, setBuilding] = useState(false);
  const [manualText, setManualText] = useState("");

  const [phase, setPhase] = useState<"upload" | "results">("upload");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  const [appModal, setAppModal] = useState(false);
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  // Rebuild the detected applications whenever the uploaded files change.
  useEffect(() => {
    let cancelled = false;
    if (!files.length) { setBase([]); setHasAppFiles(false); setImageGroups(0); return; }
    setBuilding(true);
    buildBatch(files).then((r) => {
      if (cancelled) return;
      setBase(r.items);
      setHasAppFiles(r.hasAppFiles);
      setImageGroups(r.imageGroupCount);
      setBuilding(false);
    });
    return () => { cancelled = true; };
  }, [files]);

  // Single-product paste mode: no application files and at most one set of images.
  // Otherwise we're matching many applications from files (batch mode).
  const singleMode = !hasAppFiles && imageGroups <= 1;
  const singleImages = singleMode ? (base[0]?.images ?? []) : [];

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
        if (/\.(txt|csv)$/i.test(f.name) && stem === id) return false;
        return true;
      })
    );
  }

  function clearAll() {
    setFiles([]);
    setManualText("");
    setBase([]);
    setHasAppFiles(false);
    setImageGroups(0);
  }

  function start() {
    const toRun: BatchItem[] = singleMode
      ? [{ ...(base[0] as BatchItem), appText: manualText, hasAppData: !!manualText.trim(), status: "pending" }]
      : base.map((it) => ({ ...it, status: "pending" }));
    setItems(toRun);
    setSelectedId(null);
    setFilter("all");
    setPage(1);
    setPhase("results");
    setRunning(true);
    runBatch(toRun, CONCURRENCY, offline, (id, patch) =>
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
    ).finally(() => setRunning(false));
  }

  const counts = useMemo(() => {
    const c = { pass: 0, flag: 0, fail: 0, error: 0, noimages: 0, pending: 0, noapp: 0 };
    for (const it of items) {
      c[it.status]++;
      if (it.hasImages && !it.hasAppData) c.noapp++;
    }
    return c;
  }, [items]);
  const done = items.filter((it) => it.status !== "pending").length;
  const usedFallback = items.some((it) => it.engine === "local-fallback");

  const visible = useMemo(() => {
    const f = items.filter((it) => {
      if (filter === "all") return true;
      if (filter === "fail") return it.status === "fail" || it.status === "error";
      if (filter === "noapp") return it.hasImages && !it.hasAppData;
      if (filter === "noimg") return it.status === "noimages";
      return it.status === filter;
    });
    return [...f].sort((a, b) => RANK[a.status] - RANK[b.status] || a.id.localeCompare(b.id));
  }, [items, filter]);

  useEffect(() => setPage(1), [filter]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const isSingleResult = phase === "results" && items.length === 1;
  const viewId = phase === "results" ? (isSingleResult ? items[0]?.id : selectedId) : null;
  const viewed = items.find((it) => it.id === viewId) || null;

  // Object URLs for the application currently shown in detail.
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
        {viewed.engine === "local-fallback" && (
          <div className="fallback-banner">Cloud engine was unavailable — verified with the offline engine (lower accuracy).</div>
        )}

        <h4 className="detail-section">Label images</h4>
        {viewed.images.length ? (
          <LabelGallery images={viewed.images} previews={previews} busy={viewed.status === "pending"} onOpen={setLightbox} />
        ) : (
          <p className="note">No label images were uploaded for this application.</p>
        )}

        <h4 className="detail-section">Verification</h4>
        {viewed.status === "noimages" ? (
          <div className="error-banner">Can't verify — no label images were uploaded for this application.</div>
        ) : viewed.verdict ? (
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
        {usedFallback && (
          <div className="fallback-banner">
            Cloud engine was unavailable for some applications — they were verified with the offline
            engine (lower accuracy).
          </div>
        )}
        <div className="batch-summary">
          <SummaryChip label="All" n={items.length} active={filter === "all"} onClick={() => setFilter("all")} tone="all" />
          <SummaryChip label="Pass" n={counts.pass} active={filter === "pass"} onClick={() => setFilter("pass")} tone="pass" />
          <SummaryChip label="Needs review" n={counts.flag} active={filter === "flag"} onClick={() => setFilter("flag")} tone="flag" />
          <SummaryChip label="Does not match" n={counts.fail + counts.error} active={filter === "fail"} onClick={() => setFilter("fail")} tone="fail" />
          {counts.noapp > 0 && (
            <SummaryChip label="No application" n={counts.noapp} active={filter === "noapp"} onClick={() => setFilter("noapp")} tone="muted" />
          )}
          {counts.noimages > 0 && (
            <SummaryChip label="No images" n={counts.noimages} active={filter === "noimg"} onClick={() => setFilter("noimg")} tone="muted" />
          )}
          <button className="linkbtn" style={{ marginLeft: "auto" }} onClick={() => setPhase("upload")}>
            ← Back to upload
          </button>
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
                <td className="issues-cell">{issueText(it)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No applications in this view.</td></tr>
            )}
          </tbody>
        </table>

        {pageCount > 1 && (
          <div className="pager">
            <button className="btn secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>← Prev</button>
            <span className="pager-info">
              Page {currentPage} of {pageCount}
              <span className="muted"> · showing {pageRows.length} of {visible.length}</span>
            </span>
            <button className="btn secondary" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Next →</button>
          </div>
        )}
      </>
    );
  }

  // ---------------- Upload ----------------
  // Images are required (nothing to read without them); the application is optional —
  // with no application we still read the label and check the Government Warning.
  const canVerify = singleMode ? singleImages.length > 0 : base.some((i) => i.hasImages);

  return (
    <section className="step">
      <div className="step-head">
        <span className={`step-num ${canVerify ? "done" : ""}`}>1</span>
        <div>
          <h3>Upload label images &amp; application</h3>
          <span className="hint">
            Verify one product — or many at once. Drop label images and (optionally) application
            <code>.txt</code>/<code>.csv</code> files in any order; everything you add accumulates.
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

      <div className="actions">
        <button className="btn secondary" onClick={() => fileInput.current?.click()}>Add files</button>
        {singleMode && (
          <button className="btn secondary" onClick={() => { setDraft(manualText); setAppModal(true); }}>
            {manualText.trim() ? "Edit application details" : "Add application details"}
          </button>
        )}
        {!!files.length && <button className="linkbtn" onClick={clearAll}>Clear all</button>}
      </div>

      {building && <div className="loading-row"><Spinner /> Reading files…</div>}

      {!building && !singleMode && <BatchUpload base={base} onRemove={removeApp} />}

      {!building && (files.length > 0 || manualText.trim()) && (
        <div className="actions">
          <button className="btn" disabled={!canVerify} onClick={start}>
            {singleMode
              ? "Verify label"
              : `Verify ${base.filter((i) => i.hasImages).length} application${base.filter((i) => i.hasImages).length === 1 ? "" : "s"}`}
          </button>
          {singleMode && singleImages.length === 0 && (
            <span className="hint">Add the label image(s) to verify.</span>
          )}
          {singleMode && singleImages.length > 0 && !manualText.trim() && (
            <span className="hint">No application details — we'll read the label and check the Government Warning. Add details to compare each field.</span>
          )}
        </div>
      )}

      {appModal && (
        <div className="modal-backdrop" onClick={() => setAppModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Application details</h3>
            <p className="hint">Paste the application values for this product — the AI reads them; no fixed format.</p>
            <textarea
              className="appinput"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={"Brand Name: OLD TOM DISTILLERY\nClass/Type: Kentucky Straight Bourbon Whiskey\nAlcohol Content: 45% Alc./Vol.\nNet Contents: 750 mL\n..."}
            />
            <div className="actions">
              <button className="btn" onClick={() => { setManualText(draft); setAppModal(false); }}>Save</button>
              <button className="btn secondary" onClick={() => setAppModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function issueText(it: BatchItem) {
  if (it.status === "noimages") return "No label images uploaded";
  if (it.status === "error") return <span className="chip mismatch">{it.error}</span>;
  if (it.status === "pending") return null;
  if (it.hasImages && !it.hasAppData) return <span className="muted">No application data — flagged for review</span>;
  if (it.status === "pass") return <span className="muted">All elements match</span>;
  return it.issues && it.issues.length ? it.issues.join(", ") : <span className="muted">—</span>;
}

function BatchUpload({ base, onRemove }: { base: BatchItem[]; onRemove: (id: string) => void }) {
  if (!base.length) return null;
  const noApp = base.filter((i) => i.hasImages && !i.hasAppData).length;
  const noImg = base.filter((i) => !i.hasImages).length;
  return (
    <>
      <div className="app-list">
        {base.map((it) => (
          <div className="app-chip" key={it.id}>
            <span className="mono">{it.id}</span>
            <span className="muted">{it.images.length} image{it.images.length === 1 ? "" : "s"}</span>
            <span className={`data-flag ${it.hasImages ? "ok" : "no"}`}>{it.hasImages ? "images ✓" : "no images"}</span>
            <span className={`data-flag ${it.hasAppData ? "ok" : "no"}`}>{it.hasAppData ? "application ✓" : "no application"}</span>
            <button className="chip-x" title="Remove" onClick={() => onRemove(it.id)}>×</button>
          </div>
        ))}
      </div>
      {(noApp > 0 || noImg > 0) && (
        <p className="note">
          {noApp > 0 && `${noApp} application(s) have no matching .txt/.csv and will be flagged for review. `}
          {noImg > 0 && `${noImg} application(s) have no images and can't be verified.`}
        </p>
      )}
    </>
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
