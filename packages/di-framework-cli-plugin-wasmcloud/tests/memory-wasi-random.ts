let next = 1;

export function resetMemoryRandom(): void {
  next = 1;
}

export function seedMemoryRandom(value: number): void {
  next = value;
}

/** Deterministic CSPRNG for tests. Not cryptographic. */
export function getRandomBytes(maxLen: bigint | number): Uint8Array {
  const size = Number(maxLen);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = next & 0xff;
    next = (next * 1103515245 + 12345) >>> 0;
  }
  return out;
}
