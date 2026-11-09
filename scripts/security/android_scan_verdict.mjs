/**
 * Verdict logic for the Android dependency vulnerability gate.
 *
 * Kept separate from the CLI, and free of filesystem and process access, so the
 * decision that determines whether a build is allowed through can be tested
 * directly instead of only through a real scanner run.
 *
 * The governing rule: OSV-Scanner's exit status is a trusted input, not a hint.
 * An earlier version treated the results JSON as the sole authority and only
 * questioned a non-zero exit when the file happened to contain no results. That
 * left a fail-open path — a scanner that errored but still wrote partial
 * parseable results could be read as "no vulnerabilities". A gate must never
 * convert an execution failure into a pass, so this module handles only the two
 * statuses whose meaning it actually implements and fails closed on all others.
 *
 * OSV-Scanner v2 documents:
 *   0        packages scanned, no findings
 *   1        findings present
 *   127      general error
 *   128      no packages found
 *   129-255  non-result-related errors
 *
 * 2-126 are reserved and unhandled here on purpose: being reserved is not the
 * same as being understood, and guessing at an unassigned status is exactly the
 * assumption that produced the original defect.
 */

export const VERDICT = {
  PASS: 'PASS',
  VULNERABILITY_FOUND: 'VULNERABILITY_FOUND',
  SCAN_EXECUTION_FAILED: 'SCAN_EXECUTION_FAILED',
};

export const EXIT_CODE = {
  [VERDICT.PASS]: 0,
  [VERDICT.VULNERABILITY_FOUND]: 1,
  [VERDICT.SCAN_EXECUTION_FAILED]: 2,
};

/** Statuses whose semantics this wrapper implements. Everything else fails closed. */
const UNDERSTOOD_STATUSES = new Set([0, 1]);

/**
 * Blocking threshold matches the `npm audit --audit-level=high` policy already
 * used for backend and web. UNKNOWN blocks because a finding OSV could not
 * score is not evidence that the finding is harmless.
 */
export const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'UNKNOWN']);

export function classifySeverity(maxSeverity) {
  if (maxSeverity === undefined || maxSeverity === null || maxSeverity === '') return 'UNKNOWN';
  const score = Number(maxSeverity);
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MODERATE';
  return 'LOW';
}

/** Shape check kept separate so a malformed report is a verdict, not a crash. */
export function isUsableReport(report) {
  return Boolean(report) && typeof report === 'object' && Array.isArray(report.results);
}

export function extractFindings(report) {
  if (!isUsableReport(report)) return [];
  const findings = [];
  for (const result of report.results) {
    for (const entry of result?.packages ?? []) {
      const name = entry?.package?.name ?? 'unknown';
      const version = entry?.package?.version ?? 'unknown';
      for (const group of entry?.groups ?? []) {
        findings.push({
          package: `${name}@${version}`,
          ids: (group?.ids ?? []).join(', '),
          severity: classifySeverity(group?.max_severity),
          score: group?.max_severity ?? 'unscored',
        });
      }
    }
  }
  const order = { CRITICAL: 0, HIGH: 1, UNKNOWN: 2, MODERATE: 3, LOW: 4 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * @param {{status: number|null|undefined, report: unknown}} input
 *   `status` is the scanner's exit code (null when it was killed by a signal);
 *   `report` is the parsed results JSON, or undefined when it was missing or
 *   unparseable.
 * @returns {{verdict: string, exitCode: number, findings: Array, blocking: Array,
 *            advisory: Array, reason: string}}
 */
export function decideVerdict({ status, report }) {
  const fail = (reason) => ({
    verdict: VERDICT.SCAN_EXECUTION_FAILED,
    exitCode: EXIT_CODE[VERDICT.SCAN_EXECUTION_FAILED],
    findings: [],
    blocking: [],
    advisory: [],
    reason,
  });

  if (!UNDERSTOOD_STATUSES.has(status)) {
    const described = status === null || status === undefined
      ? 'without an exit status (killed by a signal, or never started)'
      : `with status ${status}`;
    return fail(
      `osv-scanner exited ${described}. This wrapper only interprets 0 (clean) and ` +
        '1 (findings); every other status is an execution failure and must never be ' +
        'reported as a clean scan.',
    );
  }

  if (!isUsableReport(report)) {
    return fail(
      `osv-scanner exited ${status} but its results JSON was missing, unparseable, or ` +
        'carried no results array. A scan whose output cannot be read is not a scan.',
    );
  }

  const findings = extractFindings(report);
  const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const advisory = findings.filter((finding) => !BLOCKING_SEVERITIES.has(finding.severity));

  if (status === 1) {
    // The scanner reported findings. If this wrapper cannot see any, the two
    // disagree about what is in the report, and neither can be trusted to
    // decide whether the build is safe.
    if (findings.length === 0) {
      return fail(
        'osv-scanner exited 1, meaning it found something, but this wrapper parsed no ' +
          'finding from the report. The scanner and the gate disagree, so the result ' +
          'is not usable.',
      );
    }
    if (blocking.length > 0) {
      return {
        verdict: VERDICT.VULNERABILITY_FOUND,
        exitCode: EXIT_CODE[VERDICT.VULNERABILITY_FOUND],
        findings,
        blocking,
        advisory,
        reason:
          `${blocking.length} finding(s) at high severity or above, or unscored, ` +
          'which is not evidence of safety.',
      };
    }
    return {
      verdict: VERDICT.PASS,
      exitCode: EXIT_CODE[VERDICT.PASS],
      findings,
      blocking,
      advisory,
      reason:
        `${advisory.length} moderate/low finding(s) reported and not suppressed. These ` +
        'do not block, matching the npm audit --audit-level=high policy used elsewhere.',
    };
  }

  // status === 0: the scanner reported nothing to report.
  if (blocking.length > 0) {
    // Inconsistent state. Rather than pick a side, refuse the run: a clean exit
    // that carries a blocking finding means one of the two is wrong.
    return fail(
      `osv-scanner exited 0, meaning no findings, yet this wrapper parsed ` +
        `${blocking.length} blocking finding(s) from the report. Failing closed rather ` +
        'than trusting an inconsistent result.',
    );
  }

  return {
    verdict: VERDICT.PASS,
    exitCode: EXIT_CODE[VERDICT.PASS],
    findings,
    blocking,
    advisory,
    // Advisory findings alongside a 0 exit are still contradictory, so they are
    // surfaced rather than dropped — they just are not grounds to fail a build.
    reason: advisory.length > 0
      ? `osv-scanner exited 0 but ${advisory.length} non-blocking finding(s) were parsed; ` +
        'reported for visibility.'
      : 'osv-scanner reported no known vulnerabilities.',
  };
}
