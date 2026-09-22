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
    friendlyError: friendlyError,
    technicalDetails: technicalDetails,
    formatBytes: formatBytes
  };
})();
