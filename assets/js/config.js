/* pdf-toolkit shared configuration.
 * Public identifiers only (region, identity pool, bucket names).
 * No secrets, passwords, access keys, or private keys belong here. */
window.PdfConfig = {
  REGION: "us-east-2",
  IDENTITY_POOL_ID: "us-east-2:0b8e0783-f3a2-40ba-93da-f970ead637b2",
  INPUT_BUCKET: "pdf-compressor-input-868942372673",
  OUTPUT_BUCKET: "pdf-compressor-output-868942372673",

  /* Upload guardrails (client-side, adjustable). */
  MAX_FILE_SIZE_MB: 100,
  ALLOWED_EXTENSIONS: ["pdf"],

  /* Merge PDF guardrails (mirror backend defaults; client-side only). */
  MERGE_MIN_FILES: 2,
  MERGE_MAX_FILES: 20,
  MERGE_MAX_TOTAL_MB: 200,
  MERGE_MANIFEST_PREFIX: "merge-requests/",
  MERGE_MANIFEST_SUFFIX: ".merge.json",
  MERGE_OUTPUT_PREFIX: "merged-",
  MERGE_INPUT_PREFIX: "uploads/",

  /* Split PDF guardrails (mirror backend defaults; client-side only). */
  SPLIT_MAX_RANGES: 50,
  SPLIT_MAX_OUTPUTS: 200,
  SPLIT_MANIFEST_PREFIX: "split-requests/",
  SPLIT_MANIFEST_SUFFIX: ".split.json",
  SPLIT_OUTPUT_DIR: "split",
  SPLIT_INPUT_PREFIX: "uploads/",

  /* Rotate PDF constants (mirror backend contract; client-side only).
   * Page-range syntax/limits are shared with split; rotation choices are
   * exactly the backend's supported degrees clockwise. */
  ROTATE_MANIFEST_PREFIX: "rotate-requests/",
  ROTATE_MANIFEST_SUFFIX: ".rotate.json",
  ROTATE_OUTPUT_DIR: "rotate",
  ROTATE_INPUT_PREFIX: "uploads/",
  ROTATE_OPTIONS: [90, 180, 270],

  /* Delete Pages constants (mirror backend contract; client-side only).
   * Page-range syntax/limits are shared with split/rotate. */
  DELETE_MANIFEST_PREFIX: "delete-requests/",
  DELETE_MANIFEST_SUFFIX: ".delete.json",
  DELETE_OUTPUT_DIR: "delete",
  DELETE_INPUT_PREFIX: "uploads/",

  /* Extract Pages constants (mirror backend contract; client-side only).
   * The page list is explicit ints in requested order (checkboxes and/or
   * range text expanded client-side); bounds are enforced by the backend,
   * which knows the document page count. */
  EXTRACT_MANIFEST_PREFIX: "extract-requests/",
  EXTRACT_MANIFEST_SUFFIX: ".extract.json",
  EXTRACT_OUTPUT_DIR: "extract",
  EXTRACT_INPUT_PREFIX: "uploads/",
  EXTRACT_MAX_PAGES: 500,

  /* JPG to PDF constants (mirror backend contract; client-side only).
   * Images upload to uploads/<id>/ and the manifest triggers conversion
   * into a single PDF with one image per page, in listed order. */
  JPG2PDF_MANIFEST_PREFIX: "jpg-to-pdf-requests/",
  JPG2PDF_MANIFEST_SUFFIX: ".jpg2pdf.json",
  JPG2PDF_OUTPUT_DIR: "jpg-to-pdf",
  JPG2PDF_INPUT_PREFIX: "uploads/",
  JPG2PDF_MAX_IMAGES: 20,
  JPG2PDF_MAX_TOTAL_MB: 200,

  /* Edit PDF v1 constants (mirror backend contract; client-side only).
   * Coordinates in manifests are PDF points, origin bottom-left
   * (see assets/js/edit.js); images upload as separate objects. */
  EDIT_MANIFEST_PREFIX: "edit-requests/",
  EDIT_MANIFEST_SUFFIX: ".edit.json",
  EDIT_OUTPUT_DIR: "edit",
  EDIT_INPUT_PREFIX: "uploads/",
  EDIT_SCHEMA_VERSION: 1,
  EDIT_MAX_EDITS: 200,
  EDIT_MAX_IMAGE_MB: 5,
  EDIT_IMAGE_PREFIX: "img-",

  /* Output polling: every 5s, up to ~2 minutes (matches Lambda timeout budget). */
  POLL_INTERVAL_MS: 5000,
  POLL_MAX_ATTEMPTS: 24,

  /* Presigned download URL lifetime. */
  DOWNLOAD_URL_EXPIRES_S: 300,

  /* Pinned AWS SDK for JavaScript (v2) CDN build. */
  AWS_SDK_URL: "https://sdk.amazonaws.com/js/aws-sdk-2.1692.0.min.js",

  /* Pinned pdf.js CDN build (edit-page preview rendering only). */
  PDFJS_URL: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  PDFJS_WORKER_URL: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
};
