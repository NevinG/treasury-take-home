"""
Build one application file per COLA, for testing the verifier.

Reads cola_recent_1000.csv and writes, into data-exploration/application/,
one file per application named <ttb_id>.txt  (e.g. 11364001000181.txt).
The name matches the image prefix, since label images are <ttb_id>_<n>.jpg.

Each file is the FULL TTB application as a labeled key/value block (form items
1–23 plus the TTB-use footer), one block per application, no repeated rows.
To test: upload all of an application's images from label_images and upload/paste
its <ttb_id>.txt.

The source CSV already carries every form field; this just renders them.
"""

import csv
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "cola_recent_1000.csv"
OUT_DIR = HERE / "application"

# (form label, csv column) in form reading order. Item 24 (authorized signature)
# is an image on the form and has no data, so it is omitted.
FIELDS = [
    ("Id", "ttb_id"),
    ("1. REP. ID. NO.", "rep_id_no"),
    ("CT", "vendor_code"),
    ("OR", "origin_code"),
    ("2. PLANT REGISTRY/BASIC PERMIT/BREWER'S NO.", "plant_registry_basic_permit"),
    ("3. SOURCE OF PRODUCT", "source_of_product"),
    ("4. SERIAL NUMBER", "serial_number"),
    ("5. TYPE OF PRODUCT", "product_type"),
    ("6. BRAND NAME", "brand_name"),
    ("7. FANCIFUL NAME", "fanciful_name"),
    ("8. NAME AND ADDRESS OF APPLICANT", "applicant_name_address"),
    ("8a. MAILING ADDRESS", "mailing_address"),
    ("9. EMAIL ADDRESS", "email"),
    ("10. GRAPE VARIETAL(S)", "grape_varietals"),
    ("11. FORMULA", "formula_sop_no"),
    ("LAB NO./DATE", "lab_no_date"),
    ("12. NET CONTENTS", "net_contents"),
    ("13. ALCOHOL CONTENT", "alcohol_content"),
    ("14. WINE APPELLATION", "wine_appellation"),
    ("15. WINE VINTAGE DATE", "wine_vintage_date"),
    ("16. PHONE NUMBER", "phone"),
    ("17. FAX NUMBER", "fax"),
    ("18. TYPE OF APPLICATION", "application_type"),
    ("19. SHOW ANY INFORMATION BLOWN/BRANDED/EMBOSSED", "other_wording"),
    ("20. DATE OF APPLICATION", "date_of_application"),
    ("21. SIGNATURE", "signature"),
    ("22. PRINT NAME", "print_name"),
    ("23. DATE ISSUED", "date_issued"),
    ("QUALIFICATIONS", "qualifications"),
    ("STATUS", "status"),
    ("CLASS/TYPE DESCRIPTION", "class_type_description"),
    ("EXPIRATION DATE", "expiration_date"),
]


def clean(s: str) -> str:
    return (s or "").strip().strip(",").strip()


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    monolith = OUT_DIR / "applications.txt"
    if monolith.exists():
        monolith.unlink()

    count = 0
    with SRC.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            ttb_id = clean(r.get("ttb_id", ""))
            images = [x.strip() for x in (r.get("image_files") or "").split(";") if x.strip()]
            if not ttb_id or not images:
                continue
            lines = [f"{label}: {clean(r.get(col, ''))}" for (label, col) in FIELDS]
            (OUT_DIR / f"{ttb_id}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
            count += 1

    print(f"Wrote {count} application files -> {OUT_DIR}")


if __name__ == "__main__":
    main()
