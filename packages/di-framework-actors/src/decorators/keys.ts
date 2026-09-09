import type { ActorMetadata, Constructor } from '../types.js';

export const ACTOR_METADATA_KEY = 'di:actor';
export const ACTOR_METHOD_METADATA_KEY = 'di:actor:method';
export const ACTOR_CONTEXT_METADATA_KEY = 'di:actor:context';

const metadataRegistry = new WeakMap<Constructor, ActorMetadata>();

export function getTargetConstructor(target: any): Constructor {
  if (typeof target === 'function') {
    return target as Constructor;
  }
  if (target && typeof target === 'object' && target.constructor) {
    return target.constructor as Constructor;
  }
  return target;
}

export function getOrCreateActorMetadata(target: any): ActorMetadata {
  const ctor = getTargetConstructor(target);
  let meta = metadataRegistry.get(ctor);
  if (!meta) {
    meta = {
      name: ctor.name,
      target: ctor,
      methods: new Map(),
      contextProperties: new Set(),
      contextParams: new Map(),
    };
    metadataRegistry.set(ctor, meta);
  }
  return meta;
}

export function getActorMetadata(target: any): ActorMetadata | undefined {
  const ctor = getTargetConstructor(target);
  return metadataRegistry.get(ctor);
}

const decoratedActorClasses = new Set<Constructor>();

export function registerDecoratedActorClass(target: any): void {
  const ctor = getTargetConstructor(target);
  if (typeof ctor === "function") {
    decoratedActorClasses.add(ctor);
  }
}

export function getDecoratedActorClasses(): Constructor[] {
  return Array.from(decoratedActorClasses);
}

export function clearDecoratedActorClasses(): void {
  decoratedActorClasses.clear();
}
