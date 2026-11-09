# Database and secrets

The project uses PostgreSQL with Prisma. Provision your own database, roles, and runtime keys. Follow [Installation](INSTALLATION.md) to set up a local instance.

## Local database writes

`npm run db:migrate` and `npm run seed` validate both Prisma URLs before writing. They require an explicit loopback IP and port, a matching `mawared_dev` or `mawared_test` database and login role, and the same target for both URLs. They refuse staging and production modes. A local port can be forwarded elsewhere, so run these commands on a dedicated instance and keep tunnels to other databases closed.

The seed uses fictional accounts. Rerunning it does not reset an existing account's password. The integration runner normally creates temporary clusters. An attached test URL must use the dedicated `mawared_test` role and database and will receive test writes.

For independently operated deployments, apply reviewed migrations separately using the matching Prisma version, a dedicated migration role, and your own recoverable backup.

| Setting | Use |
| --- | --- |
| `DATABASE_URL` and `DIRECT_URL` | Application and direct migration connections |
| `JWT_SECRET`, `PLATFORM_JWT_SECRET` | Independent token signing secrets, at least 32 bytes each |
| `MFA_ENCRYPTION_KEY` | Base64-encoded 32-byte encryption key |
| `HOST`, `PORT`, `CORS_ORIGINS` | Listener and exact browser origins |
| `TRUST_PROXY_HOPS` | Explicit proxy trust, default 0. Match the enforced network topology before setting a positive value |
| `MAWARED_DEV_SEED_PASSWORD` | Unique local demo admin password |
| `VITE_API_BASE_URL` | Browser-visible API origin |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional server-side AI integration. Prompts sent to the endpoint may be forwarded to the provider |
| `CREDENTIAL_RECOVERY_TOKEN_PEPPER` and recovery delivery settings | Optional server-side delivery and token protection. See [delivery configuration](../backend/src/credentialRecovery/deliveryFactory.ts) |

Keep real values in ignored local files or a secrets manager. Android network origins and web build variables are public configuration. Treat a real credential in Git or CI as exposed. Rotate it and report its path, line, category, and remediation without the value.
