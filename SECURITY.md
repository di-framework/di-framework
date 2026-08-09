# Security Policy

## Supported Versions

Security updates are provided for the following release lines of this monorepo (all `@di-framework/*` packages share the same version):

| Version | Supported          |
| ------- | ------------------ |
| 4.2.x   | :white_check_mark: |
| 4.1.x   | :x:                |
| < 4.0   | :x:                |

Only the latest minor line receives security fixes. Older 4.x minors and any pre-4.0 releases are unsupported; upgrade to the latest 4.2.x patch when a fix is published.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue or discussion for security reports.

Report vulnerabilities privately via GitHub Security Advisories:

1. Open [Report a vulnerability](https://github.com/di-framework/di-framework/security/advisories/new) on this repository.
2. Include as much detail as you can: affected package(s) and version(s), impact, reproduction steps, and any proof-of-concept (kept minimal and non-destructive).

### What to expect

- **Acknowledgement:** We aim to confirm receipt within **3 business days**.
- **Status updates:** You should hear from us at least every **7 days** while the report is under investigation, and again when a fix or decision is ready.
- **If accepted:** We will work on a fix, coordinate a disclosure timeline with you, and publish a GitHub Security Advisory (and patched release) when appropriate. Credit is given to reporters who wish to be named.
- **If declined:** We will explain why (for example: not reproducible, out of scope, or already fixed) and close the private report.

### Scope

In scope: vulnerabilities in published `@di-framework/*` packages that can lead to unintended privilege, data exposure, remote code execution, or similar impact in typical usage.

Out of scope: issues only in example apps, documentation typos, dependency advisories with no reachable path through this project’s APIs (unless you can show a concrete exploit via our packages), and social-engineering or physical attacks.

Thank you for helping keep di-framework and its users safe.
