# Security Policy

## Supported versions

During release preparation, no supported public release or response-time SLA is promised. After the first release, security support will be best-effort for the latest maintained version unless a formal policy is published.

## Reporting a vulnerability

Do not publish exploitable vulnerability details in public issues.

Use GitHub's private vulnerability reporting / security advisory feature if it is enabled for this repository. Otherwise, contact the repository owner through a private GitHub contact channel. Include the affected component, impact, reproduction steps, and a suggested mitigation if available.

Do not include real customer data, credentials, tokens, or production database dumps in reports. Please allow time for investigation and remediation before public disclosure. No bug-bounty program is currently promised.

## Safe testing

- Test only systems you own or are explicitly authorized to assess.
- Do not attempt to access another company's tenant or personal data.
- Never commit secrets, private keys, production configuration, logs containing personal data, or database exports.
- If a credential was exposed, revoke or rotate it immediately. Removing it from the latest commit does not remove it from Git history.
