# Architecture

The web and Android clients share one Express API. Clients handle presentation and navigation. The API makes authorization decisions and uses Prisma to query PostgreSQL.

| Boundary | Main entry points |
| --- | --- |
| Express and middleware | [server.ts](../backend/server.ts), [app.ts](../backend/src/app.ts), [security.ts](../backend/src/security.ts) |
| Company identity and permissions | [authorization.ts](../backend/src/authorization.ts), [sessionRoutes.ts](../backend/src/sessionRoutes.ts), [mfaRoutes.ts](../backend/src/mfaRoutes.ts) |
| Platform identity and provisioning | [platformAuth.ts](../backend/src/platformAuth.ts), [platformRoutes.ts](../backend/src/platformRoutes.ts) |
| Database | [Prisma schema and migrations](../backend/prisma/) |
| Web API and session state | [web/src/api](../web/src/api/) and [web/src/auth](../web/src/auth/) |
| Android API and local data | [Android data layer](../app/src/main/java/com/example/data/) |

Company routes derive their company identity from a verified session. They combine it with permissions and, where applicable, department or employee scope. The platform control plane uses separate principals and signing configuration. Treat direct database access as a separate security boundary.

Some Android screens use local repositories or explicitly enabled demo data. Check the [dependency provider](../app/src/main/java/com/example/core/di/DependencyProvider.kt) when tracing a workflow.
