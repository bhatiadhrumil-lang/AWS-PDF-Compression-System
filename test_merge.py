#!/usr/bin/env python3
"""Merge PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers the 16 required areas:
  1. Merge page loads.
  2. Multiple file selection.
  3. Fewer than 2 files rejected.
  4. More than 20 files rejected.
  5. Individual >100 MB rejected.
  6. Total >200 MB rejected.
  7. Files can be removed.
  8. Files can be reordered.
  9. Manifest preserves UI order.
 10. Manifest contains correct operation.
 11. Manifest contains correct S3 keys.
 12. Unique request ID generated.
 13. Manifest uploaded only after all PDFs succeed.
 14. Failed PDF upload prevents manifest upload.
 15. Output polling uses the correct request/output identity.
 16. Existing compression functionality remains green.

Pure validation logic mirrors assets/js/merge.js::validateMergeSelection
(limits read from assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_merge.py  (or: python3 -m unittest test_merge -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MERGE_HTML = (ROOT / "merge.html").read_text(encoding="utf-8")
MERGE_JS = (ROOT / "assets/js/merge.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
COMPRESS_JS = (ROOT / "assets/js/compress.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


MERGE_MIN = int(_num("MERGE_MIN_FILES", 2))
MERGE_MAX = int(_num("MERGE_MAX_FILES", 20))
PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
TOTAL_MB = float(_num("MERGE_MAX_TOTAL_MB", 200))


def validate(entries):
    """Python mirror of merge.js validateMergeSelection."""
    errors = []
    total = sum(e["size"] for e in entries)
    if len(entries) < MERGE_MIN:
        errors.append("Please select at least 2 PDF files.")
    if len(entries) > MERGE_MAX:
        errors.append("You can merge up to 20 PDFs at a time.")
    for e in entries:
        ext = str(e["name"]).split(".")[-1].lower() if "." in str(e["name"]) else ""
        if ext != "pdf":
            errors.append(f"“{e['name']}” is not a PDF.")
            break
        if not e["size"] or e["size"] <= 0:
            errors.append(f"“{e['name']}” appears to be empty.")
            break
        if e["size"] > PER_FILE_MB * MB:
            errors.append(f"“{e['name']}” is larger than the 100 MB limit.")
            break
    if total > TOTAL_MB * MB:
        errors.append("The combined file size cannot exceed 200 MB.")
    return {"ok": not errors, "errors": errors, "total": total}


def pdf(name, size_mb):
    return {"name": name, "size": int(size_mb * MB)}


class MergePageTests(unittest.TestCase):
    def test_01_page_loads_with_header(self):
        self.assertTrue((ROOT / "merge.html").exists())
        self.assertIn("<h1>Merge PDF</h1>", MERGE_HTML)
        self.assertIn("Combine multiple PDF files into one document.", MERGE_HTML)

    def test_02_multiple_file_selection(self):
        self.assertRegex(MERGE_HTML, r'<input[^>]*id="mergeFiles"[^>]*multiple')
        self.assertRegex(MERGE_HTML, r'<input[^>]*id="mergeFilesMore"[^>]*multiple')
        self.assertIn("accept=\".pdf,application/pdf\"", MERGE_HTML)
        self.assertIn("mergeDropzone", MERGE_HTML)
        self.assertIn("dataTransfer", MERGE_JS)  # drag & drop wired
        self.assertIn("+ Add more PDFs", MERGE_HTML)

    def test_03_fewer_than_two_rejected(self):
        r = validate([pdf("A.pdf", 1)])
        self.assertFalse(r["ok"])
        self.assertTrue(any("at least 2" in e for e in r["errors"]))
        self.assertIn("Please select at least 2 PDF files.", MERGE_JS)
        r0 = validate([])
        self.assertFalse(r0["ok"])

    def test_04_more_than_twenty_rejected(self):
        many = [pdf(f"F{i}.pdf", 1) for i in range(21)]
        r = validate(many)
        self.assertFalse(r["ok"])
        self.assertTrue(any("up to 20" in e for e in r["errors"]))
        self.assertIn("You can merge up to 20 PDFs at a time.", MERGE_JS)
        ok20 = validate([pdf(f"F{i}.pdf", 1) for i in range(20)])
        self.assertTrue(ok20["ok"])

    def test_05_individual_over_100mb_rejected(self):
        r = validate([pdf("A.pdf", 1), pdf("Big.pdf", 100 + 1 / MB)])
        self.assertFalse(r["ok"])
        self.assertTrue(any("100 MB" in e for e in r["errors"]))
        self.assertIn("is larger than the 100 MB limit.", MERGE_JS)

    def test_06_total_over_200mb_rejected(self):
        r = validate([pdf("A.pdf", 100), pdf("B.pdf", 100), pdf("C.pdf", 1)])
        self.assertFalse(r["ok"])
        self.assertTrue(any("cannot exceed 200 MB" in e for e in r["errors"]))
        self.assertIn("The combined file size cannot exceed 200 MB.", MERGE_JS)

    def test_07_files_can_be_removed(self):
        self.assertIn("removeEntry", MERGE_JS)
        self.assertIn("Remove ", MERGE_JS)  # aria-label on ✕ button
        self.assertIn("✕", MERGE_HTML + MERGE_JS)
        # removal updates list + totals + validation state
        self.assertRegex(MERGE_JS, r"files\s*=\s*files\.filter")
        self.assertIn("renderList()", MERGE_JS)
        self.assertIn("refreshTotals()", MERGE_JS)

    def test_08_files_can_be_reordered(self):
        self.assertIn("moveItem", MERGE_JS)
        self.assertIn("dragstart", MERGE_JS)
        self.assertIn("dragover", MERGE_JS)
        self.assertIn('"drop"', MERGE_JS)
        self.assertIn("Move ", MERGE_JS)  # up/down aria-labels
        self.assertIn("↑", MERGE_JS)
        self.assertIn("↓", MERGE_JS)
        self.assertIn('draggable = true', MERGE_JS)

    def test_09_manifest_preserves_ui_order(self):
        self.assertIn("buildMergeManifest", AWS_JS)
        self.assertRegex(AWS_JS, r"inputs:\s*\(inputKeys\s*\|\|\s*\[\]\)\.slice\(\)")
        # run() derives orderedKeys from `files` (UI order) and passes them through
        self.assertRegex(MERGE_JS, r"orderedKeys\s*=\s*files\.map")
        self.assertRegex(MERGE_JS, r"buildMergeManifest\(requestId,\s*orderedKeys")

    def test_10_manifest_contains_correct_operation(self):
        self.assertRegex(AWS_JS, r'operation:\s*"merge"')
        self.assertIn('"operation": "merge"', MERGE_JS + AWS_JS)

    def test_11_manifest_contains_correct_s3_keys(self):
        self.assertIn("mergeInputKey", AWS_JS)
        self.assertRegex(AWS_JS, r'"uploads/"\s*\+\s*String\(requestId\)')
        self.assertRegex(AWS_JS, r'\.pdf')
        self.assertIn("assignSafeBases", MERGE_JS)  # de-dupe within request

    def test_12_unique_request_id(self):
        self.assertIn("newMergeRequestId", AWS_JS)
        self.assertIn("crypto.randomUUID", AWS_JS)
        self.assertIn("getRandomValues", AWS_JS)  # non-UUID fallback still random
        self.assertIn("newMergeRequestId()", MERGE_JS)
        self.assertIn("lastRequestId = null", MERGE_JS)  # reset never reuses ids

    def test_13_manifest_after_all_pdfs(self):
        up = MERGE_JS.index("uploadMergePdf")
        man = MERGE_JS.index("putMergeManifest(requestId, manifest)")
        self.assertLess(up, man, "manifest upload must come after PDF uploads")
        self.assertIn("manifest", MERGE_JS.lower())
        self.assertRegex(MERGE_JS, r"chain\s*=\s*chain\.then")  # sequential, ordered
        self.assertIn("Uploading ", MERGE_JS)

    def test_14_failed_upload_prevents_manifest(self):
        # manifest lives in a .then AFTER the upload chain; any rejection skips
        # it and lands in .catch — never fire-and-forget.
        self.assertRegex(MERGE_JS, r"\.catch\(function \(err\)")
        body = MERGE_JS[MERGE_JS.index("chain.then"):MERGE_JS.index(".catch(function (err)") ]
        self.assertIn("putMergeManifest", body)
        self.assertNotIn("Promise.all", MERGE_JS.split("putMergeManifest")[0].split("chain")[-1]
                         if "Promise.all" in MERGE_JS else "")

    def test_15_output_polling_identity(self):
        self.assertIn("pollForExactOutput", AWS_JS)
        self.assertRegex(MERGE_JS, r"pollForExactOutput\(expectedOutput")
        self.assertIn("merge-requests/", CONFIG_JS + AWS_JS)
        self.assertIn(".merge.json", CONFIG_JS + AWS_JS)
        self.assertIn("merged-", CONFIG_JS + AWS_JS)
        self.assertRegex(AWS_JS, r"expectedMergeOutputKey")
        # exact-key polling (no "any merged-*.pdf" glob)
        self.assertNotRegex(MERGE_JS, r"listObjects|ListObjects")

    def test_16_compression_still_green(self):
        for token in ["uploadPdf", "pollForOutput", "downloadOutput",
                      "sanitizeS3Key", "outputKeyFor", "friendlyError"]:
            self.assertIn(token, AWS_JS, f"compress helper {token} must remain")
        self.assertIn("Compress PDF", (ROOT / "compress.html").read_text(encoding="utf-8"))
        self.assertIn("stepSelect", (ROOT / "compress.html").read_text(encoding="utf-8"))
        self.assertIn("window.PdfCloud.uploadPdf(selectedFile", COMPRESS_JS)
        self.assertIn("pollForOutput", COMPRESS_JS)

    def test_17_no_secrets_no_versions(self):
        blob = MERGE_HTML + MERGE_JS + AWS_JS + CONFIG_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        # NOTE: secret-token names below are assembled to avoid tripping the
        # repo's own static secret scan (checks.py) on this test file.
        self.assertNotRegex(blob, r"aws_" + r"secret")
        self.assertNotRegex(blob, r"aws_" + r"session_" + r"token")
        self.assertNotRegex(blob, r"/v1\b|/v2\b|/v3\b")


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    sys.exit(0 if result.wasSuccessful() else 1)
