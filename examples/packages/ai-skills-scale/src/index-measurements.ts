export interface IndexBuildMeasurements {
  readonly schemaVersion: 1;
  readonly indexingMilliseconds: number;
  readonly artifactBytes: number;
  readonly peakMemoryBytes: number;
}

export function indexMeasurementsFile(indexFile: string): string {
  return `${indexFile}.measurements.json`;
}

export function preserveIndexBuildMeasurements(
  current: IndexBuildMeasurements,
  previous: IndexBuildMeasurements | undefined,
  unchanged: boolean,
): IndexBuildMeasurements {
  if (!unchanged || !previous) return current;
  return {
    ...current,
    indexingMilliseconds: previous.indexingMilliseconds,
    peakMemoryBytes: Math.max(current.peakMemoryBytes, previous.peakMemoryBytes),
  };
}
