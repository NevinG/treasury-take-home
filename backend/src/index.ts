import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { extractApplication, verifyLabel } from "./gemini";
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
  try {
    // No application text (e.g. a batch item with no matching form) is allowed: we
    // still read the label, but every element comes back as "review" since there is
    // nothing to compare against.
    const rows = applicationText.trim() ? await extractApplication(applicationText) : [];
    const filename = files[0].originalname;
    const row = findApplicationRow(rows, filename) || rows[0] || null;

    const images = files.map((f) => ({
      data: f.buffer.toString("base64"),
      mimeType: f.mimetype || "image/png",
    }));
    const expected = {
      brand_name: row?.brand_name ?? "",
      fanciful_name: row?.fanciful_name ?? "",
      class_type: row?.class_type ?? "",
      alcohol_content: row?.alcohol_content ?? "",
      net_contents: row?.net_contents ?? "",
      producer_name: row?.producer_name ?? "",
      country_of_origin: row?.country_of_origin ?? "",
    };

    const verification = await verifyLabel(images, expected);
    const verdict = buildVerdict(verification, row);
    res.json({ verdict });
  } catch (err) {
    console.error("verify error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Verification failed." });
  }
});

app.listen(PORT, () => {
  console.log(`TTB backend listening on http://localhost:${PORT}`);
});
