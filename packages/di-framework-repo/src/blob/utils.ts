import type { BlobBody, BlobMetadata, BlobObject } from './types.js';

export async function bodyToUint8Array(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (typeof (body as Blob).arrayBuffer === 'function') {
    const buffer = await (body as Blob).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
      }
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    }
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  return new Uint8Array(0);
}

export function uint8ArrayToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

export function createBlobObject(
  metadata: BlobMetadata,
  dataOrStream: Uint8Array | ReadableStream<Uint8Array>,
): BlobObject {
  let cachedBytes: Uint8Array | null = dataOrStream instanceof Uint8Array ? dataOrStream : null;

  async function getBytes(): Promise<Uint8Array> {
    if (cachedBytes) return cachedBytes;
    cachedBytes = await bodyToUint8Array(dataOrStream);
    return cachedBytes;
  }

  return {
    metadata,
    stream(): ReadableStream<Uint8Array> {
      if (cachedBytes) {
        return uint8ArrayToStream(cachedBytes);
      }
      if (dataOrStream instanceof ReadableStream) {
        // If stream hasn't been consumed yet, return a tee or consumer
        const [s1, s2] = dataOrStream.tee();
        // Keep s2 for later getBytes if needed
        dataOrStream = s2;
        return s1;
      }
      return uint8ArrayToStream(new Uint8Array(0));
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = await getBytes();
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
    async text(): Promise<string> {
      const bytes = await getBytes();
      return new TextDecoder().decode(bytes);
    },
    async json<T = unknown>(): Promise<T> {
      const txt = await this.text();
      return JSON.parse(txt) as T;
    },
  };
}

export async function computeEtag(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hashHex}"`;
}
