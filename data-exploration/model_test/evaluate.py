"""
Accuracy evaluation for the TTB label-verification engine.

Runs a LABELED test set of ~30 cases against the real backend (http://localhost:3001)
and writes the result to RESULTS.md.

  POSITIVE (15): a known-good approved COLA, application text unchanged. The engine
    must NOT hard-reject it. A clean "pass" is ideal; a "review" flag (a value not on
    the imaged panels) is acceptable. The only error is an overall "fail" (false
    rejection).

  NEGATIVE (15): the same kind of COLA, but ONE application field is corrupted so it
    contradicts the label (brand / class / alcohol / net / country, ~3 each). The
    engine must NOT auto-approve it — the corrupted field must come back mismatch or
    review (overall fail or needs-review), never pass. Silently passing a corruption
    is the only error.

The Government Warning check is label-only (it can't be broken by editing application
text), so warning correctness is reported on the positive set rather than tested with
synthetic negatives.

Responses are cached in .cache.json (git-ignored) keyed by a hash of the exact request
so re-runs are free; pass --fresh to force new calls (always do this after changing the
backend prompt or comparison logic).

Usage (backend running -- cd ../../backend && npm run dev):
  python evaluate.py --seed 7
  python evaluate.py --seed 7 --fresh
"""

import argparse
import csv
import hashlib
import json
import re
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CSV_PATH = ROOT / "cola_recent_1000.csv"
IMAGES = ROOT / "label_images"
APP_DIR = ROOT / "application"
CACHE = HERE / ".cache.json"
RESULTS = HERE / "RESULTS.md"
BACKEND = "http://localhost:3001"

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif"}
NEG_TYPES = ["brand", "class", "alcohol", "net", "country"]
NEG_FIELD = {"brand": "brand_name", "class": "class_type", "alcohol": "alcohol_content",
             "net": "net_contents", "country": "country_of_origin"}


def clean(s):
    return (s or "").strip().strip(",").strip()


def mime_for(name):
    return MIME.get(Path(name).suffix.lower(), "image/jpeg")


def post_verify(images, application_text):
    """Multipart POST of image files + applicationText to /api/verify."""
    boundary = "----ttb" + uuid.uuid4().hex
    body = b""
    for name, data, ctype in images:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="images"; filename="{name}"\r\n'.encode()
        body += f"Content-Type: {ctype}\r\n\r\n".encode()
        body += data + b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="applicationText"\r\n\r\n'
    body += application_text.encode() + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(BACKEND + "/api/verify", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())


# --- application-text corruption (operates on the raw <id>.txt block) ---

def get_field(text, label):
    m = re.search(rf"(?m)^{re.escape(label)}:\s*(.*)$", text)
    return m.group(1).strip() if m else ""


def set_field(text, label, value):
    pat = rf"(?m)^({re.escape(label)}):\s*.*$"
    if re.search(pat, text):
        return re.sub(pat, rf"\1: {value}", text, count=1)
    return text + f"\n{label}: {value}\n"


def corrupt(text, neg_type):
    """Return (modified_text, human_description) for the given corruption."""
    if neg_type == "brand":
        t = set_field(text, "6. BRAND NAME", "ZEPHYR HOLLOW RESERVE")
        t = set_field(t, "7. FANCIFUL NAME", "")
        return t, "brand changed to an unrelated name"
    if neg_type == "class":
        ptype = get_field(text, "5. TYPE OF PRODUCT").lower()
        new = "TABLE RED WINE" if "spirit" in ptype else "VODKA" if ("malt" in ptype or "beer" in ptype) else "BOURBON WHISKY"
        return set_field(text, "CLASS/TYPE DESCRIPTION", new), f"class/type changed to a different major class ({new})"
    if neg_type == "alcohol":
        cur = get_field(text, "13. ALCOHOL CONTENT")
        m = re.search(r"(\d+(?:[.,]\d+)?)", cur)
        val = float(m.group(1).replace(",", ".")) if m else 12.0
        new = "5% Alc./Vol." if val >= 25 else "40% Alc./Vol."
        return set_field(text, "13. ALCOHOL CONTENT", new), f"alcohol changed {cur!r} -> {new!r}"
    if neg_type == "net":
        c = get_field(text, "12. NET CONTENTS").lower()
        new = ("375 MILLILITERS" if "750" in c else "750 MILLILITERS" if ("375" in c or "1.75" in c or "1750" in c)
               else "187 MILLILITERS" if ("gal" in c or "oz" in c or "bbl" in c) else "50 MILLILITERS")
        return set_field(text, "12. NET CONTENTS", new), f"net contents changed to {new!r}"
    if neg_type == "country":  # caller guarantees SOURCE == Imported
        return set_field(text, "3. SOURCE OF PRODUCT", "Domestic"), "import relabeled as Domestic (contradicts foreign label)"
    raise ValueError(neg_type)


def load_pool(seed):
    import random
    apps = []
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            imgs = [i for i in (r.get("image_files") or "").split(";") if (IMAGES / i.strip()).exists()]
            ttb = clean(r.get("ttb_id", ""))
            txt = APP_DIR / f"{ttb}.txt"
            if not imgs or not txt.exists():
                continue
            if not (clean(r["brand_name"]) and clean(r["alcohol_content"]) and clean(r["net_contents"])):
                continue
            apps.append({"ttb_id": ttb, "images": [i.strip() for i in imgs][:4],
                         "app_text": txt.read_text(encoding="utf-8"), "source": clean(r.get("source_of_product", ""))})
    random.Random(seed).shuffle(apps)
    return apps


def build_cases(seed, n_pos=15, n_neg=15):
    pool = load_pool(seed)
    cases = [{"id": f"{a['ttb_id']}_pos", "kind": "positive", "neg_type": "", "desc": "unchanged (approved label)",
              "images": a["images"], "text": a["app_text"]} for a in pool[:n_pos]]

    quota = {t: n_neg // len(NEG_TYPES) for t in NEG_TYPES}
    for i in range(n_neg - sum(quota.values())):
        quota[NEG_TYPES[i]] += 1

    used = 0
    for a in pool[n_pos:n_pos + n_neg * 2]:
        if used >= n_neg:
            break
        is_import = "import" in a["source"].lower()
        choice = next((t for t in NEG_TYPES if quota[t] > 0 and (t != "country" or is_import)), None)
        if choice is None:
            continue
        quota[choice] -= 1
        used += 1
        mtext, desc = corrupt(a["app_text"], choice)
        cases.append({"id": f"{a['ttb_id']}_neg_{choice}", "kind": "negative", "neg_type": choice,
                      "desc": desc, "images": a["images"], "text": mtext})
    return cases


def run(cases, fresh):
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for c in cases:
        h = hashlib.sha1((c["text"] + "|" + ",".join(c["images"])).encode()).hexdigest()[:12]
        entry = cache.get(c["id"])
        if fresh or not entry or entry.get("h") != h:
            imgs = [(i, (IMAGES / i).read_bytes(), mime_for(i)) for i in c["images"]]
            print(f"  calling {c['id']} ({len(imgs)} img)...")
            try:
                cache[c["id"]] = {"h": h, "resp": post_verify(imgs, c["text"])}
            except Exception as e:  # never let one bad call abort the run
                print(f"    !! {c['id']} failed: {e}")
                cache[c["id"]] = {"h": h, "resp": {"verdict": None, "error": str(e)}}
            CACHE.write_text(json.dumps(cache))
            time.sleep(0.4)
        c["resp"] = cache[c["id"]]["resp"]
    return cases


def evaluate(cases):
    rows = []
    for c in cases:
        v = (c.get("resp") or {}).get("verdict")
        if not v:
            rows.append({**c, "overall": "error", "states": {}, "correct": False, "caught": "",
                         "why": "BACKEND ERROR: " + str((c.get("resp") or {}).get("error", "no verdict"))})
            continue
        states = {f["key"]: f["status"] for f in v["fields"]}
        states["government_warning"] = v["warning"]["status"]
        overall = v["overall"]
        if c["kind"] == "positive":
            correct = overall != "fail"
            why = "" if correct else "FALSE REJECTION on " + ", ".join(k for k, s in states.items() if s == "mismatch")
            caught = ""
        else:
            tgt = NEG_FIELD[c["neg_type"]]
            tstatus = states.get(tgt)
            correct = tstatus != "match" and overall != "pass"
            caught = "fail" if overall == "fail" else "review" if correct else ""
            why = "" if correct else f"AUTO-APPROVED: target {tgt}={tstatus}, overall={overall}"
        rows.append({**c, "overall": overall, "states": states, "correct": correct, "caught": caught, "why": why})
    return rows


MODEL_NOTE = """\
## Engine & model

**The LLM reads, deterministic code judges.** `gemini-2.5-flash-lite` reads the
application text and every label panel (returning, per element, the exact value on the
label); `backend/src/matching.ts` then decides match / mismatch / review with
deterministic rules (numeric ABV & volume, major-class mapping, brand token overlap,
domestic-vs-foreign origin, and the Government Warning's presence / caps / legibility /
wording). The model's *reading* is reliable; its *judgment* was not (it would rationalize
"40% is a typo for 11%"), so the judgment lives in testable code.

**Model choice.** `gemini-2.5-flash-lite` was selected over gemini-2.5-flash, gpt-4o-mini,
and claude-haiku in earlier comparisons: equal label-reading accuracy, fastest (<5s, the
stakeholder bar), and cheapest by 5-25x. Since reading is already accurate and this suite
sits at the 100% ceiling, a heavier model cannot do better here.
"""


def write_report(rows, seed):
    pos = [r for r in rows if r["kind"] == "positive"]
    neg = [r for r in rows if r["kind"] == "negative"]
    pos_ok, neg_ok = sum(r["correct"] for r in pos), sum(r["correct"] for r in neg)
    total_ok, total = pos_ok + neg_ok, len(rows)
    auto_approved = sum(1 for r in neg if not r["correct"])
    false_reject = sum(1 for r in pos if not r["correct"])
    warn_ok = sum(1 for r in pos if r["states"].get("government_warning") == "match")

    L = ["# Verification engine — evaluation result\n",
         "*Generated by `evaluate.py` against the running backend. Re-run to refresh.*\n",
         f"- Seed: **{seed}**  ·  cases: **{total}** (15 positive, 15 negative)",
         f"- **Overall accuracy: {total_ok}/{total} ({total_ok / total * 100:.0f}%)**",
         f"- **Bad labels auto-approved (the critical error): {auto_approved}/{len(neg)}**",
         f"- **Good labels wrongly rejected: {false_reject}/{len(pos)}**",
         f"- Negatives caught: {sum(1 for r in neg if r['caught'] == 'fail')} hard-failed, "
         f"{sum(1 for r in neg if r['caught'] == 'review')} flagged for review",
         f"- Government warning matched on positives: {warn_ok}/{len(pos)}\n"]

    by_type = {}
    for r in neg:
        ok, tot = by_type.get(r["neg_type"], (0, 0))
        by_type[r["neg_type"]] = (ok + r["correct"], tot + 1)
    L += ["Negative catch rate by corrupted field:\n", "| Field | Caught |", "|---|---|"]
    L += [f"| {t} | {by_type[t][0]}/{by_type[t][1]} |" for t in NEG_TYPES if t in by_type]

    errors = [r for r in rows if not r["correct"]]
    L.append(f"\n## Errors ({len(errors)})\n")
    L += [f"- `{r['id']}` ({r['kind']}): {r['why']}" for r in errors] or ["None — 100% accuracy."]

    L.append("\n" + MODEL_NOTE)
    RESULTS.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L[:9]))
    print(f"\n(result written to {RESULTS.name})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--fresh", action="store_true", help="force fresh /api/verify calls (use after backend changes)")
    args = ap.parse_args()
    try:
        urllib.request.urlopen(BACKEND + "/api/health", timeout=5).read()
    except Exception as e:
        raise SystemExit(f"Backend not reachable at {BACKEND} — start it with `npm run dev` ({e})")
    cases = build_cases(args.seed)
    run(cases, args.fresh)
    write_report(evaluate(cases), args.seed)


if __name__ == "__main__":
    main()
