export interface BlobMetadata {
  key: string;
  size: number;
  etag?: string;
  contentType?: string;
  lastModified?: Date;
  customMetadata?: Record<string, string>;
}

export type BlobBody =
  | ReadableStream<Uint8Array>
  | Uint8Array
  | Buffer
  | Blob
  | AsyncIterable<Uint8Array>
  | ArrayBuffer
  | string;

export interface BlobObject {
  metadata: BlobMetadata;
  stream(): ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface BlobPutOptions {
  contentType?: string;
  customMetadata?: Record<string, string>;
  contentLength?: number;
}

export interface BlobListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface BlobListResult {
  items: BlobMetadata[];
  prefixes: string[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface BlobSignedUrlOptions {
  operation: 'get' | 'put';
  expiresInSeconds?: number;
  contentType?: string;
}
