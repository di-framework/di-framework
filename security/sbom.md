# Software Bill of Materials (SBOM)

## Standard and Schema
We generate **CycloneDX v1.5** (JSON) for all published artifacts.

## Generation Process
The script `scripts/security/generate-sbom.ts` resolves dependencies (including bundled Wasm/native components) and produces a valid SBOM per package.
- It omits local paths and credentials.
- It differentiates bundled vs peer/optional dependencies.
- It explicitly notes coverage gaps for unknown native dependencies.

## Verification
SBOMs are distributed as release assets alongside the `di-framework` packages on GitHub releases.
Consumers can verify the SBOM against the package digest using standard CycloneDX tooling.
