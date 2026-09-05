import type {
  BlobBody,
  BlobListOptions,
  BlobListResult,
  BlobMetadata,
  BlobObject,
  BlobPutOptions,
  BlobSignedUrlOptions,
} from './types.js';

export interface BlobStorageAdapter {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobMetadata>;
  delete(key: string): Promise<boolean>;
  deleteMany?(keys: string[]): Promise<number>;
  head(key: string): Promise<BlobMetadata | null>;
  exists(key: string): Promise<boolean>;
  list(options?: BlobListOptions): Promise<BlobListResult>;
  getSignedUrl?(key: string, options: BlobSignedUrlOptions): Promise<string>;
  dispose?(): Promise<void> | void;
}
