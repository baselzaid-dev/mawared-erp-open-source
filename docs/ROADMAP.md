# Mawared ERP roadmap

Mawared is a public community preview. This roadmap describes work needed for a maintainable, self-hosted ERP. The milestones are ordered by the evidence needed for a reliable release.

## Available today

| Area | Evidence and boundaries |
| --- | --- |
| Core application | The [feature inventory](../README.md#what-is-implemented) identifies implemented workflows. The [architecture guide](ARCHITECTURE.md) maps the API, web and Android clients, and database. |
| Local use | The [installation guide](INSTALLATION.md) explains setup on a dedicated local PostgreSQL instance with a synthetic company and locally generated keys. |
| Automated verification | The [audit](../OPEN_SOURCE_RELEASE_AUDIT.md) records migration, build, test, and secret-scanning evidence. The web browser suite uses a fixture API, and some Android screens use local or demo repositories. |

## Milestone 1 — Make everyday workflows usable end to end

| Work | Completion evidence |
| --- | --- |
| Map web and Android coverage | Publish a workflow matrix marking each screen as connected to the API, local or demo, or missing. Include the roles and prerequisites for each workflow. |
| HR and attendance | Verify that an authorized user can onboard an employee, record attendance, submit and review a correction, and request and approve leave on a fresh demo instance. |
| Payroll and finance | Verify payroll preparation, approval, payment recording, and ledger posting against synthetic data. Document supported calculations and applicable limitations. |
| Purchasing | Verify a purchase request through approval, purchase order, receipt, and return. Document which steps each client supports. |
| Collaboration | Verify task assignment, training, chat, notifications, and attachment access across supported roles and clients. |

## Milestone 2 — Prepare secure self-hosting

| Work | Completion evidence |
| --- | --- |
| Access control and recovery | Expand negative tests for cross-company reads and writes, role assignment, protected account identity changes, attachment access, and session revocation. Review findings before use with real data. |
| Install and operations | Provide a reproducible self-hosting example and test a fresh install, upgrade from a prior version, backup, and restore on disposable infrastructure. Document key rotation and migration procedures. |
| API and interoperability | Publish a reference derived from verified route contracts. Document authentication, error handling, permissions, and supported export formats. |
| Usability | Check Arabic and English UI coverage, keyboard navigation, right-to-left layout, and accessibility across key workflows. |

## Milestone 3 — Maintain versioned community releases

- Define supported versions, an upgrade policy, release notes, and a maintenance process.
- Confirm a private disclosure channel and enforce maintainer review and required checks on the default branch.
- Complete third-party license and attribution review before distributing binaries.
- Document the scope of payroll and accounting features and the jurisdiction-specific work needed for regulated use.

For a first contribution, see [Community](COMMUNITY.md). The [development guide](DEVELOPMENT.md) explains how to verify a change using synthetic data.
