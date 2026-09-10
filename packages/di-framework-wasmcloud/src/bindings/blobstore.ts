import { requireGuest, tryGetGuest } from '../guests.js';
import { getBindingMetadata } from '../metadata.js';

export type BlobstoreGuest = {
  createContainer(name: string): Promise<unknown>;
  getContainer(name: string): Promise<unknown>;
};

export class Blobstore {
  readonly bindingName: string;
  protected readonly guest: BlobstoreGuest | undefined;

  constructor(guest?: BlobstoreGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'blobstore';
    this.guest = guest ?? tryGetGuest<BlobstoreGuest>(this.bindingName);
  }

  createContainer(name: string): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).createContainer(name);
  }

  getContainer(name: string): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).getContainer(name);
  }
}
