# API overview

The backend exposes JSON routes with a mix of legacy and versioned paths. The registrations define the exact methods, permission requirements, and response contracts.

| Area | Routes and implementation |
| --- | --- |
| Health | `GET /healthz` and `GET /readyz` in [app.ts](../backend/src/app.ts) |
| Company authentication | `POST /api/v2/auth/login`, `POST /api/auth/refresh`, and `GET /api/auth/me` in [app.ts](../backend/src/app.ts) |
| Session and MFA | [sessionRoutes.ts](../backend/src/sessionRoutes.ts) and [mfaRoutes.ts](../backend/src/mfaRoutes.ts) |
| Platform | `/api/platform/v1/companies` in [platformRoutes.ts](../backend/src/platformRoutes.ts) |
| HR, attendance, and leave | [app.ts](../backend/src/app.ts) and [attendanceWorkflows.ts](../backend/src/attendanceWorkflows.ts) |
| Payroll and finance | [payroll.ts](../backend/src/payroll.ts), [payrollPayments.ts](../backend/src/payrollPayments.ts), and [finance.ts](../backend/src/finance.ts) |
| Purchasing | [purchasing.ts](../backend/src/purchasing.ts) and its quotation, receipt, and reporting modules |
| Collaboration and reports | [tasks.ts](../backend/src/tasks.ts), [training.ts](../backend/src/training.ts), [chat.ts](../backend/src/chat.ts), [attachments.ts](../backend/src/attachments.ts), and [reports.ts](../backend/src/reports.ts) |

Authenticated requests use a bearer access token. Some writes require an idempotency key. Use synthetic identities and keep authorization headers and request payloads out of shared logs.
