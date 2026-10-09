import { compareCodeUnits } from 'shared/compare';

export { compareCodeUnits };

export function importLines(pairs: Array<[string, string]>): string[] {
  const grouped = new Map<string, Set<string>>();
  for (const [modulePath, exportName] of pairs) {
    const existing = grouped.get(modulePath) ?? new Set();
    existing.add(exportName);
    grouped.set(modulePath, existing);
  }
  return Array.from(grouped.keys())
    .sort(compareCodeUnits)
    .map((modulePath) => {
      const exports = Array.from(grouped.get(modulePath)!).sort(compareCodeUnits).join(', ');
      return `import { ${exports} } from '${modulePath}';`;
    });
}
