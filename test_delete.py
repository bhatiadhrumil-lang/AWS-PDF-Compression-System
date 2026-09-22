#!/usr/bin/env python3
"""Delete Pages frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. Delete page loads with expected header/copy.
  2. Single-file picker + drag & drop wired.
  3. Pages-to-remove input with example placeholder + explanation.
  4. Non-empty selection required (empty input rejected).
  5. Valid ranges accepted (single, span, multiple, whitespace).
  6. Invalid ranges rejected (0, negative, reversed, malformed, empty,
     duplicate, overlapping, too many).
  7. Non-PDF / oversize / empty file rejected.
  8. Tool registry marks delete-pages available at delete.html.
  9. Manifest builder shape (operation/input/pages/output_name).
 10. Manifest uploaded only after the PDF (static sequencing check).
 11. Output key shape delete/<id>/<stem>-deleted.pdf (exact poll).
 12. Download uses the existing presigned downloadOutput mechanism.
 13. Stem sanitization (traversal stripped, spaces/unicode kept).
 14. Request id + manifest/input key helpers.
 15. Config constants present.
 16. Ranges reuse the split parser (one parser, no copy).
 17. No secrets / no version tags.

Pure validation logic mirrors assets/js/aws-client.js::parseSplitRanges
(reused) and assets/js/delete.js::validateDeleteSelection (limits read from
assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_delete.py  (or: python3 -m unittest test_delete -v)
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DELETE_HTML = (ROOT / "delete.html").read_text(encoding="utf-8")
DELETE_JS = (ROOT / "assets/js/delete.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
SPLIT_MAX_RANGES = int(_num("SPLIT_MAX_RANGES", 50))


def parse_ranges(text):
    """Python mirror of the shared aws-client.js parseSplitRanges."""
    pieces = str(text or "").split(",")
    tokens = []
    for piece in pieces:
        trimmed = piece.strip()
        if not trimmed:
            return {"ok": False, "error": "empty"}
        tokens.append(trimmed)
    if len(tokens) > SPLIT_MAX_RANGES:
        return {"ok": False, "error": "up to"}
    spans = []
    seen = set()
    for tok in tokens:
        m_single = re.fullmatch(r"\d+", tok)
        m_span = re.fullmatch(r"(\d+)\s*-\s*(\d+)", tok)
        if m_single:
            start = end = int(m_single.group(0))
        elif m_span:
            start, end = int(m_span.group(1)), int(m_span.group(2))
        else:
            return {"ok": False, "error": "not a valid range"}
        if start < 1 or end < 1:
            return {"ok": False, "error": "start at 1"}
        if start > end:
            return {"ok": False, "error": "reversed"}
        if (start, end) in seen:
            return {"ok": False, "error": "twice"}
        if any(start <= b and a <= end for a, b in spans):
            return {"ok": False, "error": "overlap"}
        seen.add((start, end))
        spans.append((start, end))
    return {"ok": True, "ranges": tokens, "error": ""}


def validate_selection(entry):
    """Python mirror of delete.js validateDeleteSelection."""
    if not entry:
        return {"ok": False, "errors": ["Select a PDF file to begin."]}
    errors = []
    ext = str(entry["name"]).split(".")[-1].lower() if "." in str(entry["name"]) else ""
    if ext != "pdf":
        errors.append("not a PDF")
    if not entry["size"] or entry["size"] <= 0:
        errors.append("empty")
    if entry["size"] and entry["size"] > PER_FILE_MB * MB:
        errors.append("100 MB")
    return {"ok": not errors, "errors": errors}


def sanitize_stem(name, fallback="req"):
    """Python mirror of aws-client.js sanitizeDeleteStem."""
    raw = str(name or "").split("/")[-1].split("\\")[-1].strip()
    raw = re.sub(r"[\x00-\x1f\x7f]", "", raw).strip().strip(".")
    if re.search(r"\.zip$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    elif re.search(r"\.pdf$", raw, re.IGNORECASE):
        raw = raw[:-4].strip().strip(".")
    return (raw or fallback)[:200]


class DeletePageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "delete.html").exists())
        self.assertIn("<h1>Delete Pages</h1>", DELETE_HTML)
        self.assertIn("delete.js", DELETE_HTML)

    def test_02_single_file_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="deleteFiles"[^>]*>', DELETE_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', DELETE_HTML)
        self.assertIn("deleteDropzone", DELETE_HTML)
        self.assertIn("dataTransfer", DELETE_JS)

    def test_03_pages_input_with_example(self):
        self.assertIn('id="deletePages"', DELETE_HTML)
        self.assertIn("2-4, 7", DELETE_HTML)
        self.assertIn("will be removed", DELETE_HTML)

    def test_04_empty_selection_rejected(self):
        for text in ["", "   ", " , ", "1,,2"]:
            self.assertFalse(parse_ranges(text)["ok"], repr(text))

    def test_05_valid_ranges(self):
        for text, expected in [
            ("2", ["2"]),
            ("2-4", ["2-4"]),
            ("2-4,7", ["2-4", "7"]),
            ("1-3, 6, 8-10", ["1-3", "6", "8-10"]),
        ]:
            r = parse_ranges(text)
            self.assertTrue(r["ok"], text)
            self.assertEqual(r["ranges"], expected, text)

    def test_06_invalid_ranges(self):
        for text in ["0", "-2", "5-2", "abc", "1-", "1-2-3", "3,3",
                     "1-3,2-5",
                     ",".join(str(i) for i in range(1, SPLIT_MAX_RANGES + 2))]:
            self.assertFalse(parse_ranges(text)["ok"], text)
        self.assertIn("parseSplitRanges", DELETE_JS)

    def test_07_file_validation(self):
        self.assertFalse(validate_selection(None)["ok"])
        self.assertFalse(validate_selection({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate_selection({"name": "a.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate_selection({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertTrue(
            validate_selection({"name": "a.PDF", "size": int(10 * MB)})["ok"])
        self.assertIn("validateDeleteSelection", DELETE_JS)

    def test_08_tool_registered_available(self):
        m = re.search(
            r'id:\s*"delete-pages".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "delete.html")

    def test_09_manifest_shape(self):
        self.assertIn("buildDeleteManifest", AWS_JS)
        self.assertIn('operation: "delete"', AWS_JS)
        self.assertIn("pages: (pages", AWS_JS)
        self.assertIn("output_name", AWS_JS)

    def test_10_manifest_after_pdf(self):
        self.assertIn("putDeleteManifest", DELETE_JS)
        order = DELETE_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putDeleteManifest"))
        self.assertLess(order.index("putDeleteManifest"),
                        order.index("pollForExactOutput"))
        self.assertNotIn("Promise.all", DELETE_JS)

    def test_11_output_key_shape(self):
        self.assertIn("expectedDeleteOutputKey", AWS_JS)
        self.assertIn('DELETE_OUTPUT_DIR + "/" + id + "/" + stem + "-deleted.pdf"', AWS_JS)
        self.assertIn('DELETE_MANIFEST_PREFIX + String(requestId)', AWS_JS)
        self.assertIn('DELETE_MANIFEST_SUFFIX', AWS_JS)

    def test_12_download_via_presigned_url(self):
        self.assertIn("downloadOutput(lastOutputKey,", DELETE_JS)
        self.assertIn('$("deleteResultName").textContent', DELETE_JS)
        self.assertIn("Download PDF", DELETE_HTML)

    def test_13_stem_sanitization(self):
        self.assertEqual(sanitize_stem("document.pdf"), "document")
        self.assertEqual(sanitize_stem("../../etc/evil"), "evil")
        self.assertEqual(sanitize_stem("Q3 Report (final).pdf"), "Q3 Report (final)")
        self.assertEqual(sanitize_stem("caf\u00e9.pdf"), "caf\u00e9")
        self.assertEqual(sanitize_stem(""), "req")
        self.assertIn("sanitizeDeleteStem", AWS_JS)

    def test_14_request_id_and_keys(self):
        self.assertIn("newDeleteRequestId", AWS_JS)
        self.assertIn("deleteInputKey", AWS_JS)
        self.assertIn("deleteManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)

    def test_15_config_constants(self):
        for key in ["DELETE_MANIFEST_PREFIX", "DELETE_MANIFEST_SUFFIX",
                    "DELETE_OUTPUT_DIR", "DELETE_INPUT_PREFIX"]:
            self.assertIn(key, CONFIG_JS)
        self.assertIn('".delete.json"', CONFIG_JS)
        self.assertIn('"delete-requests/"', CONFIG_JS)

    def test_16_ranges_reuse_split_parser(self):
        self.assertIn("parseSplitRanges", DELETE_JS)
        self.assertNotIn("function parseDeleteRanges", AWS_JS)
        self.assertNotIn("function parseDeleteRanges", DELETE_JS)

    def test_17_no_secrets_no_versions(self):
        blob = DELETE_HTML + DELETE_JS + AWS_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()
