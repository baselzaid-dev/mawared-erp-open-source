# Contributing to Mawared ERP

Thank you for your interest in contributing.

**This repository is still being prepared for its initial source release.** Please do not assume the application is buildable until the source code and verified setup instructions have been published.

## Before you contribute

- Review existing issues and pull requests.
- Open an issue before making substantial architectural changes.
- Never commit API keys, passwords, access tokens, private keys, customer data, production logs, database dumps, or signing credentials.
- Test only systems and data you own or are explicitly authorized to assess.

## Development workflow

1. Fork the repository after the public release.
2. Create a focused branch.
3. Make a small, reviewable change.
4. Add or update tests where appropriate.
5. Run the documented checks and report their results.
6. Open a pull request describing the change, its risks, and the testing performed.

## Quality and security expectations

- Preserve authorization checks and company/tenant isolation.
- Do not trust tenant identifiers supplied by untrusted request bodies.
- Do not embed server credentials in Android client code.
- Document breaking changes and known limitations.
- Never claim a feature is implemented unless the behavior is present and appropriately tested.

## Pull request checklist

- [ ] The change has a clear purpose and limited scope.
- [ ] Relevant tests and type checks pass, or failures are explained.
- [ ] Authorization and tenant-isolation implications have been reviewed.
- [ ] Documentation is updated where needed.
- [ ] No secrets or sensitive information are included.
