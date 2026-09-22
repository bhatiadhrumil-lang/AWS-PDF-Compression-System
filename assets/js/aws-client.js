/* AWS integration layer — single place where the browser talks to AWS.
 *
 * Preserved behavior (from the original script.js):
 *   Cognito Identity Pool -> temp creds -> s3.upload() to INPUT bucket
 *   (ContentType application/pdf) -> credential refresh ->
 *   HeadObject polling on OUTPUT bucket -> presigned GET URL (300s) -> new tab.
 *
 * Hard rule coordinated with the Lambda backend (src/app.py in the backend
 * repo): the backend reads the S3 event key raw and writes
 * "compressed-<basename(key)>". S3 event keys are URL-encoded, so upload
 * keys MUST use only S3-safe characters. The UI always displays the
 * ORIGINAL filename; only the S3 object key is sanitized.
 */
window.PdfCloud = (function () {
  var cfg = window.PdfConfig;
  var s3 = null;

  function init() {
    if (typeof AWS === "undefined") {
      throw new Error("AWS SDK failed to load.");
    }
    AWS.config.region = cfg.REGION;
    AWS.config.credentials = new AWS.CognitoIdentityCredentials({
      IdentityPoolId: cfg.IDENTITY_POOL_ID
    });
    s3 = new AWS.S3({ apiVersion: "2006-03-01" });
  }

  function ensureCredentials() {
    return new Promise(function (resolve, reject) {
      AWS.config.credentials.get(function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function refreshCredentials() {
    return new Promise(function (resolve, reject) {
      AWS.config.credentials.refresh(function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /* Map any filename to an S3-safe object key.
   * Keeps [A-Za-z0-9._-], replaces everything else (spaces, parentheses,
   * brackets, +, &, %, unicode, ...) with "_", normalizes the extension to
   * lowercase ".pdf" (the bucket trigger suffix filter is case-sensitive),
   * and prefixes a unique id so concurrent uploads never overwrite each
   * other in the shared bucket. */
  function sanitizeS3Key(originalName) {
    var name = String(originalName || "document.pdf");
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    if (ext !== ".pdf") ext = ".pdf";
    try {
      base = base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    } catch (e) { /* older browsers: keep base as-is */ }
    base = base
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "");
    if (!base) base = "document";
    base = base.slice(0, 120);
    var uniq =
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8);
    return "uploads/" + uniq + "_" + base + ext;
  }

  /* Backend naming contract: output key = "compressed-" + basename(input key). */
  function outputKeyFor(inputKey) {
    var base = String(inputKey).split("/").pop();
    return "compressed-" + base;
  }

  function validatePdfFile(file) {
    if (!file) return { ok: false, reason: "empty" };
    var name = file.name || "";
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (cfg.ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
      return { ok: false, reason: "type" };
    }
    if (file.size === 0) return { ok: false, reason: "empty" };
    if (file.size > cfg.MAX_FILE_SIZE_MB * 1024 * 1024) {
      return { ok: false, reason: "size" };
    }
    return { ok: true };
  }

  /* Uploads the file; resolves with the S3 key used. */
  function uploadPdf(file, onProgress) {
    var key = sanitizeS3Key(file.name);
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        var task = s3.upload({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: file,
          ContentType: "application/pdf"
        });
        task.on("httpUploadProgress", function (e) {
          if (onProgress && e.total) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        task.send(function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  function headOutput(outputKey) {
    var out = new AWS.S3({ region: cfg.REGION });
    return new Promise(function (resolve, reject) {
      out.headObject(
        { Bucket: cfg.OUTPUT_BUCKET, Key: outputKey },
        function (err, data) {
          if (err) reject(err);
          else resolve(data || {});
        }
      );
    });
  }

  /* Polls until the output object appears, the timeout expires, or a
   * non-NotFound error occurs. Resolves with { outputKey, size }. */
  function pollForOutput(inputKey, onTick) {
    var target = outputKeyFor(inputKey);
    var attempts = 0;
    return refreshCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        var timer = setInterval(function () {
          attempts++;
          headOutput(target).then(
            function (data) {
              clearInterval(timer);
              resolve({ outputKey: target, size: data.ContentLength || 0 });
            },
            function (err) {
              var code = err && err.code;
              if (code === "NotFound" || code === "NoSuchKey") {
                if (onTick) onTick(attempts, cfg.POLL_MAX_ATTEMPTS);
                if (attempts >= cfg.POLL_MAX_ATTEMPTS) {
                  clearInterval(timer);
                  var timeout = new Error("Polling timed out.");
                  timeout.code = "PollTimeout";
                  reject(timeout);
                }
                return; // keep waiting
              }
              clearInterval(timer);
              reject(err);
            }
          );
        }, cfg.POLL_INTERVAL_MS);
      });
    });
  }

  function downloadOutput(outputKey) {
    var out = new AWS.S3({ region: cfg.REGION });
    var url = out.getSignedUrl("getObject", {
      Bucket: cfg.OUTPUT_BUCKET,
      Key: outputKey,
      Expires: cfg.DOWNLOAD_URL_EXPIRES_S
    });
    window.open(url, "_blank", "noopener");
  }

  /* ---------------- Merge PDF helpers (additive; compress path untouched) ----
   *
   * Backend merge contract (see backend repo README, reference only):
   *   inputs:  "uploads/<request-id>/<safe>.pdf" (same INPUT bucket, UI order)
   *   manifest:"merge-requests/<request-id>.merge.json"
   *     { "operation": "merge", "inputs": [...], "output_name": "<id>.pdf" }
   *   output:  "merged-<id>.pdf" (flat in OUTPUT bucket)
   *
   * The manifest is the Lambda trigger and MUST be uploaded only after every
   * PDF upload has succeeded (see merge.js sequencing).
   */

  function newMergeRequestId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (e) { /* fall through to fallback */ }
    // Fallback: timestamp + strong random (still collision-safe for this use).
    var rand = "";
    try {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) {
        rand += ("0" + bytes[i].toString(16)).slice(-2);
      }
    } catch (e2) {
      rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return "merge-" + Date.now().toString(36) + "-" + String(rand).slice(0, 12);
  }

  /* S3-safe basename for one merge input (mirrors sanitizeS3Key rules but
   * without the unique prefix — the request id already namespaces inputs). */
  function sanitizeMergeBase(originalName) {
    var name = String(originalName || "document.pdf");
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    if (ext !== ".pdf") ext = ".pdf";
    try {
      base = base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    } catch (e) { /* older browsers: keep base as-is */ }
    base = base
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "");
    if (!base) base = "document";
    return base.slice(0, 120) + ext;
  }

  /* Full input key for one merge file: uploads/<request-id>/<safe-base>.
   * Callers de-duplicate safe names within a request (see merge.js). */
  function mergeInputKey(requestId, safeBaseName) {
    return "uploads/" + String(requestId) + "/" + String(safeBaseName);
  }

  function mergeManifestKey(requestId) {
    return cfg.MERGE_MANIFEST_PREFIX + String(requestId) + cfg.MERGE_MANIFEST_SUFFIX;
  }

  /* Mirrors backend sanitization enough to predict the exact output key:
   * drop directory components, strip control chars, enforce .pdf. Spaces,
   * parens, brackets, &, unicode are preserved (backend preserves them too). */
  function sanitizeMergeOutputName(name, fallbackId) {
    var raw = String(name || "");
    raw = raw.split("/").pop().split("\\").pop().trim();
    // eslint-disable-next-line no-control-regex
    raw = raw.replace(/[\x00-\x1f\x7f]/g, "");
    if (!raw) raw = String(fallbackId || "document") + ".pdf";
    if (!/\.pdf$/i.test(raw)) raw = raw + ".pdf";
    return raw;
  }

  /* Deterministic output key for a request: "merged-" + safe output_name.
   * We always send output_name = "<request-id>.pdf" so the expected key is
   * "merged-<request-id>.pdf" — unique per request, no cross-user collisions. */
  function expectedMergeOutputKey(requestId, outputName) {
    var safe = sanitizeMergeOutputName(outputName || (String(requestId) + ".pdf"), requestId);
    return cfg.MERGE_OUTPUT_PREFIX + safe;
  }

  /* Pure manifest builder — preserves the exact UI order of inputKeys. */
  function buildMergeManifest(requestId, inputKeys, outputName) {
    return {
      operation: "merge",
      inputs: (inputKeys || []).slice(),
      output_name: outputName || (String(requestId) + ".pdf")
    };
  }

  /* Upload one merge PDF to its exact namespaced key (order preserved by the
   * caller, which awaits all uploads before writing the manifest). */
  function uploadMergePdf(file, key, onProgress) {
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        var task = s3.upload({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: file,
          ContentType: "application/pdf"
        });
        task.on("httpUploadProgress", function (e) {
          if (onProgress && e.total) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
        task.send(function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  /* Upload the merge manifest (final trigger — call only after ALL pdf
   * uploads succeeded). Resolves with the manifest key. */
  function putMergeManifest(requestId, manifestObj) {
    var key = mergeManifestKey(requestId);
    var body = JSON.stringify(manifestObj);
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        s3.putObject({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: body,
          ContentType: "application/json"
        }, function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  /* Poll for one EXACT output key (merge). Unlike compress polling, this never
   * guesses — the key embeds the request id, so concurrent users can't collide. */
  function pollForExactOutput(outputKey, onTick) {
    var attempts = 0;
    return refreshCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        var timer = setInterval(function () {
          attempts++;
          headOutput(outputKey).then(
            function (data) {
              clearInterval(timer);
              resolve({ outputKey: outputKey, size: data.ContentLength || 0 });
            },
            function (err) {
              var code = err && err.code;
              if (code === "NotFound" || code === "NoSuchKey") {
                if (onTick) onTick(attempts, cfg.POLL_MAX_ATTEMPTS);
                if (attempts >= cfg.POLL_MAX_ATTEMPTS) {
                  clearInterval(timer);
                  var timeout = new Error("Polling timed out.");
                  timeout.code = "PollTimeout";
                  reject(timeout);
                }
                return; // keep waiting
              }
              clearInterval(timer);
              reject(err);
            }
          );
        }, cfg.POLL_INTERVAL_MS);
      });
    });
  }

  function friendlyError(err, context) {
    var code = (err && (err.code || err.name)) || "";
    if (err && err.code === "PollTimeout") {
      return "Processing is taking longer than expected. Your file may still appear — please try again in a minute.";
    }
    if (
      code === "NetworkingError" ||
      code === "NetworkFailure" ||
      code === "TimeoutError" ||
      (err && err.message && /network|failed to fetch|load failed/i.test(err.message))
    ) {
      return "Network problem. Check your connection and try again.";
    }
    if (/credential|identity|token|expired/i.test(code + " " + ((err && err.message) || ""))) {
      return "Could not sign you in to the upload service. Please reload and try again.";
    }
    if (code === "AccessDenied" || code === "Forbidden" || code === "NotAuthorized") {
      return "You don't have permission to do that right now. Please reload and try again.";
    }
    if (context === "upload") return "Unable to upload the file. Please try again.";
    if (context === "poll") return "Could not check the processing status. Please try again.";
    return "Something went wrong. Please try again.";
  }

  /* ---------------- Split PDF helpers (additive; merge/compress untouched) ---
   *
   * Backend split contract (see backend repo README, reference only):
   *   input:   "uploads/<request-id>/<safe>.pdf" (same INPUT bucket)
   *   manifest:"split-requests/<request-id>.split.json" (uploaded AFTER pdf)
   *     { "operation": "split", "input": ..., "mode": "all" | "ranges",
   *       "ranges": ["1-3", "5"], "output_name": "<safe>.pdf" }
   *   output:  "split/<request-id>/<stem>-split.zip" (flat ZIP, exact poll)
   *
   * The manifest is the Lambda trigger and MUST be uploaded only after the
   * PDF upload has succeeded (see split.js sequencing).
   */

  function newSplitRequestId() {
    return newMergeRequestId();
  }

  /* Full input key for the split source PDF. */
  function splitInputKey(requestId, safeBaseName) {
    return "uploads/" + String(requestId) + "/" + String(safeBaseName);
  }

  function splitManifestKey(requestId) {
    return cfg.SPLIT_MANIFEST_PREFIX + String(requestId) + cfg.SPLIT_MANIFEST_SUFFIX;
  }

  /* Mirror of backend sanitize_split_stem: drop directories, strip control
   * chars, remove a trailing .pdf/.zip, keep spaces/parens/unicode. */
  function sanitizeSplitStem(name, fallbackId) {
    var raw = String(name || "");
    raw = raw.split("/").pop().split("\\").pop().trim();
    // eslint-disable-next-line no-control-regex
    raw = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
    raw = raw.replace(/\.+$/, "");
    if (/\.zip$/i.test(raw)) raw = raw.slice(0, -4).replace(/\.+$/, "").trim();
    else if (/\.pdf$/i.test(raw)) raw = raw.slice(0, -4).replace(/\.+$/, "").trim();
    if (!raw) raw = String(fallbackId || "document");
    return raw.slice(0, 200);
  }

  /* Deterministic output key: "split/<id>/<stem>-split.zip". The backend
   * derives the identical key, so the page polls this EXACT object. */
  function expectedSplitOutputKey(requestId, outputName) {
    var id = String(requestId);
    var stem = sanitizeSplitStem(outputName, id);
    return cfg.SPLIT_OUTPUT_DIR + "/" + id + "/" + stem + "-split.zip";
  }

  /* Pure manifest builder. Ranges mode carries the token list in order;
   * "all" mode carries no ranges (backend rejects ranges with mode all). */
  function buildSplitManifest(requestId, inputKey, mode, ranges, outputName) {
    var manifest = {
      operation: "split",
      input: inputKey,
      mode: mode === "ranges" ? "ranges" : "all",
      output_name: outputName || (String(requestId) + ".pdf")
    };
    if (manifest.mode === "ranges") {
      manifest.ranges = (ranges || []).slice();
    }
    return manifest;
  }

  /* Pure page-range parser over the ranges textbox. Returns
   * { ok, ranges[], error }. Syntax only ("5", "1-3", comma-separated);
   * page-count bounds are enforced by the backend, which knows the PDF. */
  function parseSplitRanges(text) {
    var max = cfg.SPLIT_MAX_RANGES || 50;
    var raw = String(text || "");
    var pieces = raw.split(",");
    var tokens = [];
    for (var k = 0; k < pieces.length; k++) {
      var trimmed = pieces[k].trim();
      if (!trimmed) {
        return { ok: false, ranges: [], error: "There is an empty range — check for stray commas (e.g. “1,,2”)." };
      }
      tokens.push(trimmed);
    }
    if (!tokens.length) {
      return { ok: false, ranges: [], error: "Enter at least one page range, e.g. 1-3, 5, 8-10." };
    }
    if (tokens.length > max) {
      return { ok: false, ranges: [], error: "You can request up to " + max + " ranges at a time." };
    }
    var seen = {};
    var spans = [];
    for (var i = 0; i < tokens.length; i++) {
      var single = /^\d+$/.exec(tokens[i]);
      var span = /^(\d+)\s*-\s*(\d+)$/.exec(tokens[i]);
      var start = 0, end = 0;
      if (single) {
        start = end = parseInt(single[0], 10);
      } else if (span) {
        start = parseInt(span[1], 10);
        end = parseInt(span[2], 10);
      } else {
        return { ok: false, ranges: [], error: "“" + tokens[i] + "” is not a valid range. Use a page like 5 or a span like 1-3." };
      }
      if (start < 1 || end < 1) {
        return { ok: false, ranges: [], error: "“" + tokens[i] + "” is not valid — pages start at 1." };
      }
      if (start > end) {
        return { ok: false, ranges: [], error: "“" + tokens[i] + "” is reversed — the first page must come first." };
      }
      var key = start + "-" + end;
      if (seen[key]) {
        return { ok: false, ranges: [], error: "“" + tokens[i] + "” is listed twice — each range may appear once." };
      }
      for (var j = 0; j < spans.length; j++) {
        if (start <= spans[j][1] && spans[j][0] <= end) {
          return { ok: false, ranges: [], error: "“" + tokens[i] + "” overlaps an earlier range — each page may appear once." };
        }
      }
      seen[key] = true;
      spans.push([start, end]);
    }
    return { ok: true, ranges: tokens, error: "" };
  }

  /* Upload the split manifest (final trigger — call only after the PDF
   * upload succeeded). Resolves with the manifest key. */
  function putSplitManifest(requestId, manifestObj) {
    var key = splitManifestKey(requestId);
    var body = JSON.stringify(manifestObj);
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        s3.putObject({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: body,
          ContentType: "application/json"
        }, function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  /* ---------------- Rotate PDF helpers (additive; others untouched) ------
   *
   * Backend rotate contract (see backend repo README, reference only):
   *   input:   "uploads/<request-id>/<safe>.pdf" (same INPUT bucket)
   *   manifest:"rotate-requests/<request-id>.rotate.json" (uploaded AFTER pdf)
   *     { "operation": "rotate", "input": ..., "rotation": 90 | 180 | 270,
   *       "pages": "all" | ["1-3", "5"], "output_name": "<safe>.pdf" }
   *   output:  "rotate/<request-id>/<stem>-rotated.pdf" (exact poll)
   *
   * Page-range syntax is identical to split, so parseSplitRanges is reused
   * directly — one parser, no drift. Rotation labels are UI-only; the
   * manifest carries the numeric degrees clockwise.
   */

  function newRotateRequestId() {
    return newMergeRequestId();
  }

  function rotateInputKey(requestId, safeBaseName) {
    return "uploads/" + String(requestId) + "/" + String(safeBaseName);
  }

  function rotateManifestKey(requestId) {
    return cfg.ROTATE_MANIFEST_PREFIX + String(requestId) + cfg.ROTATE_MANIFEST_SUFFIX;
  }

  /* Mirror of backend stem sanitization (shared with split stems). */
  function sanitizeRotateStem(name, fallbackId) {
    return sanitizeSplitStem(name, fallbackId);
  }

  /* Deterministic output key: "rotate/<id>/<stem>-rotated.pdf". The backend
   * derives the identical key, so the page polls this EXACT object. */
  function expectedRotateOutputKey(requestId, outputName) {
    var id = String(requestId);
    var stem = sanitizeRotateStem(outputName, id);
    return cfg.ROTATE_OUTPUT_DIR + "/" + id + "/" + stem + "-rotated.pdf";
  }

  /* Pure manifest builder. "all" carries no pages list (backend defaults);
   * selected pages carry the token list in order. */
  function buildRotateManifest(requestId, inputKey, rotation, pages, outputName) {
    var manifest = {
      operation: "rotate",
      input: inputKey,
      rotation: rotation,
      output_name: outputName || (String(requestId) + ".pdf")
    };
    if (pages !== "all") {
      manifest.pages = (pages || []).slice();
    }
    return manifest;
  }

  /* Pure rotation validator: exactly 90, 180, or 270. */
  function parseRotateAngle(value) {
    var options = cfg.ROTATE_OPTIONS || [90, 180, 270];
    var angle = typeof value === "string" && value.trim() !== ""
      ? Number(value) : value;
    if (typeof angle !== "number" || Math.floor(angle) !== angle ||
        options.indexOf(angle) === -1) {
      return { ok: false, angle: 0,
               error: "Choose a rotation: 90°, 180°, or 270°." };
    }
    return { ok: true, angle: angle, error: "" };
  }

  /* Upload the rotate manifest (final trigger — call only after the PDF
   * upload succeeded). Resolves with the manifest key. */
  function putRotateManifest(requestId, manifestObj) {
    var key = rotateManifestKey(requestId);
    var body = JSON.stringify(manifestObj);
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        s3.putObject({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: body,
          ContentType: "application/json"
        }, function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  /* ---------------- Delete Pages helpers (additive; others untouched) ----
   *
   * Backend delete contract (see backend repo README, reference only):
   *   input:   "uploads/<request-id>/<safe>.pdf" (same INPUT bucket)
   *   manifest:"delete-requests/<request-id>.delete.json" (uploaded AFTER pdf)
   *     { "operation": "delete", "input": ...,
   *       "pages": ["2-4", "7"], "output_name": "<safe>.pdf" }
   *   output:  "delete/<request-id>/<stem>-deleted.pdf" (exact poll)
   *
   * Page-range syntax is identical to split/rotate, so parseSplitRanges is
   * reused directly — one parser, no drift. Deleting every page is rejected
   * by the backend (a zero-page PDF is never produced).
   */

  function newDeleteRequestId() {
    return newMergeRequestId();
  }

  function deleteInputKey(requestId, safeBaseName) {
    return "uploads/" + String(requestId) + "/" + String(safeBaseName);
  }

  function deleteManifestKey(requestId) {
    return cfg.DELETE_MANIFEST_PREFIX + String(requestId) + cfg.DELETE_MANIFEST_SUFFIX;
  }

  /* Mirror of backend stem sanitization (shared with split/rotate stems). */
  function sanitizeDeleteStem(name, fallbackId) {
    return sanitizeSplitStem(name, fallbackId);
  }

  /* Deterministic output key: "delete/<id>/<stem>-deleted.pdf". The backend
   * derives the identical key, so the page polls this EXACT object. */
  function expectedDeleteOutputKey(requestId, outputName) {
    var id = String(requestId);
    var stem = sanitizeDeleteStem(outputName, id);
    return cfg.DELETE_OUTPUT_DIR + "/" + id + "/" + stem + "-deleted.pdf";
  }

  /* Pure manifest builder. Pages are required (backend rejects empties). */
  function buildDeleteManifest(requestId, inputKey, pages, outputName) {
    return {
      operation: "delete",
      input: inputKey,
      pages: (pages || []).slice(),
      output_name: outputName || (String(requestId) + ".pdf")
    };
  }

  /* Upload the delete manifest (final trigger — call only after the PDF
   * upload succeeded). Resolves with the manifest key. */
  function putDeleteManifest(requestId, manifestObj) {
    var key = deleteManifestKey(requestId);
    var body = JSON.stringify(manifestObj);
    return ensureCredentials().then(function () {
      return new Promise(function (resolve, reject) {
        s3.putObject({
          Bucket: cfg.INPUT_BUCKET,
          Key: key,
          Body: body,
          ContentType: "application/json"
        }, function (err) {
          if (err) reject(err);
          else resolve(key);
        });
      });
    });
  }

  function technicalDetails(err) {
    if (!err) return "No technical details available.";
    var code = err.code || err.name || "UnknownError";
    var msg = err.message || String(err);
    return code + ": " + msg;
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  return {
    init: init,
    sanitizeS3Key: sanitizeS3Key,
    outputKeyFor: outputKeyFor,
    validatePdfFile: validatePdfFile,
    uploadPdf: uploadPdf,
    pollForOutput: pollForOutput,
    headOutput: headOutput,
    downloadOutput: downloadOutput,
    newMergeRequestId: newMergeRequestId,
    sanitizeMergeBase: sanitizeMergeBase,
    mergeInputKey: mergeInputKey,
    mergeManifestKey: mergeManifestKey,
    sanitizeMergeOutputName: sanitizeMergeOutputName,
    expectedMergeOutputKey: expectedMergeOutputKey,
    buildMergeManifest: buildMergeManifest,
    uploadMergePdf: uploadMergePdf,
    putMergeManifest: putMergeManifest,
    pollForExactOutput: pollForExactOutput,
    newSplitRequestId: newSplitRequestId,
    splitInputKey: splitInputKey,
    splitManifestKey: splitManifestKey,
    sanitizeSplitStem: sanitizeSplitStem,
    expectedSplitOutputKey: expectedSplitOutputKey,
    buildSplitManifest: buildSplitManifest,
    parseSplitRanges: parseSplitRanges,
    putSplitManifest: putSplitManifest,
    newRotateRequestId: newRotateRequestId,
    rotateInputKey: rotateInputKey,
    rotateManifestKey: rotateManifestKey,
    sanitizeRotateStem: sanitizeRotateStem,
    expectedRotateOutputKey: expectedRotateOutputKey,
    buildRotateManifest: buildRotateManifest,
    parseRotateAngle: parseRotateAngle,
    putRotateManifest: putRotateManifest,
    newDeleteRequestId: newDeleteRequestId,
    deleteInputKey: deleteInputKey,
    deleteManifestKey: deleteManifestKey,
    sanitizeDeleteStem: sanitizeDeleteStem,
    expectedDeleteOutputKey: expectedDeleteOutputKey,
    buildDeleteManifest: buildDeleteManifest,
    putDeleteManifest: putDeleteManifest,
    friendlyError: friendlyError,
    technicalDetails: technicalDetails,
    formatBytes: formatBytes
  };
})();
