import { describe, expect, it } from 'bun:test';
import { textFrame } from '../index.ts';
import { createPlainConnection } from '../src/adapters/connection-helpers.ts';

describe('createPlainConnection', () => {
  it('dispatches messages and close events to registered handlers', () => {
    const closed: Array<{ code?: number; reason?: string }> = [];
    const messages: string[] = [];
    const plain = createPlainConnection({
      protocol: 'websocket',
      mode: 'plain',
      send() {},
      close() {},
    });

    const offMsg = plain.connection.onMessage((f) => {
      messages.push(f.text ?? '');
    });
    const offClose = plain.connection.onClose((info) => {
      closed.push(info);
    });

    plain.dispatchMessage(textFrame('hi'));
    plain.dispatchClose({ code: 1000, reason: 'bye' });
    expect(messages).toEqual(['hi']);
    expect(closed).toEqual([{ code: 1000, reason: 'bye' }]);

    offMsg();
    offClose();
    plain.dispatchMessage(textFrame('noop'));
    plain.dispatchClose({ code: 1001 });
    expect(messages).toEqual(['hi']);
    expect(closed).toHaveLength(1);
  });
});
