"""Assemble a small, self-contained batch folder for demoing/testing batch mode.

Creates data-exploration/batch_sample/ containing label images + application .txt
files for ~6 applications, deliberately mixed so the results table shows variety:
  - several clean PASS applications
  - one warning FAIL (back panel replaced with the scribbled-over warning)
  - one field FAIL (application .txt brand corrupted so it won't match the label)
  - one NEEDS REVIEW (images only, no application text to compare against)

Just drag this folder into the app's Batch mode ("Select a folder").
"""
import re
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
IMAGES = HERE / "label_images"
APPS = HERE / "application"
OUT = HERE / "batch_sample"
SCRIBBLE = HERE / "scribbled-gov-label.jpg"

CLEAN_PASS = ["15048001000583", "15113001000558", "16258001000032"]
WARNING_FAIL = "13064001000377"          # Landucci — back panel (_2) is the warning
FIELD_FAIL = "15049001000002"            # corrupt the brand in its .txt
REVIEW_NOAPP = "15054001000009"          # images only, no .txt


def copy_images(ttb_id, skip=None):
    for p in sorted(IMAGES.glob(f"{ttb_id}_*.jpg")):
        if skip and p.name == skip:
            continue
        shutil.copy(p, OUT / p.name)


def copy_txt(ttb_id):
    src = APPS / f"{ttb_id}.txt"
    if src.exists():
        shutil.copy(src, OUT / src.name)


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()

    # clean passes
    for tid in CLEAN_PASS:
        copy_images(tid)
        copy_txt(tid)

    # warning fail: use ONLY the defaced back panel (the scribbled-over warning) so the
    # obstruction is unmistakable — with a clean front panel present the model can read
    # the warning from context and the strike-through becomes ambiguous.
    if SCRIBBLE.exists():
        shutil.copy(SCRIBBLE, OUT / f"{WARNING_FAIL}_1.jpg")
    copy_txt(WARNING_FAIL)

    # field fail: copy images + a brand-corrupted .txt
    copy_images(FIELD_FAIL)
    txt = (APPS / f"{FIELD_FAIL}.txt").read_text(encoding="utf-8")
    txt = re.sub(r"(?m)^(6\. BRAND NAME):.*$", r"\1: WRONGLY LABELED COMPANY", txt)
    txt = re.sub(r"(?m)^(7\. FANCIFUL NAME):.*$", r"\1: ", txt)
    (OUT / f"{FIELD_FAIL}.txt").write_text(txt, encoding="utf-8")

    # needs review: images only, no .txt
    copy_images(REVIEW_NOAPP)

    imgs = len(list(OUT.glob("*.jpg")))
    txts = len(list(OUT.glob("*.txt")))
    print(f"Wrote {OUT} — {imgs} images, {txts} application files across 6 applications:")
    print(f"  PASS:   {', '.join(CLEAN_PASS)}")
    print(f"  FAIL:   {WARNING_FAIL} (scribbled warning), {FIELD_FAIL} (brand corrupted)")
    print(f"  REVIEW: {REVIEW_NOAPP} (no application text)")


if __name__ == "__main__":
    main()
