# Security Checks and Triage

## Scanning Tools
1. **CodeQL:** Runs on PRs to `main` and daily. Covers TypeScript, JavaScript, and Actions. Rust and bundled Wasm components are out-of-scope for standard CodeQL but monitored via dependabot.
2. **Dependabot:** Automated dependency updates and security alerts for NPM and GitHub Actions.
3. **Secret Scanning:** GitHub Secret Scanning with Push Protection is enabled.
4. **OpenSSF Scorecard:** Runs daily to monitor security posture.

## Triage and Exceptions
- **Ownership:** Maintainers are responsible for triaging CodeQL/Dependabot alerts.
- **Targets:** High/Critical alerts must be remediated within 14 days. Medium within 30 days.
- **Exceptions:** False positives or unreachable paths must be dismissed in the GitHub UI with a justification, owner, and expiry.
- **Blocking:** Any new High/Critical findings will block PR merges to `main`.

## Dependency Automation
Auto-merge is configured for minor/patch Dependabot PRs *only* if all CI checks and mandatory reviews pass, preventing malicious updates from bypassing security.
