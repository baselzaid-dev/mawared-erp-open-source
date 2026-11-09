/**
 * Strict CLI argument parsing for Platform recovery.
 * Rejects unknown options and all secret/database-selector flags.
 */

import {
  PLATFORM_RECOVERY_CLI_ENVIRONMENTS,
  isPlatformRecoveryCliEnvironment,
  type PlatformRecoveryCliEnvironment,
} from './environment';
import {
  PLATFORM_RECOVERY_REASON_CATEGORIES,
  isPlatformRecoveryReasonCategory,
  type PlatformRecoveryMode,
  type PlatformRecoveryReasonCategory,
} from './approvals';

export class PlatformRecoveryCliParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRecoveryCliParseError';
    this.code = code;
  }
}

const FORBIDDEN_OPTIONS = new Set([
  '--offline-secret',
  '--password',
  '--temporary-password',
  '--recovery-token',
  '--approval-secret',
  '--share',
  '--database-url',
  '--connection-string',
  '--env-file',
  '--env',
  '--db',
  '--email',
]);

const ALLOWED_OPTIONS = new Set([
  '--principal',
  '--mode',
  '--expected-environment',
  '--reason-category',
  '--dry-run',
  '--execute',
  '--help',
  '-h',
]);

export interface PlatformRecoveryCliArgs {
  principalId: string;
  mode: PlatformRecoveryMode;
  expectedEnvironment: PlatformRecoveryCliEnvironment;
  reasonCategory: PlatformRecoveryReasonCategory;
  execute: boolean;
  dryRun: boolean;
  help: boolean;
}

function requireValue(
  argv: string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new PlatformRecoveryCliParseError(
      'missing_option_value',
      `${option} requires a value`,
    );
  }
  return { value, nextIndex: index + 1 };
}

export function parsePlatformRecoveryCliArgs(argv: string[]): PlatformRecoveryCliArgs {
  let principalId: string | null = null;
  let mode: PlatformRecoveryMode | null = null;
  let expectedEnvironment: PlatformRecoveryCliEnvironment | null = null;
  let reasonCategory: PlatformRecoveryReasonCategory = 'lost_mfa_device';
  let execute = false;
  let dryRunExplicit = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (FORBIDDEN_OPTIONS.has(arg)) {
      throw new PlatformRecoveryCliParseError(
        'forbidden_option',
        `Option ${arg} is refused by design`,
      );
    }

    // Reject --database-url=... and similar attached forms.
    const attached = arg.split('=')[0]!;
    if (FORBIDDEN_OPTIONS.has(attached) || FORBIDDEN_OPTIONS.has(arg)) {
      throw new PlatformRecoveryCliParseError(
        'forbidden_option',
        `Option ${attached} is refused by design`,
      );
    }

    if (arg.startsWith('-') && !ALLOWED_OPTIONS.has(arg) && !ALLOWED_OPTIONS.has(attached)) {
      throw new PlatformRecoveryCliParseError(
        'unknown_option',
        `Unknown option: ${arg}`,
      );
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRunExplicit = true;
      continue;
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--principal') {
      const got = requireValue(argv, i, arg);
      principalId = got.value;
      i = got.nextIndex;
      continue;
    }
    if (arg === '--mode') {
      const got = requireValue(argv, i, arg);
      if (got.value !== 'mfa-recovery' && got.value !== 'full-break-glass') {
        throw new PlatformRecoveryCliParseError(
          'invalid_mode',
          'mode must be mfa-recovery or full-break-glass',
        );
      }
      mode = got.value;
      i = got.nextIndex;
      continue;
    }
    if (arg === '--expected-environment') {
      const got = requireValue(argv, i, arg);
      if (!isPlatformRecoveryCliEnvironment(got.value)) {
        throw new PlatformRecoveryCliParseError(
          'invalid_environment',
          `expected-environment must be one of ${PLATFORM_RECOVERY_CLI_ENVIRONMENTS.join(',')}`,
        );
      }
      expectedEnvironment = got.value;
      i = got.nextIndex;
      continue;
    }
    if (arg === '--reason-category') {
      const got = requireValue(argv, i, arg);
      if (!isPlatformRecoveryReasonCategory(got.value)) {
        throw new PlatformRecoveryCliParseError(
          'invalid_reason_category',
          `reason-category must be one of ${PLATFORM_RECOVERY_REASON_CATEGORIES.join(',')}`,
        );
      }
      reasonCategory = got.value;
      i = got.nextIndex;
      continue;
    }

    throw new PlatformRecoveryCliParseError(
      'unknown_argument',
      `Unexpected argument: ${arg}`,
    );
  }

  if (help) {
    return {
      principalId: principalId ?? '',
      mode: mode ?? 'mfa-recovery',
      expectedEnvironment: expectedEnvironment ?? 'development',
      reasonCategory,
      execute: false,
      dryRun: true,
      help: true,
    };
  }

  if (!principalId) {
    throw new PlatformRecoveryCliParseError('missing_principal', '--principal is required');
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(principalId)) {
    throw new PlatformRecoveryCliParseError(
      'invalid_principal',
      '--principal must be an exact Platform principal UUID',
    );
  }
  if (!mode) {
    throw new PlatformRecoveryCliParseError('missing_mode', '--mode is required');
  }
  if (!expectedEnvironment) {
    throw new PlatformRecoveryCliParseError(
      'missing_environment',
      '--expected-environment is required',
    );
  }
  if (execute && dryRunExplicit) {
    throw new PlatformRecoveryCliParseError(
      'dry_run_execute_conflict',
      'Pass either --dry-run or --execute, not both',
    );
  }

  return {
    principalId,
    mode,
    expectedEnvironment,
    reasonCategory,
    execute,
    dryRun: !execute,
    help: false,
  };
}

export function formatPlatformRecoveryCliHelp(): string {
  return [
    'Usage: npm run platform:recovery -- --principal <UUID> --mode <mfa-recovery|full-break-glass> --expected-environment <development|staging|production> [--reason-category <CATEGORY>] [--dry-run|--execute]',
    'Dry-run is the default. Mutation requires --execute.',
    'Secrets are never accepted via argv or environment variables.',
  ].join('\n');
}
