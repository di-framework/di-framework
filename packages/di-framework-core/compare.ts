/** UTF-16 code-unit order. Matches `Array#sort` and does not depend on locale. */
export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
