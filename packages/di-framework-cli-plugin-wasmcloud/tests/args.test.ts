import { describe, expect, it } from 'bun:test';
import { parseAppCommandArgs, parsePlatformCommandArgs, parsePlatformInitArgs } from '../src/args';
import { expectFailure } from './helpers';

describe('parseAppCommandArgs', () => {
  it('parses an optional name, --target, and --yes', () => {
    expect(parseAppCommandArgs([], 'wasmcloud deploy')).toEqual({ yes: false });
    expect(parseAppCommandArgs(['greeter'], 'wasmcloud deploy')).toEqual({
      name: 'greeter',
      yes: false,
    });
    expect(
      parseAppCommandArgs(['greeter', '--target', 'development', '--yes'], 'wasmcloud deploy'),
    ).toEqual({ name: 'greeter', target: 'development', yes: true });
    expect(parseAppCommandArgs(['--target', 'local'], 'wasmcloud deploy')).toEqual({
      target: 'local',
      yes: false,
    });
  });

  it('rejects unknown options, extra positionals, and duplicates', () => {
    expectFailure(() => parseAppCommandArgs(['--bogus'], 'wasmcloud deploy'), 'INVALID_USAGE', 2);
    expectFailure(
      () => parseAppCommandArgs(['greeter', 'echo'], 'wasmcloud deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--yes', '--yes'], 'wasmcloud deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parseAppCommandArgs(['--target', '--yes'], 'wasmcloud deploy'),
      'INVALID_USAGE',
      2,
    );
  });
});

describe('parsePlatformInitArgs', () => {
  it('accepts --force and rejects anything else', () => {
    expect(parsePlatformInitArgs([])).toEqual({ force: false });
    expect(parsePlatformInitArgs(['--force'])).toEqual({ force: true });
    expect(parsePlatformInitArgs(['-f'])).toEqual({ force: true });
    expectFailure(() => parsePlatformInitArgs(['--yes']), 'INVALID_USAGE', 2);
    expectFailure(() => parsePlatformInitArgs(['local']), 'INVALID_USAGE', 2);
    expectFailure(() => parsePlatformInitArgs(['--force', '--force']), 'INVALID_USAGE', 2);
  });
});

describe('parsePlatformCommandArgs', () => {
  it('requires a target name', () => {
    expect(parsePlatformCommandArgs(['local', '--yes'], 'wasmcloud platform deploy')).toEqual({
      target: 'local',
      yes: true,
    });
    expectFailure(
      () => parsePlatformCommandArgs([], 'wasmcloud platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', 'extra'], 'wasmcloud platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', '--unknown'], 'wasmcloud platform deploy'),
      'INVALID_USAGE',
      2,
    );
    expectFailure(
      () => parsePlatformCommandArgs(['local', '--yes', '--yes'], 'wasmcloud platform deploy'),
      'INVALID_USAGE',
      2,
    );
  });
});
