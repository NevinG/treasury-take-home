// Gemini calls (gemini-2.5-flash-lite, chosen via data-exploration/model_test):
//  - extractApplication: parse free-form application text into fields
//  - verifyLabel:        read every mandatory element off the label image(s)

import { GoogleGenAI, Type } from "@google/genai";
import type { ApplicationRow, VerificationResult } from "./types";

// One model for both the text parse and the vision read. The model only READS;
// the match/mismatch judgment is done deterministically in matching.ts.
const MODEL = "gemini-2.5-flash-lite";

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy backend/.env.example to backend/.env and add your key."
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

// ---------------------------------------------------------------------------
// Parse the pasted/uploaded application text into structured fields
// ---------------------------------------------------------------------------

const APPLICATION_PROMPT = `You are parsing a TTB alcohol label APPLICATION that a user pasted or uploaded.
The input may be a full TTB application form (labeled fields like "6. BRAND NAME: ..."), one or more
CSV rows (with or without a header), key-value text, or free-form notes.

Return a JSON array with one object per application/product. Each object has:
- file, brand_name, fanciful_name, class_type, alcohol_content, net_contents, producer_name, country_of_origin

Map fields (ignore the form item numbers and any other fields):
- brand_name        <- "BRAND NAME"
- fanciful_name     <- "FANCIFUL NAME" (a product/series name; "" if none)
- class_type        <- "CLASS/TYPE DESCRIPTION" (NOT "TYPE OF PRODUCT")
- alcohol_content   <- "ALCOHOL CONTENT"
- net_contents      <- "NET CONTENTS"
- producer_name     <- "NAME AND ADDRESS OF APPLICANT"
- country_of_origin <- origin/country if stated (e.g. "SOURCE OF PRODUCT")
- file              <- an image filename if present, else ""

Use "" for any field not present. Treat placeholders ("N/A", "n.a.", "none", "null", "-", "unknown") as
"" — never copy a placeholder into a value. If only one application is described, return a single-element array.`;

const APPLICATION_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      file: { type: Type.STRING },
      brand_name: { type: Type.STRING },
      fanciful_name: { type: Type.STRING },
      class_type: { type: Type.STRING },
      alcohol_content: { type: Type.STRING },
      net_contents: { type: Type.STRING },
      producer_name: { type: Type.STRING },
      country_of_origin: { type: Type.STRING },
    },
    required: ["file", "brand_name", "fanciful_name", "class_type", "alcohol_content", "net_contents", "producer_name", "country_of_origin"],
  },
};

export async function extractApplication(rawText: string): Promise<ApplicationRow[]> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ text: `${APPLICATION_PROMPT}\n\nINPUT:\n${rawText}` }],
    config: { responseMimeType: "application/json", responseSchema: APPLICATION_SCHEMA, temperature: 0 },
  });
  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini application parser.");
  const rows = JSON.parse(text) as ApplicationRow[];
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------------------------
// Application-aware verification of the label image(s)
// ---------------------------------------------------------------------------

// Field order matters: the model generates these in order, so it reads the label
// (label_value) and reasons (note) BEFORE committing to a status. Generating
// status last makes the verdict follow the reasoning instead of preceding it.
const FIELD = {
  type: Type.OBJECT,
  properties: {
    label_value: { type: Type.STRING },
    note: { type: Type.STRING },
    status: { type: Type.STRING, enum: ["match", "mismatch", "review"], format: "enum" },
  },
  required: ["label_value", "note", "status"],
};

const VERIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    brand: FIELD,
    class_type: FIELD,
    alcohol_content: FIELD,
    net_contents: FIELD,
    name_address: FIELD,
    country_of_origin: FIELD,
    government_warning: {
      type: Type.OBJECT,
      properties: {
        present: { type: Type.BOOLEAN },
        heading: { type: Type.STRING },
        text: { type: Type.STRING },
        prefix_all_caps: { type: Type.BOOLEAN },
        legible: { type: Type.BOOLEAN },
      },
      required: ["present", "heading", "text", "prefix_all_caps", "legible"],
    },
  },
  required: ["brand", "class_type", "alcohol_content", "net_contents", "name_address", "country_of_origin", "government_warning"],
};

export interface ExpectedValues {
  brand_name: string;
  fanciful_name: string;
  class_type: string;
  alcohol_content: string;
  net_contents: string;
  producer_name: string;
  country_of_origin: string;
}

export async function verifyLabel(
  images: { data: string; mimeType: string }[],
  expected: ExpectedValues
): Promise<VerificationResult> {
  const ai = getClient();
  const prompt = `You are a strict TTB compliance reviewer. You are given ALL the label panels for one
product (front, back, neck) and an APPLICATION describing what that product is supposed to be. Your job
is to COMPARE the application's stated values against what the label actually shows, element by element,
and catch any discrepancy — including the case where the uploaded images are for a DIFFERENT product
than the application.

The application states:
- Brand name: "${expected.brand_name}"
- Fanciful/product name: "${expected.fanciful_name}"
- Class/type: "${expected.class_type}"
- Alcohol content: "${expected.alcohol_content}"
- Net contents: "${expected.net_contents}"
- Applicant (name/address of record): "${expected.producer_name}"
- Country of origin: "${expected.country_of_origin}"

For EACH element below, first read what the label actually shows ("label_value"), then assign a status:
- "match"    = the label value is consistent with the application value (see the generous rules below).
- "mismatch" = the label clearly shows a CONTRADICTORY value — these are different products/values.
               This is a FAILURE. Reserve it for genuine conflicts, NOT formatting or granularity.
- "review"   = the element is simply NOT VISIBLE on any provided image (could be molded in glass or on a
               panel that wasn't uploaded). Only when the value is ABSENT — never when a value is present.

CRITICAL: The application values come from TTB's internal database and are often broader, longer, or
formatted differently than the printed label. Differences in wording, granularity, or format are NORMAL
and must be treated as "match". Only flag "mismatch" when the label describes a genuinely DIFFERENT
product. When unsure between match and mismatch, choose "match".

EQUALLY CRITICAL — do NOT manufacture a match. Compare only what is actually written. Never invent a
"typo", a hidden abbreviation, or a relationship that isn't there to justify a match, and never credit
the application with a value it does not state. If the label value is genuinely a different name or a
different number than the application value, it is a "mismatch", full stop.

Per-element rules (each lists what is STILL a match, then what is a real mismatch):

- brand: The label may prominently show the BRAND name, the FANCIFUL/product name, or both. MATCH if
  EITHER the application brand name OR the application fanciful name appears on the label (e.g. brand
  "SPIRITS OF ST. LOUIS" + fanciful "MO GIN" matches a label reading "MOGIN"). The application brand also
  often appends the varietal/class — MATCH if the label brand is the core of the application brand or
  vice versa, ignoring suffixes like VINEYARDS/WINERY/DISTILLING and class/varietal words, and
  ignoring case/spacing ("PINDAR VINEYARDS"="Pindar"; "SUMMER CRUSH SUMMER ALE"="Summer Crush";
  "DUCK WALK VINEYARDS"="Duckwalk"). MISMATCH when the label's brand shares NO meaningful word with the
  application's brand or fanciful name and is not a spelling/spacing variant of either — e.g. label
  "MOGIN" vs application brand "ZEPHYR HOLLOW RESERVE" is a MISMATCH; "BLUEBIRD DISTILLING" vs
  "NIT DEL FOC" is a MISMATCH. Do not call unrelated names a match.

- class_type: There are only THREE major TTB product classes: WINE, DISTILLED SPIRITS, and MALT
  BEVERAGE (beer/ale). The application class/type is a BROAD internal category; the label shows the
  specific style. As long as the label's designation is in the SAME major class as the application, it
  is a MATCH — never mismatch on granularity or sub-style. Examples that all MATCH:
  "SPARKLING WINE/CHAMPAGNE"="CAVA"; "TABLE RED WINE"="RED WINE"/"Cabernet Sauvignon"/"Graciano";
  "TABLE WHITE WINE"="Chardonnay"; "TABLE FRUIT WINE"="Blackberry Wine"; "DESSERT/PORT/SHERRY/(COOKING)
  WINE"=any wine such as "Red Wine"/"Rosé Wine"/"Viognier"; "OTHER GIN"="GIN"; "MALT BEVERAGE
  SPECIALTIES - FLAVORED"="Ale with Natural Flavors"; "OTHER (HERBS & SEEDS)"="Honeysuckle Liqueur".
  MISMATCH ONLY when the label's product is in a DIFFERENT major class than the application — e.g.
  application "BOURBON WHISKY" (distilled spirits) but label "CAVA" (wine); application a wine but label
  a beer. If you cannot tell the major class from the label, use "review", not "mismatch".

- alcohol_content: MATCH if the numeric ABV is the same, ignoring all formatting: trailing zeros
  ("11.0"="11%"="11% BY VOL"), decimal comma ("11,5% vol"="11.5%"), "ALC ... BY VOL" wording, and "%"/
  "vol" units. MISMATCH only if the numbers genuinely differ ("46%" vs "11.5%").

- net_contents: MATCH if the same volume, ignoring unit spelling/case ("750 MILLILITERS"="750 mL"=
  "750ML"). The application may LIST several sizes ("15.5 GAL., 5 GAL., 10.8 GAL.") — MATCH if the
  label's size is ANY one of them ("5 GALS."). MISMATCH only on a genuinely different volume.

- name_address: TTB requires a bottler/producer/importer name and address. An importer-of-record can
  legitimately differ from the foreign producer printed on the label, so MATCH whenever ANY bona fide
  name + address is present. Use "review" only if NO name/address is visible at all. Essentially never
  "mismatch".

- country_of_origin: The application value is usually a STATUS word, not a country name.
  * If it is "Imported" (or names a foreign country): MATCH if the label shows ANY foreign origin /
    "Product of <country>" / "Imported by ..." ("Imported"="PRODUCT OF SPAIN"="PRODUCTO DE ESPAÑA").
    "review" if no origin statement is visible.
  * If it is "Domestic"/"USA"/"United States" (or empty): MATCH if the label shows no foreign origin
    (a US state/region like "North Carolina" is still domestic). "review" only if you genuinely can't
    tell. MISMATCH only when a domestic application is contradicted by a FOREIGN origin on the label
    ("Domestic" vs "PRODUCTO DE ESPAÑA").

For each element, produce the three properties IN THIS ORDER, and they must be self-consistent:
 1. "label_value" = the exact text you read on the label for that element ("" if not visible).
 2. "note" = a SHORT comparison (max ~15 words), ENDING with your conclusion ("...match/mismatch/
    not visible").
 3. "status" = the verdict, which MUST agree with your note: "mismatch" if your note concludes the values
    conflict, "review" if the value is not visible, otherwise "match". NEVER write a note that concludes
    "mismatch" and then set status to "match".

Return ONLY JSON shaped exactly like:
{
 "brand":            {"label_value":"", "note":"", "status":""},
 "class_type":       {"label_value":"", "note":"", "status":""},
 "alcohol_content":  {"label_value":"", "note":"", "status":""},
 "net_contents":     {"label_value":"", "note":"", "status":""},
 "name_address":     {"label_value":"", "note":"", "status":""},
 "country_of_origin":{"label_value":"", "note":"", "status":""},
 "government_warning": {"present": <is the Surgeon General warning on the label?>, "heading": "<the warning's heading copied EXACTLY as printed, preserving capitalization — e.g. 'GOVERNMENT WARNING:' or 'Government Warning:'>", "text": "<the FULL warning statement verbatim, INCLUDING the heading, or ''>", "prefix_all_caps": <bool>, "legible": <is the ENTIRE warning clearly legible and readable — set FALSE if ANY part is scribbled over, crossed out, struck through, marked out, covered, blacked out, smudged, drawn over, or otherwise obscured by ANY mark so that even one word is harder to read>}
}`;

  const parts: any[] = images.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } }));
  parts.push({ text: prompt });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: parts,
    config: {
      responseMimeType: "application/json",
      responseSchema: VERIFY_SCHEMA,
      temperature: 0,
      maxOutputTokens: 8192,
    },
  });
  const text = response.text;
  if (!text) {
    const fr = (response as any).candidates?.[0]?.finishReason;
    throw new Error(`Empty response from Gemini verification (finishReason=${fr}).`);
  }
  return JSON.parse(text) as VerificationResult;
}
