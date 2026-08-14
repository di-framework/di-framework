import { describe, expect, test } from 'bun:test';
import {
  buildCommandScript,
  looksLikeShellReady,
  parseCommandOutput,
  sanitizeSerial,
  shellQuote,
} from '../src/serial.ts';

describe('serial helpers', () => {
  test('shellQuote escapes single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test('sanitizeSerial strips CR and ANSI', () => {
    expect(sanitizeSerial('a\r\nb\x1b[31mred\x1b[0m')).toBe('a\nbred');
  });

  test('buildCommandScript rejects invalid env names', () => {
    expect(() => buildCommandScript('echo hi', 'abc', { env: { 'FOO-BAR': 'x' } })).toThrow(
      /invalid environment variable name/,
    );
  });

  test('buildCommandScript wraps markers and cwd/env', () => {
    const script = buildCommandScript('echo hi', 'abc', {
      cwd: '/tmp',
      env: { FOO: 'bar' },
    });
    expect(script).toContain("cd '/tmp'");
    expect(script).toContain("export FOO='bar'");
    expect(script).toContain('__DF_START_abc__');
    expect(script).toContain('__DF_END_abc:%s__');
  });

  test('parseCommandOutput extracts stdout and exit code', () => {
    const buffered = ['noise', '__DF_START_m1__', 'hello', 'world', '__DF_END_m1:0__', '# '].join(
      '\n',
    );

    expect(parseCommandOutput(buffered, 'm1')).toEqual({
      stdout: 'hello\nworld',
      exitCode: 0,
    });
  });

  test('parseCommandOutput ignores echoed script copies of the start marker', () => {
    const marker = 'm2';
    const buffered = [
      `printf '\\n__DF_START_${marker}__\\n'; (echo hi); printf '\\n__DF_END_${marker}:%s__\\n' "$?"`,
      `__DF_START_${marker}__`,
      'hi',
      `__DF_END_${marker}:0__`,
      '# ',
    ].join('\n');

    expect(parseCommandOutput(buffered, marker)).toEqual({
      stdout: 'hi',
      exitCode: 0,
    });
  });

  test('looksLikeShellReady detects prompts', () => {
    expect(looksLikeShellReady('boot...\n# ')).toBe(true);
    expect(looksLikeShellReady('/root $ ')).toBe(true);
    expect(looksLikeShellReady('still booting')).toBe(false);
  });
});
