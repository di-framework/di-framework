import type { SocketFrame } from './frame.ts';
import type { MessageDuplex } from '../security/session.ts';

/**
 * In-process bidirectional duplex pair that preserves frame kind.
 */
export function createMemoryDuplexPair(): { left: MessageDuplex; right: MessageDuplex } {
  type Handler = (frame: SocketFrame) => void;

  const leftHandlers = new Set<Handler>();
  const rightHandlers = new Set<Handler>();
  let closed = false;

  const left: MessageDuplex = {
    send(frame) {
      if (closed) return;
      for (const h of rightHandlers) h(frame);
    },
    onMessage(handler) {
      leftHandlers.add(handler);
      return () => leftHandlers.delete(handler);
    },
    close() {
      closed = true;
      leftHandlers.clear();
      rightHandlers.clear();
    },
  };

  const right: MessageDuplex = {
    send(frame) {
      if (closed) return;
      for (const h of leftHandlers) h(frame);
    },
    onMessage(handler) {
      rightHandlers.add(handler);
      return () => rightHandlers.delete(handler);
    },
    close() {
      closed = true;
      leftHandlers.clear();
      rightHandlers.clear();
    },
  };

  return { left, right };
}
