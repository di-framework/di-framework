import { describe, expect, it } from 'bun:test';
import { compareCodeUnits, importLines } from '../src/order.ts';

describe('importLines', () => {
  it('groups exports by module in code-unit order', () => {
    expect(importLines([])).toEqual([]);
    expect(
      importLines([
        ['../b', 'Zed'],
        ['../a', 'Beta'],
        ['../a', 'Alpha'],
      ]),
    ).toEqual(["import { Alpha, Beta } from '../a';", "import { Zed } from '../b';"]);
    expect(compareCodeUnits('_', 'a')).toBe(-1);
  });
});
