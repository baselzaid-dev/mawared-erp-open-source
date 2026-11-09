import { assertLocalDatabaseUrl } from './local-database.mjs';
/**
 * Fail-closed gate for every real-PostgreSQL test suite.
 *
 * Two different suite families hide behind `tests/*.postgres.test.ts`, and both
 * of them skip *quietly*:
 *
 *   - self-provisioning suites call initdb/pg_ctl/createdb themselves and build
 *     a throwaway cluster under a temp directory. They `describe.skip` when
 *     those server binaries are not on PATH — which is exactly what happens
 *     when PostgreSQL is supplied only as a CI service container.
 *   - service-attached suites connect to MAWARED_PG_TEST_DATABASE_URL and skip
 *     when it is unset.
 *
 * In both cases Vitest still exits 0, so "the step was green" proves nothing.
 * This runner therefore does not trust the exit code. It discovers the tracked
 * suites, runs them serially, and then asserts against the machine-readable
 * report that every discovered suite really executed at least one test and that
 * nothing failed or was skipped.
 *
 * Adding a new `tests/*.postgres.test.ts` file needs no CI change: discovery is
 * the source of truth, so a forgotten suite becomes a hard failure rather than
 * silent non-coverage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const backendRoot = resolve(process.cwd());
const suiteGlob = 'tests/*.postgres.test.ts';

/**
 * Suites that already had an enforced count before discovery existed. Kept as
 * *minimums*, not equality: this still catches tests being silently deleted,
 * without breaking the gate the next time someone legitimately adds one.
 */
const MINIMUM_TESTS: Readonly<Record<string, number>> = {
  'tests/purchasing_override_concurrency.postgres.test.ts': 3,
  'tests/purchasing_w2_concurrency.postgres.test.ts': 10,
  'tests/p4_collaboration_concurrency.postgres.test.ts': 5,
};

/** Binaries the self-provisioning suites shell out to when they build a cluster. */
const REQUIRED_SERVER_BINARIES = ['initdb', 'pg_ctl', 'createdb', 'psql'] as const;

function fail(message: string): never {
  process.stderr.write(`\nPostgreSQL suite gate FAILED: ${message}\n`);
  process.exit(1);
}

function locate(binary: string): string | null {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = spawnSync(locator, [binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (found.status !== 0) return null;
  return found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

/**
 * Discovery uses `git ls-files` so the gate covers exactly the *tracked* suites.
 * An untracked scratch file on a developer machine must not become a CI
 * requirement, and a tracked suite must never be invisible to the gate.
 */
function discoverSuites(): string[] {
  const listed = spawnSync('git', ['ls-files', '--', suiteGlob], {
    cwd: backendRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (listed.status !== 0) {
    fail(
      `could not discover suites: "git ls-files -- ${suiteGlob}" exited ` +
        `${listed.status ?? 'unknown'}. Discovery must not be assumed empty.`,
    );
  }
  const suites = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .sort();
  if (suites.length === 0) {
    fail(`discovery found no tracked files matching ${suiteGlob}. Refusing to report success.`);
  }
  return suites;
}

/**
 * When MAWARED_PG_TEST_REQUIRE=1 the environment promises real PostgreSQL, so a
 * missing prerequisite is a gate failure and not a reason to skip. Checking it
 * up front turns "0 tests ran" into a message that names what is missing.
 *
 * Only the server binaries are mandatory. Every suite can build its own
 * throwaway cluster from them, so they alone are enough to run all 17.
 */
function assertEnvironmentCanRunEverything(): void {
  const attachedDatabase = process.env.MAWARED_PG_TEST_DATABASE_URL;
  if (attachedDatabase?.trim()) {
    try {
      const url = assertLocalDatabaseUrl(attachedDatabase, 'MAWARED_PG_TEST_DATABASE_URL');
      if (url.pathname !== '/mawared_test') fail('attached database must be mawared_test');
    } catch {
      fail('attached database must be a disposable mawared_test database on loopback');
    }
  }
  if (process.env.MAWARED_PG_TEST_REQUIRE !== '1') return;

  const missingBinaries = REQUIRED_SERVER_BINARIES.filter((binary) => locate(binary) === null);
  if (missingBinaries.length > 0) {
    fail(
      'environment cannot run every suite:\n  - ' +
        `PostgreSQL server binaries not on PATH: ${missingBinaries.join(', ')}. ` +
        'Suites that build their own cluster would silently skip. A service ' +
        'container alone does not install these on the runner.',
    );
  }

  // Optional, and deliberately not required. A few suites attach to this URL
  // instead of creating their own cluster, and they seed fixtures at fixed ids
  // without tearing them down — so a second run against the same database
  // fails on duplicates. Leaving it unset gives every suite a pristine cluster,
  // which is why CI does not set it.
  if ((process.env.MAWARED_PG_TEST_DATABASE_URL ?? '').trim()) {
    process.stdout.write(
      'MAWARED_PG_TEST_DATABASE_URL is set: suites that support it will attach to that\n' +
        'database instead of creating their own. It must be freshly migrated and unused,\n' +
        'or those suites will fail on leftover fixtures.\n\n',
    );
  }
}

type AssertionResult = { status?: string };
type FileResult = { name?: string; status?: string; assertionResults?: AssertionResult[] };
type VitestReport = {
  testResults?: FileResult[];
  numFailedTests?: number;
  /** Vitest sets this to false for unhandled errors even when every test passed. */
  success?: boolean;
};

function readReport(reportPath: string): VitestReport {
  if (!existsSync(reportPath)) {
    fail(
      'Vitest produced no JSON report. The run crashed or was killed before it ' +
        'could write results, which must never be read as success.',
    );
  }
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8')) as VitestReport;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`Vitest JSON report was unreadable: ${detail}`);
  }
}

type SuiteOutcome = { suite: string; passed: number; failed: number; skipped: number };

function summarise(suite: string, report: VitestReport): SuiteOutcome | null {
  // Vitest reports absolute paths; match on the tracked suffix so the check is
  // identical on Windows and Linux.
  const entry = (report.testResults ?? []).find((file) => {
    const name = (file.name ?? '').replace(/\\/g, '/');
    return name.endsWith(`/${suite}`) || name === suite;
  });
  if (!entry) return null;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const assertion of entry.assertionResults ?? []) {
    if (assertion.status === 'passed') passed += 1;
    else if (assertion.status === 'failed') failed += 1;
    else skipped += 1; // pending / todo / skipped all mean "did not actually run"
  }
  // A file that failed to collect (import/compile error) reports no assertions
  // at all; surface that as a failure rather than an empty pass.
  if (failed === 0 && entry.status === 'failed') failed = Math.max(1, failed);
  return { suite, passed, failed, skipped };
}

function main(): void {
  const suites = discoverSuites();
  process.stdout.write(`Discovered ${suites.length} tracked suite(s) matching ${suiteGlob}:\n`);
  for (const suite of suites) process.stdout.write(`  - ${suite}\n`);
  process.stdout.write('\n');

  assertEnvironmentCanRunEverything();

  const vitestCli = resolve(backendRoot, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitestCli)) {
    fail(`Vitest CLI not found at ${vitestCli}. Run "npm ci" in backend/ first.`);
  }

  const reportDirectory = mkdtempSync(join(tmpdir(), 'mawared-pg-gate-'));
  const reportPath = join(reportDirectory, 'postgres-suites.vitest.json');

  try {
    // Serial on purpose. Self-provisioning suites each start their own cluster
    // on a port chosen by binding :0 and closing it, which races under parallel
    // file execution, and running many clusters at once would thrash a 2-core
    // runner. Correctness first; these suites are a gate, not a hot loop.
    const run = spawnSync(
      process.execPath,
      [
        vitestCli,
        'run',
        ...suites,
        '--no-file-parallelism',
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ],
      { cwd: backendRoot, stdio: 'inherit', windowsHide: true },
    );

    const report = readReport(reportPath);

    const outcomes: SuiteOutcome[] = [];
    const problems: string[] = [];

    for (const suite of suites) {
      const outcome = summarise(suite, report);
      if (!outcome) {
        problems.push(`${suite}: discovered but absent from the Vitest report (never executed)`);
        continue;
      }
      outcomes.push(outcome);

      if (outcome.failed > 0) problems.push(`${suite}: ${outcome.failed} failed test(s)`);
      if (outcome.skipped > 0) {
        problems.push(
          `${suite}: ${outcome.skipped} skipped test(s) — a skipped real-PostgreSQL ` +
            'test is not coverage',
        );
      }
      if (outcome.passed === 0) {
        problems.push(`${suite}: ran 0 passing tests — an empty suite cannot prove anything`);
      }
      const minimum = MINIMUM_TESTS[suite];
      if (minimum !== undefined && outcome.passed < minimum) {
        problems.push(
          `${suite}: ${outcome.passed} passed but at least ${minimum} are required ` +
            '(previously enforced count — tests appear to have been removed)',
        );
      }
    }

    process.stdout.write('\nReal-PostgreSQL suite gate\n');
    process.stdout.write(`${'-'.repeat(78)}\n`);
    for (const outcome of outcomes) {
      process.stdout.write(
        `${outcome.suite.replace('tests/', '').padEnd(52)} ` +
          `passed=${String(outcome.passed).padStart(3)} ` +
          `failed=${String(outcome.failed).padStart(2)} ` +
          `skipped=${String(outcome.skipped).padStart(2)}\n`,
      );
    }
    const totalPassed = outcomes.reduce((sum, outcome) => sum + outcome.passed, 0);
    const totalSkipped = outcomes.reduce((sum, outcome) => sum + outcome.skipped, 0);
    const totalFailed = outcomes.reduce((sum, outcome) => sum + outcome.failed, 0);
    process.stdout.write(`${'-'.repeat(78)}\n`);
    process.stdout.write(
      `${suites.length} suite(s) discovered, ${outcomes.length} executed, ` +
        `${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped\n\n`,
    );

    // Checked last so the per-suite diagnosis above is always printed first, but
    // never ignored. Vitest exits non-zero for unhandled errors even when every
    // test passed, and it warns that those "might cause false positive tests" —
    // a run that reports a perfect per-suite table while something blew up
    // outside a test is exactly the false green this gate exists to reject.
    if (problems.length === 0 && (run.status !== 0 || report.success === false)) {
      problems.push(
        `Vitest exited ${run.status ?? 'unknown'} and reported no attributable suite ` +
          'failure. Look for "Unhandled Errors" in the Vitest output above: an error ' +
          'outside a test can invalidate the results, so this gate does not accept ' +
          'the run on the per-suite numbers alone.',
      );
    }

    if (problems.length > 0) {
      fail(`\n  - ${problems.join('\n  - ')}`);
    }

    process.stdout.write('All discovered real-PostgreSQL suites executed. 0 failed, 0 skipped.\n');
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

main();
