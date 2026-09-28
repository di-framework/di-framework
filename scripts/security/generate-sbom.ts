/**
 * SBOM Generator for di-framework packages
 * Outputs CycloneDX 1.5 JSON
 */

import { readFileSync, writeFileSync } from "fs";

export function generateSbom(packageName: string, version: string, dependencies: any): void {
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: "di-framework",
          name: "generate-sbom",
          version: "1.0.0"
        }
      ],
      component: {
        type: "library",
        name: packageName,
        version: version,
        purl: `pkg:npm/${packageName}@${version}`
      }
    },
    components: Object.entries(dependencies || {}).map(([name, ver]) => ({
      type: "library",
      name,
      version: String(ver),
      purl: `pkg:npm/${name}@${String(ver).replace(/^[^\d]/, '')}`
    }))
  };

  writeFileSync(`sbom-${packageName.replace('@di-framework/', '')}.json`, JSON.stringify(sbom, null, 2));
}

if (import.meta.main) {
  console.log("SBOM generation script ready. (Integration with release bundle happens in #481)");
}
