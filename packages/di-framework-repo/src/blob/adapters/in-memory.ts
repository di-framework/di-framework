import type { BlobStorageAdapter } from '../adapter.js';
import type {
  BlobBody,
  BlobListOptions,
  BlobListResult,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobSignedUrlOptions,
} from '../types.js';
import { bodyToUint8Array, computeEtag, createBlobObject } from '../utils.js';

interface StoredBlob {
  data: Uint8Array;
  metadata: BlobMetadata;
}

export class InMemoryBlobStorageAdapter implements BlobStorageAdapter {
  private readonly store = new Map<string, StoredBlob>();

  async get(key: string): Promise<BlobObject | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return createBlobObject(entry.metadata, entry.data);
  }

  async put(key: string, body: BlobBody, options: BlobPutOptions = {}): Promise<BlobMetadata> {
    const data = await bodyToUint8Array(body);
    const etag = await computeEtag(data);
    const metadata: BlobMetadata = {
      key,
      size: options.contentLength ?? data.byteLength,
      etag,
      contentType: options.contentType ?? 'application/octet-stream',
      lastModified: new Date(),
      ...(options.customMetadata ? { customMetadata: { ...options.customMetadata } } : {}),
    };

    this.store.set(key, { data, metadata });
    return metadata;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async deleteMany(keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        count++;
      }
    }
    return count;
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const entry = this.store.get(key);
    return entry ? { ...entry.metadata } : null;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async list(options: BlobListOptions = {}): Promise<BlobListResult> {
    const prefix = options.prefix ?? '';
    const delimiter = options.delimiter;
    const limit = options.limit ?? 1000;
    const cursor = options.cursor;

    const allKeys = Array.from(this.store.keys()).sort();

    const items: BlobMetadata[] = [];
    const prefixesSet = new Set<string>();

    for (const key of allKeys) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }

      if (delimiter) {
        const rest = key.slice(prefix.length);
        const delimiterIndex = rest.indexOf(delimiter);
        if (delimiterIndex !== -1) {
          const commonPrefix = prefix + rest.slice(0, delimiterIndex + delimiter.length);
          prefixesSet.add(commonPrefix);
          continue;
        }
      }

      const entry = this.store.get(key);
      if (entry) {
        items.push({ ...entry.metadata });
      }
    }

    const prefixes = Array.from(prefixesSet).sort();

    // If cursor is provided, find offset
    let startIndex = 0;
    if (cursor) {
      const idx = items.findIndex((it) => it.key > cursor);
      startIndex = idx === -1 ? items.length : idx;
    }

    const pagedItems = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < items.length;
    const nextCursor =
      hasMore && pagedItems.length > 0 ? pagedItems[pagedItems.length - 1]?.key : undefined;

    return {
      items: pagedItems,
      prefixes,
      nextCursor,
      hasMore,
    };
  }

  async getSignedUrl(key: string, options: BlobSignedUrlOptions): Promise<string> {
    const expiresIn = options.expiresInSeconds ?? 900;
    const expiresAt = Date.now() + expiresIn * 1000;
    const searchParams = new URLSearchParams({
      operation: options.operation,
      expires: String(expiresAt),
    });
    if (options.contentType) {
      searchParams.set('contentType', options.contentType);
    }
    return `https://in-memory.local/${encodeURIComponent(key)}?${searchParams.toString()}`;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  dispose(): void {
    this.clear();
  }
}
