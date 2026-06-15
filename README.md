# TTB Label Verification

AI-assisted verification that an alcohol beverage label matches its TTB application.
Upload the label image(s) and the application details and get a clear, field-by-field
result — including the mandatory Government Warning. Verify one product or a whole batch
in the same screen.

- **Frontend:** React SPA (Vite + TypeScript)
- **Backend:** Express + TypeScript (Node)
- **AI:** Google Gemini (`gemini-2.5-flash-lite`) via the `@google/genai` SDK
- **Deployed app:** _<add your deployed URL here>_
- **Approach write-up:** [APPROACH.md](APPROACH.md)

## How it works

**The LLM reads; deterministic code judges.** This split is the core design decision:
the model is excellent at *reading* a label, but its match/mismatch *judgment* was
unreliable (it would rationalize "40% is a typo for 11%"). So:

1. `gemini-2.5-flash-lite` parses the pasted/uploaded application text into fields.
2. `gemini-2.5-flash-lite` reads every uploaded label panel in one pass and returns,
   per mandatory element, the exact value printed on the label (plus the Government
   Warning, verbatim, with formatting/legibility flags).
3. `backend/src/matching.ts` compares each element with **deterministic rules** and
   produces a verdict of **Match / Mismatch / Review** per field, and an overall
   **PASS / NEEDS REVIEW / DOES NOT MATCH**.

Mandatory elements checked: brand name (incl. fanciful name), class/type, alcohol
content, net contents, name & address of bottler/producer, country of origin, and the
Government Warning. The comparison is deliberate:

- **Alcohol & net contents** compare numerically (unit/format tolerant; net contents may
  list several allowed sizes).
- **Class/type** maps both sides to a major TTB class (wine / spirits / malt) so the
  application's broad category matches the label's specific style.
- **Brand** matches on a shared significant word or spelling/spacing variant of the brand
  *or* fanciful name (so "STONE'S THROW" matches "Stone's Throw", "PINDAR VINEYARDS"
  matches "Pindar").
- **Country of origin** fails a domestic application contradicted by a foreign origin on
  the label.
- **Government Warning** must be present, ALL-CAPS in the heading, legible (not scribbled
  over/obscured), and contain the required statement.
- A missing application value is **Review** (never a silent match).

## Single or batch — one flow

Upload label images (and optionally application `.txt`/`.csv` files). Images are grouped
into applications by file name (`<id>_<n>.jpg`). The app adapts automatically:

- **One application** → a rich single result (full-size label images + the field-by-field
  verdict). Paste that product's application details inline.
- **Many applications** → a triage table with **Pass / Needs review / Does not match**
  filter chips and pagination; click any row to open that application's images and verdict.
  Application data is matched per id from a `.txt` (named `<id>.txt`) or a `.csv` with a
  `ttb_id` column.

Uploads are additive — add more files anytime; nothing is overwritten.

## Setup

Requires Node 18+ and a Google Gemini API key (https://aistudio.google.com/apikey).

### Backend

```bash
cd backend
npm install
cp .env.example .env        # then set GEMINI_API_KEY
npm run dev                 # http://localhost:3001
```

### Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173  (proxies /api to the backend)
```

Open http://localhost:5173.

## Test data

Real approved applications scraped from the public TTB COLA registry (label images +
per-application `.txt` files + a ready-made `batch_sample/`) are shipped as a ~490 MB zip,
**split into 6 parts** so each stays under GitHub's 100 MB file limit:
`data-exploration/dataset.zip.001` … `dataset.zip.006`.

Reassemble and unzip them in place:

```bash
# macOS / Linux
cd data-exploration
cat dataset.zip.0* > dataset.zip
unzip dataset.zip            # restores label_images/, application/, batch_sample/
```

```powershell
# Windows PowerShell
cd data-exploration
cmd /c "copy /b dataset.zip.001+dataset.zip.002+dataset.zip.003+dataset.zip.004+dataset.zip.005+dataset.zip.006 dataset.zip"
Expand-Archive dataset.zip -DestinationPath .
```

This restores `data-exploration/label_images/`, `application/`, and `batch_sample/`.
To try batch mode in the UI, choose **Add a folder** and pick `data-exploration/batch_sample/`
(a deliberate mix of pass / needs-review / does-not-match).

> Only the `.001`–`.006` parts are tracked; the reassembled `dataset.zip` and the unzipped
> folders are git-ignored.

## API

- `GET  /api/health` → `{ ok: true }`
- `POST /api/verify` — multipart: `images` (one or more files) + `applicationText`
  (string; may be empty) → `{ reading, verdict }`. Verifies one application's label
  against its application; the frontend calls this once per application in a batch.

## Evaluation

`data-exploration/model_test/evaluate.py` is the single evaluation script. It builds a
labeled set of ~30 cases (15 genuine approved labels + 15 with one application field
corrupted to contradict the label), runs them through the live backend, and writes
[`RESULTS.md`](data-exploration/model_test/RESULTS.md). The engine scores 100% on this
set: no good label wrongly rejected, no bad label auto-approved.

```bash
cd backend && npm run dev          # in one terminal
cd data-exploration/model_test
python evaluate.py --seed 7 --fresh
```

See [`data-exploration/`](data-exploration/) for how the dataset was produced (the COLA
scraper, per-application `.txt` builder, and a ready-made `batch_sample/` for trying batch
mode).

## Assumptions

- **Multi-panel uploads.** All images for one product are uploaded together; in a batch,
  images are grouped into applications by filename (`<id>_<n>.jpg`).
- **Application data is flexible.** It may be pasted free-form, or supplied as a `.txt`
  (named `<id>.txt`) or a `.csv` with a `ttb_id` column; a cheap LLM call parses it.
- **TTB database vs. label wording differ.** Application values (e.g. class/type) are
  often broader/internal categories; the engine matches on meaning, not exact strings.
- **"Needs review" is a valid outcome.** When a value isn't visible on the imaged panels
  or can't be confirmed, the tool flags it for a human rather than guessing — it assists
  agents, it doesn't replace them.
- **Prototype scope.** No persistence/auth; the deployment is a standalone proof of
  concept, not integrated with COLA.

## Notes & trade-offs

- **Cloud dependency.** Verification calls Google's API. A production deployment behind a
  restricted network would swap the single `MODEL` constant in `backend/src/gemini.ts`
  for an approved/self-hosted vision model — the call site is isolated.
- **Government Warning wording.** Presence, capitalization, legibility, and the required
  statement are enforced; a *single-character* wording change is not reliably caught,
  because vision-LLM OCR isn't character-perfect and a strict diff falsely rejects many
  legitimate labels. Such edge cases surface as Needs review for a human.
- **Speed.** `gemini-2.5-flash-lite` keeps a single verification under the ~5s bar the
  stakeholders required; batches run several in parallel.
