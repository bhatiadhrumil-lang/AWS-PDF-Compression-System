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

  /* Output polling: every 5s, up to ~2 minutes (matches Lambda timeout budget). */
  POLL_INTERVAL_MS: 5000,
  POLL_MAX_ATTEMPTS: 24,

  /* Presigned download URL lifetime. */
  DOWNLOAD_URL_EXPIRES_S: 300,

  /* Pinned AWS SDK for JavaScript (v2) CDN build. */
  AWS_SDK_URL: "https://sdk.amazonaws.com/js/aws-sdk-2.1692.0.min.js"
};
