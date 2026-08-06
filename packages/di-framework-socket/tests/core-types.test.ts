import { describe, expect, it } from 'bun:test';
import { SocketCapabilityError } from '../src/core/types.ts';

describe('SocketCapabilityError', () => {
  it('builds a default message from runtime/protocol', () => {
    const err = new SocketCapabilityError('workers', 'tcp');
    expect(err.name).toBe('SocketCapabilityError');
    expect(err.runtime).toBe('workers');
    expect(err.protocol).toBe('tcp');
    expect(err.message).toContain('workers');
    expect(err.message).toContain('tcp');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts a custom message', () => {
    const err = new SocketCapabilityError('deno', 'udp', 'nope');
    expect(err.message).toBe('nope');
  });
});
