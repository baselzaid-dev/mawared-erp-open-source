#!/usr/bin/env python3
"""Conservative local pre-publication scanner. Does not replace manual review."""
from __future__ import annotations
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FORBIDDEN = [
    re.compile(r"(^|/)(?:\.env(?:\.[^/]+)?|keystore\.properties|google-services\.json)$"),
    re.compile(r"(^|/)(?:\.cursor|\.idea|node_modules|mawared_private_backups)/"),
    re.compile(r"\.(?:jks|keystore|pem|p12|pfx|sqlite|db|dump|backup|apk|aab|zip)$", re.I),
]
SECRET_PATTERNS = {
    "private_key": re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    "github_token": re.compile(r"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "openai_key": re.compile(r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}"),
    "google_api_key": re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    "aws_access_key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "postgres_url": re.compile(r"postgres(?:ql)?://[^\s\"']+"),
}
def main() -> int:
    try:
        paths = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"]).split(b"\0")
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: unable to enumerate tracked files: {exc}", file=sys.stderr)
        return 2
    findings = []
    inspected = 0
    for raw in paths:
        if not raw:
            continue
        name = raw.decode("utf-8", errors="replace")
        if any(p.search(name) for p in FORBIDDEN):
            findings.append((name, "forbidden path"))
        file = ROOT / name
        if not file.is_file():
            continue
        if file.stat().st_size > 2_000_000:
            findings.append((name, "large file requires manual review"))
            continue
        data = file.read_bytes()
        if b"\0" in data:
            findings.append((name, "binary file requires manual review"))
            continue
        inspected += 1
        content = data.decode("utf-8", errors="replace")
        for label, regex in SECRET_PATTERNS.items():
            if regex.search(content):
                findings.append((name, f"possible {label}; manually verify placeholders"))
    print(f"Inspected {inspected} text files; {len(findings)} findings.")
    for name, finding in findings:
        print(f"{name}: {finding}")
    if findings:
        print("BLOCKED: resolve and review findings before public release.")
        return 1
    print("No configured patterns matched. This is NOT proof that the code is safe.")
    return 0
if __name__ == "__main__":
    sys.exit(main())
