# PDF Toolkit (frontend)

Cloud-native PDF processing platform — frontend repository.

Today this is a polished multi-tool home for the **working PDF compressor**,
with placeholders reserved for future tools. It stays deployable as plain
static files on S3 website hosting.

> No application versioning is used here (no `/v1`, `/v2` routes or tags).
> The backend image convention (`pdf-compressor:latest`) is untouched.

## Current Features

* [x] Multi-tool homepage (popular + all-tools grids rendered from one registry)
* [x] Compress PDF page (drag & drop, progress, compression stats, download)
* [x] Merge PDF page (multi-file picker + drag & drop, reorder, manifest upload, exact-output polling, download)
* [x] Split PDF page (single-file picker + drag & drop, every-page / ranges modes, manifest upload, exact-ZIP polling, download) — implemented, deployed, verified end-to-end
* [x] Rotate PDF page (single-file picker + drag & drop, 90°/180°/270° + all/selected pages, manifest upload, exact-output polling, download) — implemented, deployed, verified end-to-end
* [x] Delete Pages (single-file picker + drag & drop, pages-to-remove input, manifest upload, exact-output polling, download) — implemented, deployed, verified end-to-end
* [x] S3 upload via Cognito unauthenticated credentials (preserved behavior)
* [x] AWS Lambda processing status polling (preserved behavior)
* [x] S3 output presigned-URL download, 5-minute expiry (preserved behavior)
* [x] Filename-safe S3 keys (original basename preserved: spaces, parens,
  `#`, `+`, `&`, `%`, unicode; only path separators/controls neutralized,
  `.pdf` lowercased for the trigger filter; unique namespace per upload)
* [x] Friendly errors with expandable technical details
* [x] Editor + future-tool placeholder pages (honest “Coming soon”, no fake processing)
* [x] Edit PDF workspace (viewer, 14 tools, selection, undo/redo, page ops, manifest upload, exact-output polling, download) — implemented + tested, NOT deployed
* [x] Extract Pages (single-file picker + drag & drop, checkbox tiles + range entry, manifest upload, exact-output polling, download) — implemented + tested, NOT deployed
* [ ] PDF to JPG
* [ ] JPG to PDF
* [ ] Watermark PDF
* [ ] Add Page Numbers
* [ ] Protect PDF

Only `[x]` items actually work live, except where an item is explicitly
marked NOT deployed (code-complete but awaiting its deployment phase).

## Frontend architecture

Plain HTML + CSS + JavaScript — no framework, no build step. This is
deliberate: the site is hosted on S3 static website hosting, and the app is
small enough that a framework would add weight without benefit. Revisit only
when the interactive PDF editor lands (it will need canvas rendering).

```text
index.html            homepage: hero, popular tools, all tools, how-it-works
compress.html         dedicated compressor page (the working tool)
merge.html            merge page (multi-file select, reorder, progress, download)
edit.html             edit page (pdf.js preview, overlay editor, manifest, download)
tool.html?tool=<id>  generic placeholder for every other future tool
assets/css/styles.css shared stylesheet (responsive, mobile-first)
assets/js/config.js   public AWS identifiers + tunable limits (no secrets)
assets/js/tools.js    tool registry + icon set (single source of truth)
assets/js/aws-client.js Cognito/S3 service: upload, poll, download, errors (+ merge helpers)
assets/js/home.js     renders tool cards on the homepage
assets/js/compress.js compressor page flow
assets/js/merge.js    merge page flow (validate, reorder, ordered uploads, manifest, poll)
assets/js/edit.js     editor workspace (viewer, tools, selection, history, pages, apply flow)
assets/js/editor-coords.js pure coordinate math (PDF points, rotation composition)
assets/js/editor-state.js objects, page ops, undo/redo history
assets/js/editor-manifest.js manifest build + ordered S3 upload flow
assets/js/tool.js     renders generic placeholders from the registry
```

Adding a tool later: append one entry to `assets/js/tools.js`, point `href`
at its page (or `tool.html?tool=<id>` while it’s still a placeholder).

## AWS integration

```text
Browser → Cognito Identity Pool (temp creds, unauthenticated role)
        → PUT to S3 input bucket (ContentType application/pdf)
        → S3 ObjectCreated (.pdf) triggers Lambda container
        → Lambda writes "compressed-<name>" to S3 output bucket
        → browser polls HeadObject (5s, up to ~2 min)
        → presigned GET URL (300s) opened in a new tab
```

Configuration lives in `assets/js/config.js`: region, identity pool ID, bucket
names, size limit (100 MB), poll timing. These are public identifiers, not
secrets — no passwords, access keys, or private keys exist in this repo.

### Filename coordination with the backend

Upload keys PRESERVE the user's original basename — `My Report (Final).pdf`,
`Report #1.pdf`, `Report+Final.pdf`, `Report & Data.pdf`, `100% done.pdf`,
and unicode names all travel to S3 verbatim, namespaced for uniqueness
(`uploads/<unique-id>_<original-base>.pdf` for compress,
`uploads/<request-id>/<original-base>.pdf` for the tools). Only path
separators (`/`, `\`) and control characters are neutralized, and `.pdf` is
lowercased so the bucket's case-sensitive trigger always fires. The backend
URL-decodes S3 event keys, treats manifest keys verbatim (decoding those
used to corrupt real `+` characters — fixed), and preserves basenames in
output keys, so `compressed-My Report.pdf` is exactly what comes back.

Root cause of the original issue: the frontend used to map every
non-`[A-Za-z0-9._-]` character to `_`, destroying original filenames
(`My Report.pdf` → `My_Report.pdf`). That mangling was unnecessary — S3,
Lambda/boto3, Ghostscript (list-args invocation), and presigned URLs all
handle these characters — so it was removed. Downloads additionally carry
`ResponseContentDisposition` (`filename` + RFC 5987 `filename*`) so the
browser save dialog shows a friendly original-derived name. Verified live:
all seven problem filenames plus `%`/unicode compress end-to-end (browser
and CLI), including a `#` download; a `+` merge that 404'd before the
backend fix succeeds after it.

## Error handling

Users see plain-language messages (“Unable to upload the file. Please try
again.”); raw AWS codes live inside an expandable “Technical details”
section. Covered: invalid/empty/oversized files, upload failure, credential
failure, poll timeout (~2 min), network failure, permission failure, unknown
placeholder ids, AWS SDK load failure.

## Local preview & checks

```bash
python3 -m http.server 8000
# open http://localhost:8000/
python3 checks.py   # static validation (ids, links, registry, no secrets)
python3 test_merge.py  # merge frontend tests (validation, manifest, ordering, no AWS)
```

`checks.py` verifies: every element id referenced in JS exists in its HTML,
every local link/script/stylesheet target exists, every registry `href`
resolves, no AWS secret patterns are committed, and the SDK version is pinned
consistently. `test_merge.py` covers the merge page (multi-select, 2–20 and
100 MB / 200 MB limits, remove/reorder, manifest order + operation + keys,
unique request ids, manifest-after-uploads sequencing, exact-output polling)
plus a compression regression check. There is no automated browser test suite;
validation is static plus manual walkthrough (see commit message / PR notes).

### Merge PDF

Status:

* Backend: Implemented and deployed (Lambda runs the merge image;
  `.merge.json` suffix notification active on the input bucket).
* Frontend: Implemented and deployed to the S3 static website
  (`pdf-compressor-website-868942372673`, us-east-2) — Merge PDF UI is live
  end-to-end.

* Multi-file upload: picker (multiple) + drag & drop, “+ Add more PDFs”
  appends without resetting the list.
* Ordering: list shows position number + PDF icon + name + size + remove;
  HTML5 drag-and-drop reordering plus accessible ↑ / ↓ buttons. The manifest
  `inputs` array is built from the UI order and never re-sorted.
* Limits (enforced before upload): 2–20 files, 100 MB per file, 200 MB total,
  PDF extension required. Friendly messages; raw AWS errors stay in
  “Technical details”.
* Manifest architecture: one `crypto.randomUUID()` request id per job; PDFs go
  to `uploads/<id>/<safe>.pdf` in order, then the manifest
  `merge-requests/<id>.merge.json` is uploaded LAST (single Lambda trigger):
  `{ "operation": "merge", "inputs": [...], "output_name": "<id>.pdf" }`.
  A failed PDF upload rejects the chain, so the manifest is never sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `merged-<id>.pdf` (same 5 s / ~2 min pattern as compression) — never “any
  `merged-*.pdf`” — then downloads via the existing 5-minute presigned URL.

### Split PDF

Status:

* Backend: Implemented + deployed + verified (Lambda runs the split image;
  `.split.json` suffix notification active; split-all and ranges ZIPs
  validated on AWS, compress + merge regressions green).
* Frontend: Implemented + deployed to the S3 static website
  (`pdf-compressor-website-868942372673`, us-east-2) — Split PDF UI is live
  end-to-end, including a real headless-browser run (upload → ranges split
  → ZIP download with correct pages).

* Single-file upload: picker + drag & drop, PDF extension + 100 MB checked
  before upload; only the first file is kept if several are dropped.
* Modes: “Split every page” or “Split by page ranges” with a `1-3, 5, 8-10`
  textbox. Client validation mirrors the backend parser (singles, spans,
  whitespace tolerated; rejects 0, reversed, malformed, empty, duplicate and
  overlapping ranges, and more than 50 ranges). Page-count bounds are left to
  the backend, which knows the PDF.
* Manifest architecture: one `crypto.randomUUID()` request id per job; the
  PDF goes to `uploads/<id>/<safe>.pdf`, then the manifest
  `split-requests/<id>.split.json` is uploaded LAST (single Lambda trigger):
  `{ "operation": "split", "input": ..., "mode": "all" | "ranges",
  "ranges": [...], "output_name": "<safe>.pdf" }` (`ranges` omitted for
  `"all"`). A failed PDF upload rejects the chain, so the manifest is never
  sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `split/<id>/<stem>-split.zip` (same polling pattern) — then a single
  “Download ZIP” button uses the existing 5-minute presigned URL mechanism.

### Rotate PDF

Status:

* Backend: Implemented + deployed + verified (Lambda runs the rotate image;
  `.rotate.json` suffix notification active; 90°/180°/270° all-pages and
  selected-pages validated on AWS, invalid rotation rejected, compress +
  merge + split regressions green).
* Frontend: Implemented + deployed to the S3 static website
  (`pdf-compressor-website-868942372673`, us-east-2) — Rotate PDF UI is live
  end-to-end, including real headless-browser runs (90° all-pages and 180°
  selected-pages with correct output).

* Single-file upload: picker + drag & drop, PDF extension + 100 MB checked
  before upload; only the first file is kept if several are dropped.
* Rotation: 90° clockwise / 180° / 270° clockwise radios (exactly the
  backend's supported values; anything else is rejected client-side too).
* Pages: “All pages” or “Selected pages” with a `1-3, 5, 8-10` textbox.
  Range validation reuses the split parser (`parseSplitRanges` — one
  parser, no drift): singles, spans, whitespace tolerated; rejects 0,
  reversed, malformed, empty, duplicate and overlapping ranges, and more
  than 50 ranges. Page-count bounds are left to the backend.
* Manifest architecture: one `crypto.randomUUID()` request id per job; the
  PDF goes to `uploads/<id>/<safe>.pdf`, then the manifest
  `rotate-requests/<id>.rotate.json` is uploaded LAST (single Lambda
  trigger): `{ "operation": "rotate", "input": ..., "rotation": 90,
  "pages": "all" | [...], "output_name": "<safe>.pdf" }` (`pages` omitted
  for `"all"`). A failed PDF upload rejects the chain, so the manifest is
  never sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `rotate/<id>/<stem>-rotated.pdf` (same polling pattern) — then a single
  “Download rotated PDF” button uses the existing 5-minute presigned URL
  mechanism.

### Delete Pages

Status:

* Backend: Implemented + deployed + verified (Lambda runs the delete image;
  `.delete.json` suffix notification active; delete 2,4 → pages 1,3,5 and
  delete 1-4 → only page 5 validated on AWS, every-page deletion rejected,
  compress + merge + split + rotate regressions green).
* Frontend: Implemented + deployed to the S3 static website
  (`pdf-compressor-website-868942372673`, us-east-2) — Delete Pages UI is
  live end-to-end, including real headless-browser runs (delete 2,4 and
  1-4 with correct output, plus invalid-range rejection messaging).

* Single-file upload: picker + drag & drop, PDF extension + 100 MB checked
  before upload; only the first file is kept if several are dropped.
* Pages to remove: a `2-4, 7` textbox (“Pages entered here will be
  removed”). Range validation reuses the split parser (`parseSplitRanges`
  — one parser, no drift): singles, spans, whitespace tolerated; rejects
  empty, 0, reversed, malformed, duplicate and overlapping ranges, and more
  than 50 ranges. Empty selection blocks submission; page-count bounds and
  the every-page guard are enforced by the backend.
* Manifest architecture: one `crypto.randomUUID()` request id per job; the
  PDF goes to `uploads/<id>/<safe>.pdf`, then the manifest
  `delete-requests/<id>.delete.json` is uploaded LAST (single Lambda
  trigger): `{ "operation": "delete", "input": ...,
  "pages": ["2-4", "7"], "output_name": "<safe>.pdf" }`. A failed PDF
  upload rejects the chain, so the manifest is never sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `delete/<id>/<stem>-deleted.pdf` (same polling pattern) — then a single
  “Download PDF” button uses the existing 5-minute presigned URL mechanism.

### Extract Pages

Status:

* Backend: Implemented + tested, **NOT deployed** (no `.extract.json`
  trigger yet; deployment happens separately via the backend pipeline —
  never manually from here).
* Frontend: Implemented + statically tested, **NOT deployed**. Code pushed
  to GitHub; AWS deployment happens automatically via the existing
  CodePipeline — never manually.

* Single-file upload: picker + drag & drop, PDF extension + 100 MB checked
  before upload; only the first file is kept if several are dropped.
* Page selection: the page count is read locally via the pinned pdf.js
  build and every page becomes a checkbox tile (Select All / Clear);
  a `1, 3, 5-7` range box adds pages in listed order. The selection keeps
  REQUESTED order (`5, 2, 8` extracts 5, 2, 8) and duplicates normalize
  (`1,3,3,5-7` → `1, 3, 5, 6, 7`). Client validation rejects empty
  entries, 0, reversed and malformed ranges plus out-of-range pages (when
  the count is known) and selections over 500 pages; remaining bounds are
  enforced by the backend, which knows the PDF. If the preview library
  cannot load, range entry still works.
* Manifest architecture: one `crypto.randomUUID()` request id per job; the
  PDF goes to `uploads/<id>/<safe>.pdf`, then the manifest
  `extract-requests/<id>.extract.json` is uploaded LAST (single Lambda
  trigger): `{ "operation": "extract", "input": ...,
  "pages": [1, 3, 5, 6, 7], "output_name": "<safe>.pdf" }`. A failed PDF
  upload rejects the chain, so the manifest is never sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `extract/<id>/<stem>-extracted.pdf` (same polling pattern) — then a
  single “Download extracted PDF” button uses the existing 5-minute
  presigned URL mechanism. The source PDF is never modified.

### Edit PDF (professional editor workspace)

Status:

* Backend: Implemented + local/docker-tested, **NOT deployed** (no
  `.edit.json` trigger yet; Lambda still runs the pre-edit image).
* Frontend: Implemented + statically tested + headless-browser smoke-tested
  (12/12 interaction checks in real Chromium: boot, PDF load, thumbnails,
  text/rect placement, select, undo, manifest build, page-op, rotation
  composition), **NOT deployed**. Code pushed to GitHub; AWS deployment
  happens automatically via the existing CodePipeline — never manually.

* Workspace (`edit.html` + `assets/js/editor-*.js`, `edit.js`):
  top bar (Undo/Redo/Apply + live status), toolbars (Select, Text, Image,
  Rect, Ellipse, Line, Arrow, Highlight, Draw, Whiteout, Sign, Link,
  Replace, Eraser), thumbnail rail with per-page rotate/delete/move (drag
  reorder) + insert blank, single-page canvas (base PDF + overlay +
  optional text layer), zoom (fit/50–300%), status bar. Responsive:
  sidebar collapses to a horizontal rail on small screens. No Form tool —
  an unimplemented button would be misleading UI.
* Viewer: pages render via pinned pdf.js 3.11.174; net page rotations are
  baked into the base render so the canvas is WYSIWYG; pointer mapping
  inverts the same transform (shared formula with the backend). Fresh PDFs
  open at a responsive default scale (~100% when the workspace allows it,
  shrink-to-fit on medium screens, fit mode on tiny screens); Fit, zoom
  in/out, and percentage controls are unchanged.
* Objects: unique `edit-N` ids, bounding box + resize handles + rotation
  handle (images) + delete/duplicate, double-click/Enter text editing,
  arrow-key nudge, Delete key, Esc, Ctrl+Z / Ctrl+Y (+toolbar buttons),
  snapshot history (100 states, never a PDF reload). Text: 12 PDF-safe
  fonts, size, align, underline, color, opacity. Images: PNG/JPEG magic +
  size (5 MB) + dimension (12000 px) validation, aspect-aware placement,
  move/resize/rotate. Signature: drawn strokes (draw type) or uploaded
  image — session-only, never stored. Replace: pick the Replace tool,
  select existing text via the pdf.js text layer → a panel below the
  toolbar shows the selected text plus an editable New-text field
  (normal typing/paste/Backspace/Ctrl+A) with font/size/color →
  Preview (overlay-only) or Apply Replacement, which commits ONE
  history entry (whiteout + new text, single Ctrl+Z) and returns to
  Select; Cancel/Esc clears; Delete/Backspace on a selection covers
  just that region. Visual replacement only, documented in the UI.
  Global shortcuts never fire inside inputs (isFormElement guard).
  Eraser removes drawings/highlights/whiteouts. Links: box + URL panel, http/https only
  (javascript:/data:/file: rejected client AND server side).
* Coordinates: manifest units are PDF points, origin bottom-left.
  Overlays reference FINAL (post-page-op) pages; page rotations compose
  into geometry with the backend-identical formula at manifest build.
  The backend re-validates everything against the real mediabox.
* Manifest architecture: one `crypto.randomUUID()` request id per job; the
  PDF goes to `uploads/<id>/<safe>.pdf`, then overlay images to
  `uploads/<id>/img-<n>.png|jpg`, then the manifest
  `edit-requests/<id>.edit.json` is uploaded LAST (single Lambda trigger):
  `{ "operation": "edit", "version": 1, "input": ...,
  "output_name": "<safe>.pdf", "pages": [...], "edits": [...] }`
  (sequential uploads, never `Promise.all`). Any failed upload rejects
  the chain, so the manifest is never sent.
* Output handling: the frontend polls HeadObject for the EXACT key
  `edit/<id>/<stem>-edited.pdf` (same polling pattern) — then a single
  “Download edited PDF” button uses the existing 5-minute presigned URL
  mechanism.
* Limitations: whiteout is a visual cover, NOT secure redaction;
  no in-place mutation of existing PDF text (whiteout + replacement);
  12 built-in fonts only; single-line text; links http/https only.

## Deployment

Frontend is served from the existing S3 static website bucket
`pdf-compressor-website-868942372673` (us-east-2,
`pdf-compressor-website-868942372673.s3-website.us-east-2.amazonaws.com`).
Deploy with `aws s3 sync` WITHOUT `--delete` (legacy objects such as the
original `script.js`/`style.css` stay in place untouched): HTML with
`Cache-Control: no-cache`, JS/CSS with
`Cache-Control: public, max-age=300, must-revalidate`. Website
configuration (index document) is left as-is. Never commit `.env` files,
credentials, or keys.
