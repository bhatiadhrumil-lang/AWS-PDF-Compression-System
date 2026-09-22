#!/usr/bin/env python3
"""Static validation for the PDF Toolkit frontend (no browser needed).

Checks:
  1. Every DOM id referenced in page JS exists in that page's HTML.
  2. Every local link / script / stylesheet target resolves to a file.
  3. Every tool-registry href resolves (tool.html?tool=<id> ids exist).
  4. No secret-like patterns committed (access keys, PEM blocks, .env).
  5. AWS SDK version pinned consistently (config + HTML script tags).
  6. Balanced braces/parens/brackets in JS (rough syntax sanity).
  7. Tool placeholder pages never contain fake processing hooks.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
fails = []


def fail(msg):
    fails.append(msg)
    print("FAIL:", msg)


def ok(msg):
    print("ok:", msg)


HTML_FILES = ["index.html", "compress.html", "merge.html", "split.html", "rotate.html", "delete.html", "edit.html", "tool.html"]
JS_BY_PAGE = {
    "index.html": ["assets/js/config.js", "assets/js/tools.js", "assets/js/home.js"],
    "compress.html": ["assets/js/config.js", "assets/js/aws-client.js", "assets/js/compress.js"],
    "merge.html": ["assets/js/config.js", "assets/js/aws-client.js", "assets/js/merge.js"],
    "split.html": ["assets/js/config.js", "assets/js/aws-client.js", "assets/js/split.js"],
    "rotate.html": ["assets/js/config.js", "assets/js/aws-client.js", "assets/js/rotate.js"],
    "delete.html": ["assets/js/config.js", "assets/js/aws-client.js", "assets/js/delete.js"],
    "edit.html": [],
    "tool.html": ["assets/js/tools.js", "assets/js/tool.js"],
}

# 1. ids referenced vs defined
for page, scripts in JS_BY_PAGE.items():
    html = (ROOT / page).read_text(encoding="utf-8")
    defined = set(re.findall(r'id="([^"]+)"', html))
    for script in scripts:
        js = (ROOT / script).read_text(encoding="utf-8")
        refs = set(re.findall(r'(?:getElementById|\$\()\s*["\']([^"\']+)["\']', js))
        # compress.js builds stepper ids dynamically ("step"+Capitalized),
        # merge.js builds "mergeStep"+Capitalized, split.js "splitStep"+Capitalized,
        # rotate.js "rotateStep"+Capitalized, delete.js "deleteStep"+Capitalized.
        missing = {r for r in refs if r not in defined and not r.startswith("step") and not r.startswith("mergeStep") and not r.startswith("splitStep") and not r.startswith("rotateStep") and not r.startswith("deleteStep") and r not in ("mergeStep", "splitStep", "rotateStep", "deleteStep")}
        # resolve dynamic stepper ids explicitly
        dyn_ok = all(("step" + s) in defined for s in ["Select", "Upload", "Process", "Done"])
        merge_dyn_ok = all(("mergeStep" + s) in defined for s in ["Select", "Upload", "Process", "Done"])
        split_dyn_ok = all(("splitStep" + s) in defined for s in ["Select", "Upload", "Process", "Done"])
        rotate_dyn_ok = all(("rotateStep" + s) in defined for s in ["Select", "Upload", "Process", "Done"])
        delete_dyn_ok = all(("deleteStep" + s) in defined for s in ["Select", "Upload", "Process", "Done"])
        if missing:
            fail(f"{page} <- {script}: missing ids {sorted(missing)}")
        elif script == "assets/js/compress.js" and not dyn_ok:
            fail(f"{page}: dynamic stepper ids missing")
        elif script == "assets/js/merge.js" and not merge_dyn_ok:
            fail(f"{page}: dynamic merge stepper ids missing")
        elif script == "assets/js/split.js" and not split_dyn_ok:
            fail(f"{page}: dynamic split stepper ids missing")
        elif script == "assets/js/rotate.js" and not rotate_dyn_ok:
            fail(f"{page}: dynamic rotate stepper ids missing")
        elif script == "assets/js/delete.js" and not delete_dyn_ok:
            fail(f"{page}: dynamic delete stepper ids missing")
        else:
            ok(f"{page} <- {script}: ids resolve")

# 2. local targets exist
for page in HTML_FILES:
    html = (ROOT / page).read_text(encoding="utf-8")
    targets = re.findall(r'(?:href|src)="([^"#{}]+?)"', html)
    for t in targets:
        if re.match(r"https?://|mailto:|#", t) or t.startswith("data:"):
            continue
        if not (ROOT / t).exists():
            fail(f"{page}: missing target {t}")
ok("local link/script targets resolve (if no FAIL above)")

# 3. registry hrefs
tools_js = (ROOT / "assets/js/tools.js").read_text(encoding="utf-8")
ids = set(re.findall(r'id:\s*"([^"]+)"', tools_js))
hrefs = re.findall(r'href:\s*"([^"]+)"', tools_js)
for h in hrefs:
    if h.startswith("http"):
        continue
    if "?" in h:
        path, qs = h.split("?", 1)
        m = re.search(r"tool=([\w-]+)", qs)
        if not (ROOT / path).exists():
            fail(f"registry href target missing: {h}")
        elif not m or m.group(1) not in ids:
            fail(f"registry href unknown tool id: {h}")
    else:
        if not (ROOT / h).exists():
            fail(f"registry href target missing: {h}")
ok("registry hrefs resolve (if no FAIL above)")

# 4. no secrets
secret_pats = [r"AKIA[0-9A-Z]{16}", r"aws_secret", r"aws_session_token",
               r"-----BEGIN [A-Z ]*PRIVATE KEY-----", r"xox[bap]-"]
for f in ROOT.rglob("*"):
    if ".git/" in str(f) or f.is_dir() or f.name == "checks.py":
        continue
    try:
        text = f.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    for pat in secret_pats:
        if re.search(pat, text, re.IGNORECASE):
            fail(f"possible secret pattern '{pat}' in {f.relative_to(ROOT)}")
if not any("secret" in x for x in fails):
    ok("no secret patterns found")
if list(ROOT.glob(".env*")):
    fail(".env file present")

# 5. SDK pinned consistently
sdk_refs = set()
for page in HTML_FILES:
    sdk_refs.update(re.findall(r"sdk\.amazonaws\.com/js/aws-sdk-([\d.]+)\.min\.js",
                               (ROOT / page).read_text(encoding="utf-8")))
sdk_refs.update(re.findall(r"aws-sdk-([\d.]+)\.min\.js",
                           (ROOT / "assets/js/config.js").read_text(encoding="utf-8")))
if len(sdk_refs) == 1:
    ok(f"AWS SDK pinned consistently: {sdk_refs.pop()}")
else:
    fail(f"inconsistent SDK pins: {sorted(sdk_refs)}")

# 6. brace balance in JS
for js_file in sorted((ROOT / "assets/js").glob("*.js")):
    text = js_file.read_text(encoding="utf-8")
    # strip comments first (they may contain quotes), then strings
    text = re.sub(r"//[^\n]*|/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`(?:[^`\\]|\\.)*`", "", text)
    pairs = {"{": "}", "(": ")", "[": "]"}
    stack = []
    balanced = True
    for ch in text:
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in pairs.values():
            if not stack or stack.pop() != ch:
                balanced = False
                break
    if not balanced or stack:
        fail(f"{js_file.name}: unbalanced brackets/braces/parens")
    else:
        ok(f"{js_file.name}: brackets balanced")

# 7. placeholders must not fake processing
for probe in ["edit.html", "tool.html", "assets/js/tool.js"]:
    text = (ROOT / probe).read_text(encoding="utf-8").lower()
    for bad in ["s3.upload", "putobject", "getSignedUrl".lower(), "headobject"]:
        if bad in text:
            fail(f"{probe}: placeholder contains processing hook '{bad}'")
ok("placeholders contain no processing hooks (if no FAIL above)")

print()
if fails:
    print(f"{len(fails)} FAILURE(S)")
    sys.exit(1)
print("ALL CHECKS PASSED")
