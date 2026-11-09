#!/usr/bin/env python3
"""Check tracked files and reachable Git history, emitting paths and rules only."""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXAMPLES = {".env.example", ".env.production.example"}
WRAPPER = "gradle/wrapper/gradle-wrapper.jar"
WRAPPER_SHA256 = "55243ef57851f12b070ad14f7f5bb8302daceeebc5bce5ece5fa6edb23e1145c"
# Reviewed placeholder-only templates in the preparation repository's existing history.
HISTORICAL_EXAMPLES = {
    "backend/.env.example": "8044da3ef01b3db3de627f9d4f991d43ee9f17ec7e7a0a9139c992618ff08095",
    "backend/.env.production.example": "df14de2070cb112d7ace07de601194ea2f4207db4af32418b1f3f5f25a32be37",
}
FORBIDDEN_DIRS = {".cursor", ".idea", "mawared_private_backups", "node_modules"}
FORBIDDEN_SUFFIXES = {".jks", ".keystore", ".pem", ".p12", ".pfx", ".sqlite",
                      ".db", ".dump", ".backup", ".apk", ".aab", ".zip", ".log"}
RULES = {
    "private-key": re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "provider-key": re.compile(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}"),
    "hosted-infrastructure": re.compile(r"\b(?:[a-z0-9-]+\.)+(?:supabase\.(?:co|com|net)|onrender\.com)\b", re.I),
}
POSTGRES = re.compile(r"postgres(?:ql)?://[^\s\"'\x60<>()]+", re.I)
ENV_SECRET = re.compile(
    r"^[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN_PEPPER|ENCRYPTION_KEY|API_KEY|SERVICE_ROLE_KEY)"
    r"[A-Z0-9_]*\s*=\s*(\S+)", re.I
)
PLACEHOLDER = re.compile(r"^(?:<?(?:replace|change|your|example|placeholder)[-_.][\w<>.-]+|<[\w-]+>)$", re.I)


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), *args], stderr=subprocess.DEVNULL)


def test_path(name: str) -> bool:
    parts = pathlib.PurePosixPath(name).parts
    return "tests" in parts or "test" in parts or name.endswith((".test.ts", ".test.mjs"))


def safe_postgres(value: str, path: str) -> bool:
    try:
        url = urlsplit(value.rstrip(".,"))
        host = (url.hostname or "").lower()
    except ValueError:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return (not url.password or bool(PLACEHOLDER.fullmatch(url.password))
                or test_path(path))
    if test_path(path) and (
        host.endswith((".example", ".test", ".invalid", ".local"))
        or host in {"example.com", "example.net", "example.org"}
    ):
        return True
    return False


def inspect(name: str, mode: str, data: bytes):
    path = pathlib.PurePosixPath(name)
    basename = path.name.lower()
    if (mode not in {"100644", "100755"} or FORBIDDEN_DIRS.intersection(path.parts)
            or path.suffix.lower() in FORBIDDEN_SUFFIXES
            or (basename.startswith(".env") and basename not in EXAMPLES)
            or basename in {"google-services.json", "keystore.properties", "credentials.json"}
            or (basename.startswith("service-account") and basename.endswith(".json"))):
        yield 0, "forbidden-path-or-mode"
    if name == WRAPPER:
        if hashlib.sha256(data).hexdigest() != WRAPPER_SHA256:
            yield 0, "unverified-gradle-wrapper"
        return
    if b"\0" in data or len(data) > 2_000_000:
        yield 0, "unreviewed-binary-or-large-file"
        return
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        yield 0, "non-utf8-file"
        return
    historical_example = HISTORICAL_EXAMPLES.get(name) == hashlib.sha256(data).hexdigest()
    for line_no, line in enumerate(lines, 1):
        for rule, pattern in RULES.items():
            if pattern.search(line):
                yield line_no, rule
        if not historical_example and any(not safe_postgres(match.group(), name) for match in POSTGRES.finditer(line)):
            yield line_no, "unreviewed-postgres-url"
        assignment = ENV_SECRET.search(line)
        if basename in EXAMPLES and assignment and not PLACEHOLDER.fullmatch(assignment[1].strip("'\"")):
            yield line_no, "non-placeholder-example-secret"


def indexed():
    for row in git("ls-files", "--stage", "-z").split(b"\0"):
        if row:
            metadata, name = row.split(b"\t", 1)
            mode, blob, stage = metadata.decode().split()
            if stage != "0":
                raise ValueError("Resolve staged merge conflicts first")
            yield name.decode(), mode, blob


def historical():
    for commit in git("rev-list", "--all").decode().splitlines():
        for row in git("ls-tree", "-r", "-z", commit).split(b"\0"):
            if row:
                metadata, name = row.split(b"\t", 1)
                mode, kind, blob = metadata.decode().split()
                if kind != "blob":
                    raise ValueError("Git history contains a non-blob tree entry")
                yield name.decode(), mode, blob


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true", help="Also inspect every reachable Git file version")
    args = parser.parse_args()
    try:
        entries = set(indexed())
        if args.history:
            entries.update(historical())
        failures = 0
        for name, mode, blob in sorted(entries):
            for line, category in inspect(name, mode, git("cat-file", "blob", blob)):
                print(f"{name}:{line}: {category}")
                failures += 1
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Unable to scan Git content ({type(error).__name__}).", file=sys.stderr)
        return 2
    print(f"Inspected {len(entries)} file versions. Findings: {failures}.")
    return int(failures > 0)


if __name__ == "__main__":
    sys.exit(main())
