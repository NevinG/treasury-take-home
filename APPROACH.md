# Approach

## Getting data

I started by researching COLA and found the public TTB COLA registry
(https://ttbonline.gov/colasonline/publicSearchColasBasic.do). It seemed like the best
source of real approved applications *with* label artwork to test against. Existing
online datasets didn't include the label images, so I scraped the registry myself
(`data-exploration/scrape_cola.py`) into `cola_recent_1000.csv` plus the label images.
Because the registry only contains *approved* labels, I also had to manufacture invalid
cases for testing — I do that by corrupting one application field so it contradicts the
label (see Evaluation below).

## The engine: the LLM reads, deterministic code judges

My first version asked the model to both read the label *and* decide whether each field
matched the application. It read accurately but its *judgment* was unreliable in both
directions — it would rationalize a match ("40% is a typo for 11%", "MOGIN ≈ ZEPHYR
HOLLOW") and occasionally invent a mismatch on a legitimate label.

So I split the responsibilities:

- **Model (`backend/src/gemini.ts`)** — read each mandatory element's value off the label
  and read the Government Warning verbatim with formatting/legibility flags. The schema
  lists `label_value → note → status` so the model reasons before committing.
- **Code (`backend/src/matching.ts`)** — compare each read value against the application
  with deterministic, testable rules: numeric ABV/volume, major-class mapping for
  class/type, brand token overlap (brand or fanciful name), domestic-vs-foreign origin,
  and warning presence/caps/legibility/wording.

This moved accuracy from the low 20s/30 to a consistent 30/30 on the labeled set and made
the behavior auditable instead of a black box.

## Model choice

Earlier comparisons (gemini-2.5-flash-lite vs gemini-2.5-flash, gpt-4o-mini,
claude-haiku) showed equal label-reading accuracy across models. Since the model only
*reads* now, I chose `gemini-2.5-flash-lite`: fastest (under the ~5s stakeholder bar) and
cheapest by 5–25×. With the judgment in code and the suite at the 100% ceiling, a heavier
model can't do better here.

## Evaluation

`data-exploration/model_test/evaluate.py` is the single test. It builds 15 genuine
approved labels (must not be wrongly rejected) and 15 with one corrupted application field
(must not be auto-approved), runs them through the live backend, and writes `RESULTS.md`.
The guiding metric: the only true errors are a good label hard-rejected, or a bad label
silently passed — a "needs review" outcome is acceptable (it routes to a human).

## Trade-offs / limitations

- Verification depends on a cloud API; the model call site is isolated behind one
  constant so it can be swapped for a self-hosted model in a restricted network.
- The warning check enforces presence, ALL-CAPS heading, legibility, and the required
  statement, but not single-character wording exactness — vision-LLM OCR isn't
  character-perfect, and a strict diff falsely rejects legitimate labels.
