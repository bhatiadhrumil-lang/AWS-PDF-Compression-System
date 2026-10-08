#!/usr/bin/env python3
"""Protect PDF frontend tests (no AWS credentials needed; all AWS mocked/static).

Covers:
  1. Protect page loads with expected header/copy.
  2. Single-PDF picker + drag & drop wired (PDF accept).
  3. Password + confirm fields present, min length 8, no autofill.
  4. Show/Hide password toggles wired.
  5. Stepper + result/error card ids present.
  6. Valid PDF accepted (pdf extension, mixed case).
  7. Non-PDF / empty / oversize rejected (mirror of page validation).
  8. Password validation: missing / short / mismatch (mirror of page checks).
  9. Password length bound read from config, JS and Python cannot drift.
 10. Output key shape protected/<id>/<stem>-protected.pdf (exact poll key).
 11. Manifest shape (operation/input/password/output_name) mirror.
 12. Manifest uploaded only after the PDF, password cleared before the poll.
 13. Password never appears in input/ouput-key builders or log lines.
 14. Tool registry marks protect available at protect.html.
 15. Request id generation exists and manifest/input keys embed it.
 16. No secrets / no version tags.

Pure validation logic mirrors assets/js/protect.js pre-export and the
window.PdfProtect.validateProtectSelection export (limits read from
assets/js/config.js so JS/Python cannot drift silently).
AWS interactions are never executed — JS is inspected statically.

Run: python3 test_protect.py  (or: python3 -m unittest test_protect -v)
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROTECT_HTML = (ROOT / "protect.html").read_text(encoding="utf-8")
PROTECT_JS = (ROOT / "assets/js/protect.js").read_text(encoding="utf-8")
AWS_JS = (ROOT / "assets/js/aws-client.js").read_text(encoding="utf-8")
CONFIG_JS = (ROOT / "assets/js/config.js").read_text(encoding="utf-8")
TOOLS_JS = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")

MB = 1024 * 1024


def _num(key, default):
    m = re.search(rf"{key}\s*:\s*([\d.]+)", CONFIG_JS)
    return float(m.group(1)) if m else default


PER_FILE_MB = float(_num("MAX_FILE_SIZE_MB", 100))
PROTECT_MIN_LEN = int(_num("PROTECT_MIN_PASSWORD_LEN", 8))


def validate_selection(entry):
    """Python mirror of protect.js validateProtectSelection."""
    errors = []
    if not entry:
        errors.append("Select a PDF file to begin.")
        return {"ok": False, "errors": errors}
    ext = str(entry.get("name") or "").split(".")[-1].lower() if "." in str(entry.get("name") or "") else ""
    if ext != "pdf":
        errors.append("not a PDF")
    if not entry.get("size") or entry.get("size") <= 0:
        errors.append("empty")
    if entry.get("size") and entry.get("size") > PER_FILE_MB * MB:
        errors.append("100 MB")
    return {"ok": not errors, "errors": errors}


def validate_passwords(password, confirm):
    """Python mirror of aws-client.js validateProtectPasswords."""
    errors = []
    pwd = password if isinstance(password, str) else ""
    if not pwd or len(pwd) < PROTECT_MIN_LEN:
        errors.append(f"Password must be at least {PROTECT_MIN_LEN} characters.")
    if not errors and str(confirm or "") != pwd:
        errors.append("Passwords do not match.")
    return {"ok": not errors, "errors": errors}


def sanitize_stem(name, fallback_id):
    """Python mirror of aws-client.js sanitizeSplitStem (shared, via
    sanitizeProtectStem)."""
    raw = str(name or "")
    raw = raw.split("/")[-1].split("\\")[-1].strip()
    raw = re.sub(r"[\x00-\x1f\x7f]", "", raw).strip()
    raw = re.sub(r"\.+$", "", raw)
    if re.search(r"\.zip$", raw, re.I):
        raw = raw[:-4]
    elif re.search(r"\.pdf$", raw, re.I):
        raw = raw[:-4]
    raw = re.sub(r"\.+$", "", raw).strip()
    if not raw:
        raw = str(fallback_id or "document")
    return raw[:200]


def expected_output_key(request_id, output_name):
    """Python mirror of aws-client.js expectedProtectOutputKey."""
    rid = str(request_id)
    stem = sanitize_stem(output_name, rid)
    return f"protected/{rid}/{stem}-protected.pdf"


def build_manifest(request_id, input_key, password, output_name):
    """Python mirror of aws-client.js buildProtectManifest."""
    return {
        "operation": "protect_pdf",
        "input": input_key,
        "password": password,
        "output_name": output_name or (str(request_id) + ".pdf"),
    }


class ProtectPageTests(unittest.TestCase):
    def test_01_page_loads(self):
        self.assertTrue((ROOT / "protect.html").exists())
        self.assertIn("<h1>Protect PDF</h1>", PROTECT_HTML)
        self.assertIn("protect.js", PROTECT_HTML)

    def test_02_single_picker_and_dropzone(self):
        m = re.search(r'<input[^>]*id="protectFiles"[^>]*>', PROTECT_HTML)
        self.assertIsNotNone(m)
        self.assertNotIn("multiple", m.group(0))
        self.assertIn('accept=".pdf,application/pdf"', PROTECT_HTML)
        self.assertIn("protectDropzone", PROTECT_HTML)
        self.assertIn("dataTransfer", PROTECT_JS)
        self.assertIn("dragover", PROTECT_JS)

    def test_03_password_fields(self):
        self.assertIn('id="protectPassword"', PROTECT_HTML)
        self.assertIn('id="protectConfirm"', PROTECT_HTML)
        self.assertIn('type="password"', PROTECT_HTML)
        self.assertIn('minlength="8"', PROTECT_HTML)
        self.assertIn('autocomplete="new-password"', PROTECT_HTML)
        self.assertIn("Choose a password", PROTECT_HTML)
        self.assertIn("protectPwdHint", PROTECT_HTML)

    def test_04_password_toggles(self):
        for toggle_id in ("protectToggle1", "protectToggle2"):
            self.assertIn(f'id="{toggle_id}"', PROTECT_HTML)
        self.assertIn("wirePasswordToggles", PROTECT_JS)
        self.assertIn('bind("protectToggle1", "protectPassword")', PROTECT_JS)
        self.assertIn('bind("protectToggle2", "protectConfirm")', PROTECT_JS)

    def test_05_stepper_and_cards(self):
        for step in ("Select", "Upload", "Process", "Done"):
            self.assertIn(f'id="protectStep{step}"', PROTECT_HTML)
        for elem in ("protectResultCard", "protectResultName", "protectDownloadBtn",
                     "protectAnotherBtn", "protectErrorCard", "protectErrorMessage",
                     "protectErrorDetails", "protectRetryBtn", "protectProgressFill",
                     "protectProgressPercent", "protectProgressWrap", "protectStatus",
                     "protectHint", "protectFileName", "protectBtn"):
            self.assertIn(f'id="{elem}"', PROTECT_HTML)

    def test_06_valid_pdf(self):
        self.assertTrue(validate_selection({"name": "a.pdf", "size": 100})["ok"])
        self.assertTrue(validate_selection({"name": "a.PDF", "size": 100})["ok"])
        self.assertIn("validateProtectSelection", PROTECT_JS)

    def test_07_invalid_pdf(self):
        self.assertFalse(validate_selection({"name": "a.txt", "size": 100})["ok"])
        self.assertFalse(validate_selection({"name": "notes.pdf", "size": 0})["ok"])
        self.assertFalse(
            validate_selection({"name": "a.pdf", "size": int(101 * MB)})["ok"])
        self.assertFalse(validate_selection(None)["ok"])

    def test_08_password_validation(self):
        self.assertTrue(validate_passwords("12345678", "12345678")["ok"])
        self.assertFalse(validate_passwords("", "12345678")["ok"])
        self.assertFalse(validate_passwords("123", "123")["ok"])
        self.assertFalse(validate_passwords("12345678", "87654321")["ok"])
        self.assertEqual(
            validate_passwords("12345678", "")["errors"][0],
            "Passwords do not match.")
        self.assertEqual(
            validate_passwords("short", "short")["errors"][0],
            f"Password must be at least {PROTECT_MIN_LEN} characters.")
        self.assertIn("validateProtectPasswords", AWS_JS)

    def test_09_min_length_bound_shared(self):
        self.assertEqual(PROTECT_MIN_LEN, 8)
        self.assertIn("PROTECT_MIN_PASSWORD_LEN", CONFIG_JS)
        self.assertIn("PROTECT_MIN_PASSWORD_LEN || 8", AWS_JS)
        self.assertIn("PROTECT_MIN_PASSWORD_LEN || 8", PROTECT_JS)

    def test_10_output_key_shape(self):
        self.assertIn("expectedProtectOutputKey", AWS_JS)
        self.assertIn('PROTECT_OUTPUT_DIR + "/" + id + "/', AWS_JS)
        self.assertIn('"-protected.pdf"', AWS_JS)
        self.assertNotIn('"-protect.pdf"', AWS_JS)
        self.assertEqual(
            expected_output_key("req-1", "invoice.pdf"),
            "protected/req-1/invoice-protected.pdf")
        self.assertEqual(
            expected_output_key("req-1", "my report.PDF"),
            "protected/req-1/my report-protected.pdf")
        self.assertEqual(
            expected_output_key("req-1", ""),
            "protected/req-1/req-1-protected.pdf")
        # Suffix convention mirrors the backend (append "-protected.pdf").
        self.assertIn("protected", CONFIG_JS)

    def test_11_manifest_shape(self):
        self.assertIn("buildProtectManifest", AWS_JS)
        m = build_manifest("req-1", "uploads/req-1/doc.pdf", "sekrit", "doc.pdf")
        self.assertEqual(m, {
            "operation": "protect_pdf",
            "input": "uploads/req-1/doc.pdf",
            "password": "sekrit",
            "output_name": "doc.pdf"
        })
        self.assertEqual(
            build_manifest("req-1", "uploads/req-1/doc.pdf", "s", None)["output_name"],
            "req-1.pdf")
        self.assertIn('operation: "protect_pdf"', AWS_JS)
        for field in ("input", "password", "output_name"):
            self.assertIn(field, AWS_JS)

    def test_12_sequencing_and_password_cleared(self):
        self.assertIn("uploadMergePdf", PROTECT_JS)
        self.assertIn("putProtectManifest", PROTECT_JS)
        self.assertIn("pollForExactOutput", PROTECT_JS)
        # PDF -> manifest (the trigger) -> exact-key poll; manifest must never
        # race the PDF, and the local password copy is dropped before upload.
        order = PROTECT_JS
        self.assertLess(order.index("uploadMergePdf"),
                        order.index("putProtectManifest"))
        self.assertLess(order.index('usePassword = ""'),
                        order.index("putProtectManifest"))
        self.assertLess(order.index("password = null"),
                        order.index("putProtectManifest"))
        self.assertLess(order.index("putProtectManifest"),
                        order.index("pollForExactOutput"))

    def test_13_password_never_in_keys_or_logs(self):
        # Key builders take only request id + safe name — never the password.
        key_lines = {
            "protectInputKey":
            'return "uploads/" + String(requestId) + "/" + String(safeBaseName);',
            "protectManifestKey":
            "return cfg.PROTECT_MANIFEST_PREFIX + String(requestId) "
            "+ cfg.PROTECT_MANIFEST_SUFFIX;",
            "expectedProtectOutputKey":
            'return cfg.PROTECT_OUTPUT_DIR + "/" + id + "/" + stem + "-protected.pdf";',
        }
        for fn, line in key_lines.items():
            self.assertIn(line, AWS_JS, fn)
            self.assertNotIn("password", line, fn)
        # No console.log line ever references the password.
        for js in (PROTECT_JS, AWS_JS):
            for line in js.splitlines():
                if "console.log(" in line:
                    self.assertNotIn("password", line)

    def test_14_tool_registered_available(self):
        m = re.search(
            r'id:\s*"protect".*?status:\s*"([^"]+)".*?href:\s*"([^"]+)"',
            TOOLS_JS, re.DOTALL)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "available")
        self.assertEqual(m.group(2), "protect.html")

    def test_15_request_id_and_keys(self):
        self.assertIn("newProtectRequestId", AWS_JS)
        self.assertIn("protectInputKey", AWS_JS)
        self.assertIn("protectManifestKey", AWS_JS)
        self.assertIn('"uploads/" + String(requestId)', AWS_JS)
        self.assertIn("PROTECT_MANIFEST_PREFIX + String(requestId)", AWS_JS)
        self.assertIn("PROTECT_MANIFEST_SUFFIX", AWS_JS)
        # putProtectManifest writes to INPUT_BUCKET with a JSON content type
        # (manifests and PDFs share the same input bucket).
        self.assertIn("Bucket: cfg.INPUT_BUCKET", AWS_JS)

    def test_16_config_constants(self):
        for key in ("PROTECT_MANIFEST_PREFIX", "PROTECT_MANIFEST_SUFFIX",
                    "PROTECT_OUTPUT_DIR", "PROTECT_INPUT_PREFIX",
                    "PROTECT_MIN_PASSWORD_LEN"):
            self.assertIn(key, CONFIG_JS)
        self.assertIn('PROTECT_MANIFEST_PREFIX: "protect-requests/"', CONFIG_JS)
        self.assertIn('PROTECT_MANIFEST_SUFFIX: ".protect.json"', CONFIG_JS)
        self.assertIn('PROTECT_OUTPUT_DIR: "protected"', CONFIG_JS)
        self.assertIn('PROTECT_INPUT_PREFIX: "uploads/"', CONFIG_JS)

    def test_17_download_and_reset(self):
        self.assertIn("downloadOutput", PROTECT_JS)
        self.assertIn("downloadOutput", AWS_JS)
        self.assertIn("protectResultName", PROTECT_JS)
        self.assertIn("resetAll", PROTECT_JS)
        self.assertIn("Protect Another PDF", PROTECT_HTML)

    def test_18_pure_helper_exported(self):
        self.assertIn("window.PdfProtect = {", PROTECT_JS)
        self.assertIn("validateProtectSelection: validateProtectSelection", PROTECT_JS)

    def test_19_no_secrets_no_versions(self):
        blob = PROTECT_HTML + PROTECT_JS + AWS_JS + CONFIG_JS
        self.assertNotRegex(blob, r"AKIA[0-9A-Z]{16}")
        self.assertNotIn("PRIVATE KEY", blob)
        for tag in ['"v1"', "'v1'", '"v2"', '"v3"', "versioned"]:
            self.assertNotIn(tag, blob)


if __name__ == "__main__":
    unittest.main()