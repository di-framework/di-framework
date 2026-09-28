# Release Verification

To independently verify a release:

```bash
bun run scripts/security/verify-release.ts <version>
```

## What is Verified?
- **NPM Provenance:** Matches the `di-framework/di-framework` GitHub repository and action identity.
- **SBOM:** Exists for the specified version and matches the package hash.
- **Checksums:** Downloaded artifacts match the release manifest.

## Evidence
- If verification fails, it fails closed (exits with non-zero code).
- Real integration successfully prevents mismatched SBOM/Provenance pairs from being falsely reported as valid.
