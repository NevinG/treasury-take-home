"""Assemble a small, self-contained batch folder for demoing/testing batch mode.

Creates data-exploration/batch_sample/ from real (2020+) applications, deliberately
mixed so the results table shows variety:
  - 3 clean PASS applications (images + matching .txt)
  - 1 field FAIL (application .txt brand corrupted so it won't match the label)
  - 1 NEEDS REVIEW (images only, no application text)
  - 1 warning FAIL (the scribbled-over Government Warning image)

Just drag this folder into the app ("Add a folder").
"""
import csv
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
CSV = HERE / "cola_recent_1000.csv"
IMAGES = HERE / "label_images"
APPS = HERE / "application"
OUT = HERE / "batch_sample"
SCRIBBLE = HERE / "scribbled-gov-label.jpg"


def copy_images(ttb_id):
    n = 0
    for p in sorted(IMAGES.glob(f"{ttb_id}_*")):
        shutil.copy(p, OUT / p.name)
        n += 1
    return n


def main():
    rows = list(csv.DictReader(CSV.open(newline="", encoding="utf-8")))
    # Applications that have both images and a parsed .txt, newest first.
    picks = [r["ttb_id"] for r in sorted(rows, key=lambda r: r["ttb_id"], reverse=True)
             if r["image_files"].strip() and (APPS / f"{r['ttb_id']}.txt").exists()
             and list(IMAGES.glob(f"{r['ttb_id']}_*"))]
    if len(picks) < 5:
        raise SystemExit("Not enough applications with images + .txt to build a sample.")

    clean_pass = picks[:3]
    field_fail = picks[3]
    review_noapp = picks[4]

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()

    for tid in clean_pass:
        copy_images(tid)
        shutil.copy(APPS / f"{tid}.txt", OUT / f"{tid}.txt")

    # field fail: images + a brand-corrupted .txt
    copy_images(field_fail)
    txt = (APPS / f"{field_fail}.txt").read_text(encoding="utf-8")
    txt = re.sub(r"(?m)^(6\. BRAND NAME):.*$", r"\1: WRONGLY LABELED COMPANY", txt)
    txt = re.sub(r"(?m)^(7\. FANCIFUL NAME):.*$", r"\1: ", txt)
    (OUT / f"{field_fail}.txt").write_text(txt, encoding="utf-8")

    # needs review: images only, no .txt
    copy_images(review_noapp)

    # warning fail: the scribbled-over Government Warning (no .txt -> warning is the issue)
    if SCRIBBLE.exists():
        shutil.copy(SCRIBBLE, OUT / "scribbled_1.jpg")

    print(f"Wrote {OUT}:")
    print(f"  PASS:   {', '.join(clean_pass)}")
    print(f"  FAIL:   {field_fail} (brand corrupted), scribbled (obscured warning)")
    print(f"  REVIEW: {review_noapp} (no application text)")
    print(f"  files: {len(list(OUT.glob('*')))}")


if __name__ == "__main__":
    main()
