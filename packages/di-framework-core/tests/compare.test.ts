import { describe, expect, it } from 'bun:test';
import { compareCodeUnits } from '../compare.ts';

describe('compareCodeUnits', () => {
  it('orders strings by UTF-16 code unit', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1);
    expect(compareCodeUnits('b', 'a')).toBe(1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
    expect(['b', 'a', '_'].sort(compareCodeUnits)).toEqual(['_', 'a', 'b']);
  });
});
