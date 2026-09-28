# NIST SSDF 1.1 Mapping

This mapping demonstrates alignment with the NIST Secure Software Development Framework (SSDF) version 1.1.

| SSDF Practice | Status | Rationale | Evidence Link |
|---------------|--------|-----------|---------------|
| PO.1: Define Security Requirements | Implemented | Requirements defined for all new features. Threat model maintained. | `threat-model.md` |
| PO.2: Implement Roles and Responsibilities | Implemented | Maintainer access, MFA requirements, and security review responsibilities are defined. | `maintainer-access.md` |
| PO.3: Implement Supporting Toolchains | Implemented | Automated CI/CD pipeline enforces OIDC based secure provenance and branch protections. | `release-integrity.md` |
| PO.4: Define and Use Secure Environments | Implemented | GitHub Actions with isolated run environments and least-privilege token access. | `maintainer-access.md` |
| PS.1: Protect All Forms of Code | Implemented | Branch protections, enforced reviews, MFA. | `maintainer-access.md` |
| PS.2: Provide a Mechanism for Verifying Release Integrity | Implemented | SLSA Build Level 2 provenance, SBOMs provided. | `release-integrity.md` |
| PS.3: Archive and Protect Software | Implemented | Immutable releases stored as GitHub Releases and NPM packages. | `release-verification.md` |
| PW.1: Design Software to Meet Security Requirements | Implemented | Threat modeling of auth/authz boundaries. | `threat-model.md` |
| PW.2: Review the Software Design | Implemented | Third-party assessment scheduled and scoped. | `assessment-scope.md` |
| PW.4: Reuse Existing, Well-Secured Software | Implemented | Dependabot scanning prevents use of known vulnerable components. | `security-checks.md` |
| PW.5: Configure the Compilation and Build Processes | Implemented | Builds use locked dependencies and isolated, hardened runner environments. | `release-integrity.md` |
| PW.6: Review and Analyze Human-Readable Code | Implemented | Required PR reviews. CodeQL and Scorecard run on all code. | `security-checks.md` |
| PW.7: Test Executable Code | Implemented | Automated tests required prior to release. | `release.yml` |
| PW.8: Configure the Software to Be Secure by Default | Implemented | Secure defaults evaluated during PR review and documented in threat model. | `threat-model.md` |
| RV.1: Identify and Confirm Vulnerabilities | Implemented | Private reporting system enabled and actively monitored. | `vulnerability-response.md` |
| RV.2: Assess, Prioritize, and Remediate Vulnerabilities | Implemented | Vulnerability triage process documented with SLAs. | `security-checks.md` |
| RV.3: Analyze Vulnerabilities to Identify Root Causes | Implemented | Post-mortem process integrates fixes into regression test suite. | `security-checks.md` |

*(Note: SSDF alignment does not imply formal NIST certification)*
