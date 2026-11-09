# Security architecture

Company and platform sessions use separate signing configuration and identities. Company authorization is scoped by company and, where supported, department or employee. Refresh-token storage and protected-account MFA are implemented in the [session](../backend/src/sessions.ts) and [MFA](../backend/src/mfa.ts) modules. Audit and request logging use server-side redaction.

The backend enforces request size limits, security headers, an explicit CORS allow-list, and route-specific rate limits. Set proxy trust only behind an enforced proxy path. Attachment routes validate media type and content signatures, check permissions, and apply upload limits. See [attachments.ts](../backend/src/attachments.ts).

Android debug builds default to a local backend. Release configuration requires HTTPS. Recovery uses a configured HTTPS App Link and accepts tokens from URL fragments. Verify your App Links association before using recovery on a real installation.

Test negative permissions, cross-company access, malicious inputs, and accidental logging when changing security-sensitive code. See [SECURITY.md](../SECURITY.md) for reporting and the [release audit](../OPEN_SOURCE_RELEASE_AUDIT.md) for open items.
