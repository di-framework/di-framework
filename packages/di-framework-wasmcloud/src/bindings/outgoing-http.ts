import { requireGuest, tryGetGuest } from '../guests.js';
import { getBindingMetadata } from '../metadata.js';

export type OutgoingHttpGuest = {
  send(request: unknown): Promise<unknown>;
};

export class OutgoingHttp {
  readonly bindingName: string;
  protected readonly guest: OutgoingHttpGuest | undefined;

  constructor(guest?: OutgoingHttpGuest) {
    this.bindingName = getBindingMetadata(this.constructor)?.name ?? 'outgoing-http';
    this.guest = guest ?? tryGetGuest<OutgoingHttpGuest>(this.bindingName);
  }

  send(request: unknown): Promise<unknown> {
    return requireGuest(this.guest, this.bindingName).send(request);
  }
}
