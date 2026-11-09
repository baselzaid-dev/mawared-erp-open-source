#!/usr/bin/env node
/**
 * Android dependency vulnerability gate.
 *
 * Runs OSV-Scanner over a CycloneDX SBOM produced from the *resolved*
 * `releaseRuntimeClasspath` (see `:app:mawaredDependencySbom`), so the thing
 * being scanned is the dependency graph that actually ships — transitive
 * packages included — and not the hand-written declarations in
 * libs.versions.toml. The risk this closes is an outdated transitive nobody
 * declared, which a declaration-only review structurally cannot see.
 *
 * The gate reports exactly one of three outcomes, and never confuses them:
 *
 *   PASS                  scan ran, graph was real, no blocking vulnerability
 *   VULNERABILITY_FOUND   scan ran and found something blocking   (exit 1)
 *   SCAN_EXECUTION_FAILED scan could not be trusted to have run   (exit 2)
 *
 * The third case is the one that matters. A scanner that cannot reach its
 * database, or that is handed an empty SBOM, produces "no vulnerabilities" —
 * which is indistinguishable from safety unless something refuses to accept it.
 *
 * The verdict itself lives in ./android_scan_verdict.mjs so it can be tested
 * without a scanner or a filesystem; this file is the I/O around it.
 *
 * Usage: node scripts/security/scan_android_dependencies.mjs <sbom> <osv-json>
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { EXIT_CODE, VERDICT, decideVerdict } from './android_scan_verdict.mjs';

const EXIT_SCAN_FAILED = EXIT_CODE[VERDICT.SCAN_EXECUTION_FAILED];

/**
 * A real Android graph resolves to far more than this. The threshold exists so
 * a misconfigured or empty SBOM fails loudly instead of scanning clean.
 */
const MINIMUM_COMPONENTS = 20;

const [sbomPath, resultsPath] = process.argv.slice(2);

function scanFailed(message) {
  process.stderr.write(`\nSCAN_EXECUTION_FAILED: ${message}\n`);
  process.exit(EXIT_SCAN_FAILED);
}

if (!sbomPath || !resultsPath) {
  scanFailed('usage: scan_android_dependencies.mjs <sbom.json> <osv-results.json>');
}

// ---------------------------------------------------------------------------
// 1. The SBOM must describe a plausible graph before anything scans it.
// ---------------------------------------------------------------------------
if (!existsSync(sbomPath)) {
  scanFailed(`SBOM not found at ${sbomPath}. The Gradle SBOM task did not produce output.`);
}

let sbom;
try {
  sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
} catch (error) {
  scanFailed(`SBOM at ${sbomPath} is not valid JSON: ${error.message}`);
}

const components = Array.isArray(sbom.components) ? sbom.components : [];
if (components.length < MINIMUM_COMPONENTS) {
  scanFailed(
    `SBOM lists only ${components.length} component(s); at least ${MINIMUM_COMPONENTS} ` +
      'are expected for this app. An under-populated SBOM scans clean for the wrong ' +
      'reason — check that releaseRuntimeClasspath resolved.',
  );
}
if (!components.some((component) => String(component.purl ?? '').startsWith('pkg:maven/androidx.'))) {
  scanFailed(
    'SBOM contains no androidx components, so it does not look like the resolved ' +
      'Android graph. Refusing to treat this scan as meaningful.',
  );
}
if (!components.every((component) => String(component.purl ?? '').startsWith('pkg:maven/'))) {
  scanFailed('SBOM contains components without a Maven purl; OSV cannot match those.');
}

process.stdout.write(`SBOM: ${components.length} resolved components from ${sbomPath}\n`);

// ---------------------------------------------------------------------------
// 2. Run the scanner. Both its exit status and its report feed the verdict:
//    the status says what the scanner believes happened, the report says what
//    it found, and disagreement between them is itself a failure.
//
//    `-L` and `--output-file` are the current flags; the pinned v2.5.0 binary
//    warns that `--sbom` and `--output` are deprecated in favour of these. The
//    SBOM is named bom.json, which OSV-Scanner recognises as CycloneDX.
// ---------------------------------------------------------------------------
const scan = spawnSync(
  'osv-scanner',
  ['scan', 'source', '--format', 'json', '--output-file', resultsPath, '-L', sbomPath],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

if (scan.error) {
  scanFailed(`could not execute osv-scanner: ${scan.error.message}`);
}
if (scan.stderr?.trim()) {
  process.stdout.write(`osv-scanner stderr:\n${scan.stderr.trim()}\n`);
}
process.stdout.write(`osv-scanner exit code: ${scan.status}\n`);

// A missing or unparseable report is passed through as `undefined` rather than
// short-circuiting here, so one place decides the verdict for every input.
let report;
if (existsSync(resultsPath)) {
  try {
    report = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (error) {
    process.stdout.write(`osv-scanner results were not valid JSON: ${error.message}\n`);
  }
} else {
  process.stdout.write('osv-scanner wrote no results file.\n');
}

// ---------------------------------------------------------------------------
// 3. Decide, report, and exit.
// ---------------------------------------------------------------------------
const outcome = decideVerdict({ status: scan.status, report });

if (outcome.findings.length > 0) {
  process.stdout.write(`\nOSV-Scanner findings (${outcome.findings.length}):\n`);
  process.stdout.write(`${'-'.repeat(96)}\n`);
  for (const finding of outcome.findings) {
    process.stdout.write(
      `${finding.severity.padEnd(9)} ${String(finding.score).padEnd(9)} ` +
        `${finding.package.padEnd(48)} ${finding.ids}\n`,
    );
  }
  process.stdout.write(`${'-'.repeat(96)}\n`);
}

if (outcome.verdict === VERDICT.SCAN_EXECUTION_FAILED) {
  // The raw report, when there was one, stays on disk for the CI artifact.
  scanFailed(outcome.reason);
}

if (outcome.verdict === VERDICT.VULNERABILITY_FOUND) {
  process.stderr.write(
    `\nVULNERABILITY_FOUND: ${outcome.reason}\n` +
      'This is a real result, not a scanner failure. Do not suppress it to get a ' +
      'green build — record it as an open Production blocker and decide the fix.\n',
  );
  process.exit(outcome.exitCode);
}

process.stdout.write(
  `\nPASS: OSV-Scanner evaluated ${components.length} resolved components. ${outcome.reason}\n`,
);
process.exit(outcome.exitCode);
