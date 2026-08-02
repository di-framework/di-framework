import * as ts from 'typescript';

/**
 * Test preload: stub typecheck's language service so reading a marker source
 * file throws, exercising the import.meta.main `.catch` path.
 */
const orig = ts.sys.readFile.bind(ts.sys);
(ts.sys as any).readFile = (fileName: string, encoding?: string) => {
  const result = orig(fileName, encoding as any);
  if (fileName.endsWith('typecheck-stub.ts')) throw new Error('readFile stub');
  return result;
};
