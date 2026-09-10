import { requireGuest, tryGetGuest } from '../guests.js';
import { getBindingMetadata } from '../metadata.js';

export type KeyValueGuest = {
  open(identifier: string): Promise<unknown>;
};

export class KeyValue {
  readonly bindingName: string;
  protected readonly guest: KeyValueGuest | undefined;

  constructor(guest?: KeyValueGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'keyvalue';
    this.guest = guest ?? tryGetGuest<KeyValueGuest>(this.bindingName);
  }

  open(identifier: string): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).open(identifier);
  }
}
