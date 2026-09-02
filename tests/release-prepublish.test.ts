import { describe, expect, it } from 'bun:test';
import { parseReleasePrepublishArgs } from '../scripts/release-prepublish';

describe('release-prepublish', () => {
  it('defaults to prepare + pack audit without a publish dry-run', () => {
    expect(parseReleasePrepublishArgs([])).toEqual({ publishDryRun: false });
  });

  it('enables npm publish --dry-run when requested', () => {
    expect(parseReleasePrepublishArgs(['--publish-dry-run'])).toEqual({ publishDryRun: true });
  });

  it('rejects unknown flags', () => {
    expect(() => parseReleasePrepublishArgs(['--publish'])).toThrow(
      /Unknown release-prepublish argument: --publish/,
    );
  });
});
