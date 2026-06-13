"""
TTB Public COLA Registry scraper.

Collects the N most recent COLA entries from the public registry and writes one
CSV row per entry containing all the fields shown on the "printable version" of
each certificate (TTB form 5100.31). It also downloads every affixed label image
into a label_images/ folder next to the CSV; the image_files column lists the
saved filenames for each row.

How it works:
  1. POST a completed-date search to publicSearchColasBasicProcess.do (this opens
     a server-side session held in a cookie).
  2. Sort the results by TTB ID descending (newest first).
  3. Page through the results (20 per page) collecting TTB IDs until we have N.
  4. For each TTB ID, fetch the printable form
     (viewColaDetails.do?action=publicFormDisplay&ttbid=...) and parse every field.
  5. Write rows to CSV incrementally. Re-running resumes: TTB IDs already in the
     output file are skipped.

Usage:
  python scrape_cola.py                      # latest 1000 -> cola_recent_1000.csv
  python scrape_cola.py --count 50           # smaller run
  python scrape_cola.py --date-from 01/01/2026 --date-to 06/13/2026
  python scrape_cola.py --delay 0.5          # seconds between requests (be polite)
  python scrape_cola.py --out my.csv

Stdlib only (no pip installs needed).
"""

import argparse
import csv
import html
import http.cookiejar
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://ttbonline.gov/colasonline"
SEARCH = BASE + "/publicSearchColasBasicProcess.do?action=search"
SORT = BASE + "/publicPageBasicCola.do?action=sort&sortcol=ttbId&order=desc"
NEXT = BASE + "/publicPageBasicCola.do?action=page&pgfcn=nextset"
PRINTABLE = BASE + "/viewColaDetails.do?action=publicFormDisplay&ttbid={ttbid}"
DETAIL_URL = BASE + "/viewColaDetails.do?action=publicDisplaySearchBasic&ttbid={ttbid}"

HERE = Path(__file__).resolve().parent

# Output columns: TTB-listing metadata + every field on the printable form.
COLUMNS = [
    "ttb_id",
    "completed_date",        # from results listing (sort key)
    # --- printable form: header ---
    "vendor_code",           # "CT"
    "origin_code",           # "OR"
    # --- Part I: application (item numbers vary by form revision) ---
    "rep_id_no",
    "plant_registry_basic_permit",
    "source_of_product",     # checked: Domestic / Imported
    "serial_number",
    "product_type",          # checked: Wine / Distilled Spirits / Malt Beverage
    "brand_name",
    "fanciful_name",
    "applicant_name_address",
    "mailing_address",
    "email",
    "formula_sop_no",
    "lab_no_date",
    "grape_varietals",
    "net_contents",
    "alcohol_content",
    "wine_appellation",
    "wine_vintage_date",
    "phone",
    "fax",
    "application_type",      # checked option text
    "other_wording",         # "show any information blown/branded/embossed..."
    # --- Part II: certification ---
    "date_of_application",   # 19
    "signature",             # 20
    "print_name",            # 21
    # --- Part III: TTB certificate ---
    "date_issued",           # 22
    # --- For TTB use only ---
    "qualifications",
    "status",
    "class_type_description",
    "expiration_date",
    # --- attached labels ---
    "label_images",          # type + dimensions for each affixed label
    "image_files",           # saved image filenames (in label_images/ folder)
    "source_url",
]

IMAGES_DIRNAME = "label_images"


def make_opener():
    cj = http.cookiejar.CookieJar()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False          # the registry's cert chain doesn't verify
    ctx.verify_mode = ssl.CERT_NONE     #   cleanly from many networks
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cj),
        urllib.request.HTTPSHandler(context=ctx),
    )
    opener.addheaders = [("User-Agent", "Mozilla/5.0 (cola-research-scraper)")]
    return opener


def fetch(opener, url, data=None, retries=3):
    for attempt in range(retries):
        try:
            body = data.encode() if isinstance(data, str) else data
            with opener.open(url, data=body, timeout=45) as r:
                return r.read().decode("latin-1", errors="replace")
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return ""


def fetch_bytes(opener, url, referer=None, retries=3):
    """Fetch raw bytes (for images). Returns (content_type, data) or (None, None)."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url)
            if referer:
                req.add_header("Referer", referer)
            with opener.open(req, timeout=45) as r:
                return r.headers.get("Content-Type", ""), r.read()
        except Exception:
            if attempt == retries - 1:
                return None, None
            time.sleep(2 * (attempt + 1))
    return None, None


def download_images(opener, ttbid, page, images_dir):
    """Download every affixed label image for a COLA. Must be called right after
    fetching that COLA's printable page (the attachment endpoint is session-bound
    to the last-viewed COLA). Returns a list of saved filenames."""
    referer = PRINTABLE.format(ttbid=ttbid)
    saved = []
    srcs = re.findall(
        r'<img[^>]*src="([^"]*publicViewAttachment\.do\?[^"]*)"', page, re.I)
    for idx, src in enumerate(srcs, 1):
        src = html.unescape(src)
        fn = re.search(r"filename=([^&]*)", src)
        ft = re.search(r"filetype=([^&\"]*)", src)
        if not fn:
            continue
        filename = urllib.parse.unquote(fn.group(1))
        filetype = ft.group(1) if ft else "l"
        url = BASE + "/publicViewAttachment.do?" + urllib.parse.urlencode(
            {"filename": filename, "filetype": filetype})
        ctype, data = fetch_bytes(opener, url, referer=referer)
        if not data or not ctype or "image" not in ctype:
            continue
        ext = {"image/jpeg": ".jpg", "image/png": ".png",
               "image/gif": ".gif", "image/tiff": ".tif"}.get(
                   ctype.split(";")[0].strip(),
                   Path(filename).suffix or ".jpg")
        out_name = f"{ttbid}_{idx}{ext}"
        (images_dir / out_name).write_bytes(data)
        saved.append(out_name)
    return saved


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def clean(fragment):
    """HTML fragment -> clean single-line text."""
    if not fragment:
        return ""
    s = re.sub(r"(?i)<br\s*/?>", ", ", fragment)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"(\s*,\s*)+", ", ", s)   # collapse repeated commas from <br><br>
    return s.strip(" ,")


def data_after(page, name, exact=False):
    """Find a label/boldlabel div containing `name` (ignoring any leading item
    number), then return the text of the next <div class="data"> after it."""
    if exact:
        m = re.search(r'class="(?:bold)?label"[^>]*>\s*' + name + r'\s*</div>',
                      page, re.I)
    else:
        m = re.search(r'<div class="(?:bold)?label"[^>]*>(?:(?!</div>).)*?'
                      + name, page, re.I | re.S)
    if not m:
        return ""
    d = re.search(r'<div class="data"[^>]*>(.*?)</div>',
                  page[m.end():], re.I | re.S)
    return clean(d.group(1)) if d else ""


def checked_alt(page, prefix):
    """Return the checked options for checkbox inputs whose alt is
    'prefix: Value' (e.g. 'Type of Product: Wine')."""
    out = []
    for m in re.finditer(r'<input[^>]*alt="' + prefix + r':\s*([^"]+)"[^>]*>',
                         page, re.I):
        if "checked" in m.group(0).lower():
            out.append(m.group(1).strip())
    return "; ".join(out)


def checked_application_type(page):
    """Return the text(s) of the checked 'type of application' checkbox row(s)."""
    region = page
    start = re.search(r"TYPE OF APPLICATION", page, re.I)
    if start:
        region = page[start.start():start.start() + 2500]
    out = []
    pat = re.compile(
        r'<input([^>]*)>.*?<td[^>]*class="smalldata"[^>]*>(.*?)</td>',
        re.I | re.S)
    for m in pat.finditer(region):
        if "checked" in m.group(1).lower():
            out.append(clean(m.group(2)))
    return "; ".join(out)


def parse_label_images(page):
    out = []
    pat = re.compile(
        r"Image Type:\s*</p>\s*(.*?)\s*<br>.*?Actual Dimensions:\s*(.*?)<br>",
        re.I | re.S)
    for m in pat.finditer(page):
        itype = clean(m.group(1))
        dims = clean(m.group(2))
        out.append(f"{itype} ({dims})" if dims else itype)
    return " | ".join(out)


def parse_other_wording(page):
    """Item 'SHOW ANY WORDING/INFORMATION...' - the label text and the entered
    value share one data div; strip the boilerplate prompt, keep the value."""
    m = re.search(r'<div class="data"[^>]*>\s*\d+\.\s*SHOW ANY '
                  r'(?:WORDING|INFORMATION)(.*?)</div>', page, re.I | re.S)
    if not m:
        return ""
    txt = clean(m.group(1))
    parts = re.split(r"LABELS\.", txt, maxsplit=1, flags=re.I)
    return clean(parts[1]) if len(parts) > 1 else txt


def parse_printable(page, ttbid):
    row = {c: "" for c in COLUMNS}
    row["ttb_id"] = ttbid
    row["source_url"] = PRINTABLE.format(ttbid=ttbid)

    row["vendor_code"] = data_after(page, "CT", exact=True)
    row["origin_code"] = data_after(page, "OR", exact=True)
    row["rep_id_no"] = data_after(page, r"REP\.?\s*ID")
    row["plant_registry_basic_permit"] = data_after(page, "PLANT REGISTRY")
    row["source_of_product"] = checked_alt(page, "Source of Product")
    row["serial_number"] = data_after(page, "SERIAL NUMBER")
    row["product_type"] = checked_alt(page, "Type of Product")
    row["brand_name"] = data_after(page, "BRAND NAME")
    row["fanciful_name"] = data_after(page, "FANCIFUL NAME")
    row["applicant_name_address"] = data_after(page, "NAME AND ADDRESS")
    row["mailing_address"] = data_after(page, "MAILING ADDRESS")
    row["email"] = data_after(page, "EMAIL")
    row["formula_sop_no"] = data_after(page, "FORMULA")
    row["lab_no_date"] = data_after(page, r"LAB\.?\s*NO")
    row["grape_varietals"] = data_after(page, "GRAPE VARIETAL")
    row["net_contents"] = data_after(page, "NET CONTENTS")
    row["alcohol_content"] = data_after(page, "ALCOHOL CONTENT")
    row["wine_appellation"] = data_after(page, "WINE APPELLATION")
    row["wine_vintage_date"] = data_after(page, "WINE VINTAGE")
    row["phone"] = data_after(page, "PHONE")
    row["fax"] = data_after(page, "FAX")
    row["application_type"] = checked_application_type(page)
    row["other_wording"] = parse_other_wording(page)
    row["date_of_application"] = data_after(page, "DATE OF APPLICATION")
    row["signature"] = data_after(page, "SIGNATURE")
    row["print_name"] = data_after(page, "PRINT NAME")
    row["date_issued"] = data_after(page, "DATE ISSUED")
    row["qualifications"] = data_after(page, "QUALIFICATIONS")
    row["status"] = data_after(page, "STATUS")
    row["class_type_description"] = data_after(page, "CLASS/TYPE DESCRIPTION")
    row["expiration_date"] = data_after(page, "EXPIRATION DATE")
    row["label_images"] = parse_label_images(page)
    return row


def parse_listing(page):
    """Return list of (ttb_id, completed_date) from a results page, in order."""
    out = []
    # Each result row links to viewColaDetails...ttbid=NNN; the completed date is
    # the first MM/DD/YYYY in that row.
    for rowm in re.finditer(r"<tr[^>]*>(.*?)</tr>", page, re.S | re.I):
        block = rowm.group(1)
        idm = re.search(r"ttbid=(\d{14})", block)
        if not idm:
            continue
        datem = re.search(r"(\d{2}/\d{2}/\d{4})", html.unescape(block))
        out.append((idm.group(1), datem.group(1) if datem else ""))
    # De-dup preserving order (a row may contain the id twice).
    seen, uniq = set(), []
    for tid, d in out:
        if tid not in seen:
            seen.add(tid)
            uniq.append((tid, d))
    return uniq


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

def collect_ids(opener, count, date_from, date_to, delay):
    print(f"Searching completed {date_from} .. {date_to} ...")
    form = urllib.parse.urlencode({
        "searchCriteria.dateCompletedFrom": date_from,
        "searchCriteria.dateCompletedTo": date_to,
        "searchCriteria.productNameSearchType": "C",
        "searchCriteria.productOrFancifulName": "",
        "searchCriteria.classTypeFrom": "",
        "searchCriteria.classTypeTo": "",
        "searchCriteria.originCode": "",
    })
    first = fetch(opener, SEARCH, data=form)
    total = re.search(r"Total[^0-9]{0,20}([0-9,]+)", first, re.I)
    if total:
        print(f"  result set: {total.group(1)} COLAs")
    fetch(opener, SORT)  # newest first
    time.sleep(delay)

    ids, dates = [], {}
    page_html = fetch(opener, NEXT)  # first page of the sorted set
    page_no = 1
    while len(ids) < count:
        rows = parse_listing(page_html)
        if not rows:
            print("  no more results; stopping.")
            break
        new = 0
        for tid, d in rows:
            if tid not in dates:
                ids.append(tid)
                dates[tid] = d
                new += 1
        print(f"  page {page_no}: +{new} ids (total {len(ids)})")
        if new == 0:
            break
        if len(ids) >= count:
            break
        page_no += 1
        time.sleep(delay)
        page_html = fetch(opener, NEXT)
    return ids[:count], dates


def load_done(out_path):
    done = set()
    if out_path.exists():
        with out_path.open(newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r.get("ttb_id"):
                    done.add(r["ttb_id"])
    return done


def main():
    ap = argparse.ArgumentParser(description="Scrape recent TTB COLA certificates.")
    ap.add_argument("--count", type=int, default=1000)
    ap.add_argument("--date-from", default="01/01/2026")
    ap.add_argument("--date-to", default="06/13/2026")
    ap.add_argument("--delay", type=float, default=0.4,
                    help="seconds between requests")
    ap.add_argument("--out", default=str(HERE / "cola_recent_1000.csv"))
    args = ap.parse_args()

    out_path = Path(args.out)
    images_dir = out_path.parent / IMAGES_DIRNAME
    images_dir.mkdir(exist_ok=True)
    opener = make_opener()

    ids, dates = collect_ids(opener, args.count, args.date_from,
                             args.date_to, args.delay)
    print(f"\nCollected {len(ids)} TTB IDs. Fetching printable forms...\n")

    done = load_done(out_path)
    if done:
        print(f"Resuming: {len(done)} rows already in {out_path.name}, skipping those.")

    new_file = not out_path.exists()
    with out_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        if new_file:
            writer.writeheader()
        n_ok = 0
        n_imgs = 0
        for i, tid in enumerate(ids, 1):
            if tid in done:
                continue
            try:
                page = fetch(opener, PRINTABLE.format(ttbid=tid))
                row = parse_printable(page, tid)
                row["completed_date"] = dates.get(tid, "")
                imgs = download_images(opener, tid, page, images_dir)
                row["image_files"] = "; ".join(imgs)
                writer.writerow(row)
                f.flush()
                n_ok += 1
                n_imgs += len(imgs)
                if i % 25 == 0 or i == len(ids):
                    print(f"  [{i}/{len(ids)}] {tid}  "
                          f"{row['brand_name'][:28]!r}  "
                          f"{len(imgs)} img  ({n_ok} rows, {n_imgs} imgs)")
            except Exception as e:
                print(f"  ! {tid} failed: {e}")
            time.sleep(args.delay)

    print(f"\nDone. CSV: {out_path}")
    print(f"Images: {n_imgs} files in {images_dir}")


if __name__ == "__main__":
    main()
