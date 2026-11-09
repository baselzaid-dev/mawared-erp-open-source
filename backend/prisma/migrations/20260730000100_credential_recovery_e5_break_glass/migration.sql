-- E5: allow hash-only one-time break-glass package digests on CredentialRecoveryRequest.
-- Previously break_glass_recovery forced tokenHash IS NULL; package single-use/supersession
-- requires hmac-sha256-v1 digests identical in shape to password_reset / mfa_recovery.
-- No plaintext secret columns. No PlatformPrincipal forced-password columns in this migration.

ALTER TABLE "CredentialRecoveryRequest"
  DROP CONSTRAINT "CredentialRecoveryRequest_token_shape_check";

ALTER TABLE "CredentialRecoveryRequest"
  ADD CONSTRAINT "CredentialRecoveryRequest_token_shape_check"
  CHECK (
    (
      "purpose" IN ('password_reset', 'mfa_recovery', 'break_glass_recovery')
      AND "tokenHash" IS NOT NULL
      AND "tokenHashAlgorithm" IS NOT NULL
      AND "tokenHashAlgorithm" = 'hmac-sha256-v1'
      AND "tokenHash" ~ '^hmac-sha256-v1:[a-f0-9]{64}$'
    )
    OR (
      "purpose" IN ('account_discovery', 'employee_admin_reset')
      AND "tokenHash" IS NULL
      AND "tokenHashAlgorithm" IS NULL
    )
  );
