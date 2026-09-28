import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';
import { formatJobId, normalizeCronExpression } from '../cron/runtime';

describe('Cron Utilities Fuzzing', () => {
  it('normalizeCronExpression correctly formats millisecond intervals', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000000, max: 100000000 }), (ms) => {
        const result = normalizeCronExpression(ms);
        const mins = Math.max(1, Math.round(ms / 60000));

        if (mins === 1) {
          expect(result).toBe('* * * * *');
        } else {
          expect(result).toBe(`*/${mins} * * * *`);
        }
      }),
    );
  });

  it('normalizeCronExpression correctly trims string expressions', () => {
    fc.assert(
      fc.property(fc.string(), (expr) => {
        const result = normalizeCronExpression(expr);
        expect(result).toBe(expr.trim());
      }),
    );
  });

  it('formatJobId uses customName if provided and non-empty, else defaults to Class.Method', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.option(fc.string(), { nil: undefined }),
        (className, methodName, customName) => {
          const result = formatJobId(className, methodName, customName);
          if (customName && customName.trim() !== '') {
            expect(result).toBe(customName.trim());
          } else {
            expect(result).toBe(`${className}.${methodName}`);
          }
        },
      ),
    );
  });
});
