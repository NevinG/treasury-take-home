# Approach

## How I built this

I leaned on Claude Code throughout to move faster, but I didn't just one-shot it. I
actually did do a throwaway one-shot first, in a separate repo that isn't tracked here,
purely to get a feel for what the app could look like and where the tricky parts were.
Then I built this version piece by piece — reading the code as it came, making the
architecture calls myself, and iterating on each part until I was happy with it. The
sections below follow roughly the order I worked through things.

## 1. Understanding the problem

First I spent time on the domain. TTB reviews around 150k label applications a year, and a
lot of the job is matching: does the label artwork agree with the application (brand,
class/type, alcohol, net contents, name/address, country of origin), and is the Government
Warning there and formatted correctly. Reading the interview notes, a handful of
constraints stood out as the things that should actually drive the design:

- **Speed** — results in about 5 seconds, or the agents won't use it.
- **Simplicity** — something a non-technical 73-year-old could figure out.
- **Batch** — big importers drop 200–300 applications at once.
- **The warning is strict** — exact wording, all caps, bold, and people try to bury or
  reword it.
- **Restricted network** — their network blocks outbound traffic to a lot of cloud
  endpoints.

I kept coming back to those five.

## 2. Getting real data to test against

I couldn't really build verification without real labels to try it on. The public TTB
COLA registry turned out to have approved applications along with the label artwork. The
datasets I found online didn't include the images, so I wrote my own scraper
(`scrape_cola.py`, standard library only) that pages through the registry and saves each
application's fields to `cola_recent_1000.csv` plus its label images.

Two things came out of that:

- The registry only has *approved* labels, so to test that the tool catches problems I had
  to make my own bad cases — I do that by corrupting one application field so it
  contradicts the label (more on that in §7).
- Later I trimmed the set down to the 732 most recent applications (issued 2020 to now)
  with `trim_dataset.py`, so I'm testing against current data and the current form.

## 3. OCR vs. LLM, and picking a model

I weighed plain OCR against a vision LLM. OCR on its own is fragile with stylized
alcohol-label fonts, and it just hands you raw text with no structure. A vision model
reads the label *and* gives back structured fields, and it copes with the messy layouts
you actually see. I tried a few (gemini-2.5-flash-lite, gemini-2.5-flash, gpt-4o-mini,
claude-haiku) and they all read labels about as well as each other — so I went with
**gemini-2.5-flash-lite**, which is the fastest (well under the 5s bar) and the cheapest by
a wide margin.

## 4. The first cut, and why it didn't hold up

My first version let the model do everything: read the label and also decide, field by
field, whether it matched the application. The reading was good, but its judgment was
shaky in both directions. It would talk itself into a match that wasn't there ("40% is a
typo for 11%", "MOGIN is basically ZEPHYR HOLLOW"), and now and then it would flag a
perfectly fine label as a mismatch. Tweaking the prompt just shuffled the errors around.
On my test set it was sitting in the low 20s out of 30.

## 5. The decision that fixed it: the model reads, the code judges

The realization was that the model is reliable at *reading* a label but not at *deciding*
whether two things match. So I split those jobs:

- **The model (`backend/src/gemini.ts`)** reads each element's value off the label, and
  reads the Government Warning verbatim with a few formatting/legibility flags. The JSON
  schema is ordered `label_value → note → status` on purpose, so it writes down what it
  sees and reasons before it commits to an answer.
- **Plain code (`backend/src/matching.ts`)** does the actual comparison with rules I can
  test: numeric compare for alcohol and net contents, map class/type to a major TTB class
  (wine / spirits / malt), treat brand as a match if the brand *or* the fanciful name
  shows up on the label, handle domestic vs. foreign for origin (US states count as
  domestic), and run the warning checks.

That jumped the test set from the low 20s to a steady 30/30, and just as importantly every
verdict is now something I can explain instead of a model black box. It also settled the
model question: once the model is only reading, the cheapest fast model is the obvious
choice — a fancier one can't beat a suite that's already maxed out.

## 6. Teaching the comparison about messy real data

Most of the work after the split was handling the quirks of real COLA data, and I found
each one from a test that failed:

- **TTB's categories are broad.** The application's class/type is an internal bucket like
  "TABLE WHITE WINE" while the label just says "Chardonnay" — so I match on the major
  class, not the exact words.
- **Brand vs. fanciful name.** Labels often lead with the fanciful/product name, so a
  match on either one should count.
- **Formatting.** `11.0` = `11% BY VOL`, `750 mL` = `750ML`, decimal commas, and so on.
- **The form changed over the years.** The 2020+ certificate usually leaves off net
  contents and alcohol entirely (they're only on the label). So if the application doesn't
  list a field, I don't check the label for it — it's "not applicable", not a failure.
  That one change is what stopped modern wine applications from showing nothing but
  "review".
- **No application value means review, not pass.** If there's nothing to compare against,
  the element goes to a human rather than quietly counting as a match.

## 7. Proving it with one script

`data-exploration/model_test/evaluate.py` builds a labeled set of about 30 cases — 15 real
approved labels that should *not* be rejected, and 15 with one corrupted field that should
*not* slip through — runs them against the live backend, and writes `RESULTS.md`. The
metric matches the real cost: the only outcomes that count as errors are a good label
getting hard-rejected or a bad label getting silently passed. A "needs review" is fine,
because it just sends the case to a person.

## 8. The Government Warning

The warning gets stricter handling because the assessment makes a point of it. It has to
be present, the heading has to be all caps (I check that against the heading the model
read verbatim, so a title-case "Government Warning" fails), it has to be legible (a
scribbled-over or covered warning fails — that's a visual call the model makes), and it
has to contain the required statement. I stopped short of enforcing the wording
character-for-character on purpose: OCR isn't perfect, and a strict diff ends up rejecting
plenty of legitimate labels, so I check for the required phrases and leave the fine reading
to a human.

## 9. UX

- **One flow instead of two.** You upload images (and optionally application text or files)
  in whatever order you want; one product gives you a single detailed result, several
  products give you a triage table, and it switches on its own.
- **Batch triage.** Filter chips (Pass / Needs review / Does not match / missing data),
  pagination, and click any row to see that application's full-size images and verdict.
- **You can see it working.** Full-size label images with a progress bar while the AI runs.
- Smaller things: application details go in through a popup, uploads add up instead of
  replacing, and there's a small settings panel.

## 10. The offline fallback

Since their network blocks a lot of outbound traffic, I added a fully-local engine that
makes no outbound calls at all: a plain parser for the application text and on-device OCR
(tesseract.js) for the label, both feeding the same comparison code so the verdict comes
out in the same shape, just less accurate. You can flip it on in settings, and — the part
I think matters most — the backend automatically falls back to it if the cloud call fails
(blocked, timed out, errored), so the tool keeps working when Google can't be reached.
Each response says which engine ran, and the UI shows a banner when it falls back.

## 11. Deployment

I went with Azure on purpose, for two reasons. One, the IT notes say the existing COLA
system is .NET and hosted in Azure, so building on what the agency already uses makes this
a more realistic fit for how they'd actually adopt it. Two, I hadn't used Azure before, so
it was a good chance to learn it and use the free credits for hosting.

I kept the shape as simple and cheap as I could: a single Azure Linux App Service where
the Express backend serves the API and the built React app together, so there's just one
thing to deploy. The infrastructure is all in Terraform (`infra/`, defaulting to the free
F1 plan), and a GitHub Actions workflow redeploys on every push to `main`. Steps are in
`DEPLOY.md`.

## Assumptions

The assessment left a lot open on purpose, so here are the assumptions I made to make the
thing concrete. Each one is "the brief didn't say X, so I assumed Y."

- **How the application data gets in.** It never says where the application values come
  from, so I assumed the agent pastes them or uploads a `.txt`/`.csv` (a row from their
  CSV, key/value text, whatever) and the tool parses it. No live COLA integration —
  Marcus said this is a standalone proof of concept.
- **What "matches" means.** It doesn't define how strict matching should be, and Dave's
  "STONE'S THROW vs Stone's Throw" comment says judgment matters. So I assumed semantic,
  format-tolerant matching (case, punctuation, spacing, equivalent number/unit formats),
  not exact string equality.
- **Which elements are mandatory.** The list is "common elements" with "exceptions for
  certain wine/beer." I assumed I should check all seven, but treat any element the
  application doesn't actually state as not-applicable instead of a failure — which matters
  because the modern form often leaves off net contents and alcohol.
- **Country of origin.** It's "for imports," so I assumed domestic products don't need an
  origin on the label, US state/region names count as domestic, and I only flag a real
  conflict (a domestic application with a foreign origin printed, or vice versa).
- **The Government Warning.** I assumed the standard federal wording (27 CFR 16.21) and
  checked presence, all-caps heading, bold/legibility, and the required content — but not
  exact character-for-character wording, since OCR isn't reliable enough for that.
- **Name & address.** I assumed having a legitimate bottler/producer/importer name +
  address on the label is enough, because that entity can legitimately differ from the
  applicant (contract production, a DBA, an importer of record).
- **Images.** I assumed all the label panels for one product get uploaded together
  (front/back/neck), and in a batch they're grouped per application by filename
  (`<id>_<n>.jpg`). Jenny's "photographed at bad angles / glare" wish I treated as out of
  scope beyond what the vision model already tolerates.
- **What the result should be.** It doesn't define an output format, so I assumed three
  outcomes — Pass / Needs review / Does not match — and that "can't confirm" should always
  be a review for a human, never a silent pass or fail.
- **Test data and bad labels.** The registry only contains approved labels, so I assumed
  it's fair to generate negative cases by corrupting one application field so it disagrees
  with a real label.
- **Beverage scope.** I assumed the three TTB classes (wine, distilled spirits, malt
  beverage) cover what this needs to handle.
- **Prototype scope.** No auth, no database, no storing anything sensitive (Marcus: "don't
  store anything sensitive for this exercise"), and not wired into COLA.
- **Batch is in scope.** Sarah called batch uploads a big want, so I treated it as part of
  the build rather than single-label only.

## Trade-offs / limitations

- The default engine needs a cloud API. Offline mode removes that, but at a real accuracy
  cost (OCR on fancy fonts, and it can't judge whether the warning is legible).
- Warning wording is checked by required-phrase presence, not an exact character match, for
  the OCR-reliability reason above.
- The dataset is just 2020+ approved labels, and I make negatives by perturbing the
  application — a stand-in for genuinely mislabeled submissions, which the registry doesn't
  have.
