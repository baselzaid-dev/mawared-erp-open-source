/**
 * Regression coverage for the Android dependency gate's verdict logic.
 *
 * These exist because of a fail-open defect: the gate used to question a
 * non-zero scanner exit only when the results file happened to contain no
 * results, so an errored scan that still wrote partial parseable output could
 * be reported as PASS. Every case below pins one leg of the contract that
 * defect violated.
 *
 * Uses node:test so the gate needs no test dependency of its own.
 * Run: node --test scripts/security/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_CODE,
  VERDICT,
  classifySeverity,
  decideVerdict,
  extractFindings,
} from './android_scan_verdict.mjs';

/** Builds a report carrying one finding at the given CVSS score. */
function reportWith(maxSeverity, name = 'com.squareup.okio:okio', version = '3.2.0') {
  return {
    results: [
      {
        packages: [
          {
            package: { name, version, ecosystem: 'Maven' },
            groups: [{ ids: ['GHSA-test-0001'], max_severity: maxSeverity }],
          },
        ],
      },
    ],
  };
}

const CLEAN_REPORT = { results: [] };

/**
 * The shape that caused the original defect: the scanner errored, but the file
 * it left behind still parses and still contains result entries — they simply
 * yield no findings.
 */
const PARTIAL_REPORT = { results: [{ packages: [] }] };

describe('classifySeverity', () => {
  it('maps CVSS scores onto the repository severity bands', () => {
    assert.equal(classifySeverity('9.1'), 'CRITICAL');
    assert.equal(classifySeverity('7.5'), 'HIGH');
    assert.equal(classifySeverity('5.3'), 'MODERATE');
    assert.equal(classifySeverity('2.0'), 'LOW');
  });

  it('treats anything it cannot score as UNKNOWN', () => {
    // UNKNOWN is a blocking severity: "we could not score it" is not evidence
    // that a finding is harmless.
    assert.equal(classifySeverity(undefined), 'UNKNOWN');
    assert.equal(classifySeverity(null), 'UNKNOWN');
    assert.equal(classifySeverity(''), 'UNKNOWN');
    assert.equal(classifySeverity('not-a-number'), 'UNKNOWN');
  });
});

describe('extractFindings', () => {
  it('reads package, ids and severity out of a report', () => {
    const findings = extractFindings(reportWith('7.5'));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].package, 'com.squareup.okio:okio@3.2.0');
    assert.equal(findings[0].ids, 'GHSA-test-0001');
    assert.equal(findings[0].severity, 'HIGH');
  });

  it('returns nothing for a malformed report instead of throwing', () => {
    assert.deepEqual(extractFindings(undefined), []);
    assert.deepEqual(extractFindings(null), []);
    assert.deepEqual(extractFindings({}), []);
    assert.deepEqual(extractFindings({ results: 'not-an-array' }), []);
  });

  it('orders the most severe finding first', () => {
    const report = {
      results: [
        {
          packages: [
            { package: { name: 'a', version: '1' }, groups: [{ ids: ['L'], max_severity: '2.0' }] },
            { package: { name: 'b', version: '1' }, groups: [{ ids: ['C'], max_severity: '9.8' }] },
            { package: { name: 'c', version: '1' }, groups: [{ ids: ['M'], max_severity: '5.0' }] },
          ],
        },
      ],
    };
    assert.deepEqual(
      extractFindings(report).map((finding) => finding.severity),
      ['CRITICAL', 'MODERATE', 'LOW'],
    );
  });
});

describe('decideVerdict — statuses the wrapper understands', () => {
  it('status 0 with a clean report is PASS', () => {
    const outcome = decideVerdict({ status: 0, report: CLEAN_REPORT });
    assert.equal(outcome.verdict, VERDICT.PASS);
    assert.equal(outcome.exitCode, 0);
  });

  it('status 1 with a HIGH finding is VULNERABILITY_FOUND', () => {
    const outcome = decideVerdict({ status: 1, report: reportWith('7.5') });
    assert.equal(outcome.verdict, VERDICT.VULNERABILITY_FOUND);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.blocking.length, 1);
  });

  it('status 1 with a CRITICAL finding is VULNERABILITY_FOUND', () => {
    const outcome = decideVerdict({ status: 1, report: reportWith('9.8') });
    assert.equal(outcome.verdict, VERDICT.VULNERABILITY_FOUND);
  });

  it('status 1 with an unscored finding blocks, because unscored is not safe', () => {
    const outcome = decideVerdict({ status: 1, report: reportWith(undefined) });
    assert.equal(outcome.verdict, VERDICT.VULNERABILITY_FOUND);
    assert.equal(outcome.blocking[0].severity, 'UNKNOWN');
  });

  it('status 1 with only a MODERATE finding passes as advisory, per existing policy', () => {
    // Matches `npm audit --audit-level=high` used for backend and web: reported,
    // never suppressed, but not grounds to fail the build.
    const outcome = decideVerdict({ status: 1, report: reportWith('5.3') });
    assert.equal(outcome.verdict, VERDICT.PASS);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.advisory.length, 1);
    assert.equal(outcome.blocking.length, 0);
  });

  it('status 1 with a LOW-only finding passes as advisory', () => {
    const outcome = decideVerdict({ status: 1, report: reportWith('2.1') });
    assert.equal(outcome.verdict, VERDICT.PASS);
    assert.equal(outcome.advisory.length, 1);
  });

  it('status 1 with no parseable finding is SCAN_EXECUTION_FAILED', () => {
    // The scanner says it found something and the gate sees nothing. They
    // disagree, so neither can decide whether the build is safe.
    const outcome = decideVerdict({ status: 1, report: CLEAN_REPORT });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
    assert.equal(outcome.exitCode, 2);
  });

  it('status 0 carrying a blocking finding fails closed rather than picking a side', () => {
    const outcome = decideVerdict({ status: 0, report: reportWith('9.1') });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
    assert.equal(outcome.exitCode, 2);
  });
});

describe('decideVerdict — the fail-open path this fix closes', () => {
  it('status 127 with partial parseable results is SCAN_EXECUTION_FAILED, not PASS', () => {
    // The exact regression: results.length > 0 but no findings extracted. The
    // old guard only questioned a non-zero exit when results were empty, so
    // this combination fell through to PASS.
    const outcome = decideVerdict({ status: 127, report: PARTIAL_REPORT });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
    assert.equal(outcome.exitCode, 2);
  });

  it('status 127 with a fully clean report is still SCAN_EXECUTION_FAILED', () => {
    const outcome = decideVerdict({ status: 127, report: CLEAN_REPORT });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
  });

  it('status 128 (no packages found) is SCAN_EXECUTION_FAILED', () => {
    // Scanning nothing is the most dangerous way to report zero vulnerabilities.
    const outcome = decideVerdict({ status: 128, report: CLEAN_REPORT });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
  });

  it('statuses 129 and above are SCAN_EXECUTION_FAILED', () => {
    for (const status of [129, 130, 200, 255]) {
      const outcome = decideVerdict({ status, report: CLEAN_REPORT });
      assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED, `status ${status}`);
    }
  });

  it('reserved statuses 2-126 are not quietly accepted', () => {
    // Reserved is not the same as understood. Guessing at an unassigned status
    // is the assumption that produced the original defect.
    for (const status of [2, 3, 42, 126]) {
      const outcome = decideVerdict({ status, report: CLEAN_REPORT });
      assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED, `status ${status}`);
    }
  });

  it('a null status (killed by a signal) is SCAN_EXECUTION_FAILED', () => {
    assert.equal(
      decideVerdict({ status: null, report: CLEAN_REPORT }).verdict,
      VERDICT.SCAN_EXECUTION_FAILED,
    );
    assert.equal(
      decideVerdict({ status: undefined, report: CLEAN_REPORT }).verdict,
      VERDICT.SCAN_EXECUTION_FAILED,
    );
  });
});

describe('decideVerdict — unusable reports', () => {
  it('a missing report is SCAN_EXECUTION_FAILED even on a clean exit', () => {
    const outcome = decideVerdict({ status: 0, report: undefined });
    assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED);
    assert.equal(outcome.exitCode, 2);
  });

  it('a malformed report is SCAN_EXECUTION_FAILED even on a clean exit', () => {
    for (const report of [null, {}, { results: 'nope' }, 42, 'text']) {
      assert.equal(
        decideVerdict({ status: 0, report }).verdict,
        VERDICT.SCAN_EXECUTION_FAILED,
        `report ${JSON.stringify(report)}`,
      );
    }
  });

  it('a missing report on status 1 is SCAN_EXECUTION_FAILED', () => {
    assert.equal(
      decideVerdict({ status: 1, report: undefined }).verdict,
      VERDICT.SCAN_EXECUTION_FAILED,
    );
  });
});

describe('exit code contract', () => {
  it('maps each verdict to its documented exit code', () => {
    assert.equal(EXIT_CODE[VERDICT.PASS], 0);
    assert.equal(EXIT_CODE[VERDICT.VULNERABILITY_FOUND], 1);
    assert.equal(EXIT_CODE[VERDICT.SCAN_EXECUTION_FAILED], 2);
  });

  it('never returns the PASS exit code for a failed scan', () => {
    // The single invariant the whole gate rests on, asserted across the full
    // status range rather than the handful of statuses named in the docs.
    for (let status = 2; status <= 255; status += 1) {
      const outcome = decideVerdict({ status, report: CLEAN_REPORT });
      assert.notEqual(outcome.exitCode, 0, `status ${status} must not exit 0`);
      assert.equal(outcome.verdict, VERDICT.SCAN_EXECUTION_FAILED, `status ${status}`);
    }
  });
});
