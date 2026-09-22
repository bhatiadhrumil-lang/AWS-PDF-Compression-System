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
* [x] S3 upload via Cognito unauthenticated credentials (preserved behavior)
* [x] AWS Lambda processing status polling (preserved behavior)
* [x] S3 output presigned-URL download, 5-minute expiry (preserved behavior)
* [x] Filename-safe S3 keys (UI shows the original name; storage key normalized)
* [x] Friendly errors with expandable technical details
* [x] Editor + future-tool placeholder pages (honest “Coming soon”, no fake processing)
* [ ] Edit PDF
* [ ] Merge PDF
* [ ] Split PDF
* [ ] Rotate PDF
* [ ] Delete Pages
* [ ] Extract Pages
* [ ] PDF to JPG
* [ ] JPG to PDF
* [ ] Watermark PDF
* [ ] Add Page Numbers
* [ ] Protect PDF

Only `[x]` items actually work. Everything else is a clearly-marked placeholder.

## Frontend architecture

Plain HTML + CSS + JavaScript — no framework, no build step. This is
deliberate: the site is hosted on S3 static website hosting, and the app is
small enough that a framework would add weight without benefit. Revisit only
when the interactive PDF editor lands (it will need canvas rendering).

```text
index.html            homepage: hero, popular tools, all tools, how-it-works
compress.html         dedicated compressor page (the working tool)
edit.html             editor placeholder (planned features, coming soon)
tool.html?tool=<id>  generic placeholder for every other future tool
assets/css/styles.css shared stylesheet (responsive, mobile-first)
assets/js/config.js   public AWS identifiers + tunable limits (no secrets)
assets/js/tools.js    tool registry + icon set (single source of truth)
assets/js/aws-client.js Cognito/S3 service: upload, poll, download, errors
assets/js/home.js     renders tool cards on the homepage
assets/js/compress.js compressor page flow
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

The Lambda backend reads the S3 event key raw and writes
`compressed-<basename(key)>`; S3 event keys are URL-encoded. So upload keys
must avoid spaces, parentheses, brackets, `+`, `&`, `%`, and unicode —
otherwise compression silently never produces output.

`PdfCloud.sanitizeS3Key()` enforces this: it maps any filename to
`uploads/<unique-id>_<safe-base>.pdf` (`[A-Za-z0-9._-]` only, extension
lowercased so the bucket’s case-sensitive `.pdf` trigger always fires, unique
prefix so concurrent uploads can’t overwrite each other). The UI always
displays the **original** filename exactly as-is. Examples:

* `My Report.pdf` → shown as-is, stored safely
* `My Important Report (Final).pdf` → shown as-is, stored safely
* `Invoice [September].PDF` → shown as-is, stored with lowercase `.pdf`

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
```

`checks.py` verifies: every element id referenced in JS exists in its HTML,
every local link/script/stylesheet target exists, every registry `href`
resolves, no AWS secret patterns are committed, and the SDK version is pinned
consistently. There is no automated browser test suite; validation is static
plus manual walkthrough (see commit message / PR notes).

## Deployment

Not automatic. Review → test → approve first; S3 website sync and any CI/CD
are handled separately. Never commit `.env` files, credentials, or keys.
