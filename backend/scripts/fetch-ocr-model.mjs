// Downloads the English OCR model used by the offline fallback engine into
// backend/ocr-data/. Run once on a machine with internet:  npm run fetch-ocr-model
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ocr-data");
const url = "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata";

await mkdir(dir, { recursive: true });
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed (${res.status})`);
await writeFile(resolve(dir, "eng.traineddata"), Buffer.from(await res.arrayBuffer()));
console.log("Saved eng.traineddata ->", dir);
