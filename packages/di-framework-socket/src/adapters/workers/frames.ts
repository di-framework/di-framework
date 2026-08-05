import { binaryFrame, type SocketFrame, textFrame } from '../../core/frame.ts';

/**
 * Map a Cloudflare Workers / DO WebSocket message to a {@link SocketFrame}.
 *
 * - `string` → text frame (opcode 1)
 * - `ArrayBuffer` / `ArrayBufferView` → binary frame (opcode 2)
 */
export function cfMessageToFrame(message: string | ArrayBuffer | ArrayBufferView): SocketFrame {
  if (typeof message === 'string') return textFrame(message);
  if (message instanceof Uint8Array) return binaryFrame(message);
  if (message instanceof ArrayBuffer) return binaryFrame(new Uint8Array(message));
  if (ArrayBuffer.isView(message)) {
    const view = message as ArrayBufferView;
    return binaryFrame(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  throw new TypeError('cfMessageToFrame: expected string | ArrayBuffer | ArrayBufferView');
}

/**
 * Send a {@link SocketFrame} on a Workers/DO WebSocket, preserving opcode.
 */
export function sendFrame(
  ws: { send(data: string | ArrayBuffer | ArrayBufferView): void },
  frame: SocketFrame,
): void {
  if (frame.kind === 'text') {
    ws.send(frame.text ?? new TextDecoder().decode(frame.data));
  } else {
    ws.send(frame.data);
  }
}
