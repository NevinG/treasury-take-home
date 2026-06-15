import "dotenv/config";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
import { extractApplication, verifyLabel } from "./gemini";
import { parseApplicationLocal, verifyLabelLocal } from "./local";
import { buildVerdict, findApplicationRow } from "./matching";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
});

app.use(cors());

const PORT = Number(process.env.PORT) || 3001;

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Upload all of an application's label images + the application text, then verify
// every mandatory TTB element against the label in one application-aware pass.
app.post("/api/verify", upload.array("images"), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) || [];
  const applicationText = (req.body?.applicationText as string) || "";
  if (!files.length) {
    return res.status(400).json({ error: "No label images were uploaded." });
  }

  const filename = files[0].originalname;
  const images = files.map((f) => ({
    data: f.buffer.toString("base64"),
    mimeType: f.mimetype || "image/png",
  }));

  // Run the full verify pipeline with either the cloud or the fully-local engine.
  async function pipeline(useLocal: boolean) {
    // No application text (e.g. a batch item with no matching form) is allowed: we
    // still read the label, but every element comes back as "review".
    const rows = applicationText.trim()
      ? useLocal
        ? parseApplicationLocal(applicationText)
        : await extractApplication(applicationText)
      : [];
    const row = findApplicationRow(rows, filename) || rows[0] || null;
    const expected = {
      brand_name: row?.brand_name ?? "",
      fanciful_name: row?.fanciful_name ?? "",
      class_type: row?.class_type ?? "",
      alcohol_content: row?.alcohol_content ?? "",
      net_contents: row?.net_contents ?? "",
      producer_name: row?.producer_name ?? "",
      country_of_origin: row?.country_of_origin ?? "",
    };
    const verification = useLocal
      ? await verifyLabelLocal(images, expected)
      : await verifyLabel(images, expected);
    return buildVerdict(verification, row);
  }

  // Offline when asked (settings toggle) or when no API key is configured.
  const forceLocal = String(req.body?.offline) === "true" || !process.env.GEMINI_API_KEY;

  try {
    if (forceLocal) {
      return res.json({ verdict: await pipeline(true), engine: "local" });
    }
    try {
      res.json({ verdict: await pipeline(false), engine: "cloud" });
    } catch (cloudErr) {
      // Cloud endpoint unreachable/blocked/errored — fall back to the local engine so
      // the tool keeps working on restricted networks.
      console.error("Cloud engine failed — falling back to the offline engine:", cloudErr);
      res.json({ verdict: await pipeline(true), engine: "local-fallback" });
    }
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Verification failed." });
  }
});

// In production we serve the built React app from ./public (CI copies frontend/dist
// here), so the whole thing is one deployable. The API routes above take precedence.
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(join(publicDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`TTB backend listening on http://localhost:${PORT}`);
});
