import type { BlobStorageAdapter } from './adapter.js';
import type {
  BlobBody,
  BlobListOptions,
  BlobListResult,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobSignedUrlOptions,
} from './types.js';

export abstract class BaseBlobRepository {
  protected constructor(protected readonly adapter: BlobStorageAdapter) {}

  protected normalizeKey(key: string): string {
    return key.replace(/^\/+/, '');
  }

  async get(key: string): Promise<BlobObject | null> {
    return this.adapter.get(this.normalizeKey(key));
  }

  async put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobMetadata> {
    return this.adapter.put(this.normalizeKey(key), body, options);
  }

  async delete(key: string): Promise<boolean> {
    return this.adapter.delete(this.normalizeKey(key));
  }

  async deleteMany(keys: string[]): Promise<number> {
    const normalizedKeys = keys.map((k) => this.normalizeKey(k));
    if (typeof this.adapter.deleteMany === 'function') {
      return this.adapter.deleteMany(normalizedKeys);
    }
    let count = 0;
    for (const key of normalizedKeys) {
      if (await this.adapter.delete(key)) {
        count++;
      }
    }
    return count;
  }

  async exists(key: string): Promise<boolean> {
    return this.adapter.exists(this.normalizeKey(key));
  }

  async head(key: string): Promise<BlobMetadata | null> {
    return this.adapter.head(this.normalizeKey(key));
  }

  async list(options?: BlobListOptions): Promise<BlobListResult> {
    return this.adapter.list(options);
  }

  async getSignedUrl(key: string, options: BlobSignedUrlOptions): Promise<string> {
    if (typeof this.adapter.getSignedUrl === 'function') {
      return this.adapter.getSignedUrl(this.normalizeKey(key), options);
    }
    throw new Error('Adapter does not support getSignedUrl');
  }

  async dispose(): Promise<void> {
    if (typeof this.adapter.dispose === 'function') {
      await this.adapter.dispose();
    }
  }
}
