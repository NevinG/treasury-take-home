"""Trim the dataset to applications issued in 2020 or later.

Rewrites cola_recent_1000.csv to the kept rows and deletes the corresponding
pre-2020 files from application/ (<id>.txt) and label_images/ (<id>_*.*).

Usage:  python trim_dataset.py            # trims to >= 2020
        python trim_dataset.py --year 2018
"""
import argparse
import csv
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
CSV = HERE / "cola_recent_1000.csv"
APP = HERE / "application"
IMG = HERE / "label_images"


def year(s):
    m = re.search(r"(19|20)\d{2}", s or "")
    return int(m.group(0)) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2020)
    args = ap.parse_args()

    rows = list(csv.DictReader(CSV.open(newline="", encoding="utf-8")))
    fields = list(rows[0].keys())
    keep = {r["ttb_id"] for r in rows if (year(r.get("date_issued", "")) or 0) >= args.year}
    kept_rows = [r for r in rows if r["ttb_id"] in keep]

    has_both = sum(1 for r in kept_rows if r["net_contents"].strip() and r["alcohol_content"].strip())

    with CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(kept_rows)

    rm_txt = 0
    if APP.exists():
        for p in APP.glob("*.txt"):
            if p.stem not in keep:
                p.unlink()
                rm_txt += 1
    rm_img = 0
    if IMG.exists():
        for p in IMG.glob("*"):
            if p.is_file() and p.stem.split("_", 1)[0] not in keep:
                p.unlink()
                rm_img += 1

    print(f"Kept {len(kept_rows)}/{len(rows)} applications (date_issued >= {args.year}).")
    print(f"Removed {rm_txt} .txt and {rm_img} images.")
    print(f"Kept applications with net_contents AND alcohol_content: {has_both}")


if __name__ == "__main__":
    main()
