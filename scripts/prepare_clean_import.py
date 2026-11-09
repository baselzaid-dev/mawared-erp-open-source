#!/usr/bin/env python3
"""List candidates for a clean-source import from a local checkout, without copying Git history.

This inventory command does not write files. Review each candidate before transfer.
"""
from __future__ import annotations
import argparse
import pathlib
import sys

EXCLUDED_DIRS = {
    ".git", ".github", ".idea", ".cursor", ".gradle", ".kotlin",
    "node_modules", "dist", "build", "coverage", "test-results",
    "playwright-report", "blob-report", "mawared_private_backups",
}
EXCLUDED_ROOT_FILES = {
    "AI_WORK_LOG.md", "AGENTS.md", "CLAUDE.md", "PROJECT_STATUS.md",
    "TASKS.md", "BACKEND_CONTRACT.md", "ANDROID_MIGRATION_STATUS.md",
    "DATABASE_SCHEMA_PROPOSAL.md", "metadata.json", "render.yaml",
    "keystore.properties.example",
}
EXCLUDED_EXTENSIONS = {
    ".jks", ".keystore", ".pem", ".p12", ".pfx", ".db", ".sqlite",
    ".dump", ".backup", ".apk", ".aab", ".zip", ".patch", ".log",
}
KEEP_ROOT = {
    ".gitignore", ".nvmrc", "build.gradle.kts", "settings.gradle.kts",
    "gradle.properties", "gradlew", "gradlew.bat", ".env.example",
}
KEEP_DIRS = {"app", "backend", "web", "gradle"}
KEEP_TOPLEVEL = {"LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md",
                 "CODE_OF_CONDUCT.md", "OPEN_SOURCE_RELEASE_AUDIT.md"}
def allowed(relative: pathlib.Path) -> bool:
    parts = relative.parts
    if not parts or any(p in EXCLUDED_DIRS for p in parts[:-1]):
        return False
    if parts[0] == "docs":
        return False  # Review docs separately before import.
    if len(parts) == 1 and parts[0] in EXCLUDED_ROOT_FILES:
        return False
    if parts[0] not in KEEP_DIRS and relative.as_posix() not in KEEP_ROOT:
        return False
    if relative.suffix.lower() in EXCLUDED_EXTENSIONS:
        return False
    name = relative.name.lower()
    if name.startswith(".env") and name != ".env.example":
        return False
    if name in {"keystore.properties", "google-services.json",
                "credentials.json", "google-service-info.plist"}:
        return False
    if name.startswith("service-account") and name.endswith(".json"):
        return False
    if relative.is_absolute() or ".." in parts:
        return False
    return True

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    dest = args.destination.resolve()
    if not source.is_dir() or not dest.is_dir():
        parser.error("Both source and destination must already exist.")
    if source == dest or source in dest.parents or dest in source.parents:
        parser.error("Source and destination must be separate directories.")
    if not (source / "backend").is_dir() or not (dest / ".git").is_dir():
        parser.error("Expected Mawared source and a separate Git destination.")
    candidates = []
    for path in source.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(source)
        if not allowed(relative):
            continue
        if relative.as_posix() in KEEP_TOPLEVEL:
            continue  # Preserve the reviewed public-release documentation.
        candidates.append((path, dest / relative))
    candidates.sort(key=lambda item: str(item[0]))
    for original, _ in candidates:
        print(original.relative_to(source))
    print(f"{len(candidates)} paths require individual review.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
