import {
  type Container as DIContainer,
  defineMetadata,
  getOwnMetadata,
} from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';

export const MODEL_METADATA_KEY = 'repo:model';
/** Prototype map: propertyKey → partial identity field metadata (merged by decorators). */
export const IDENTITY_FIELDS_METADATA_KEY = 'repo:identity-fields';

/**
 * Class constructor reference used for model metadata readers.
 * (`never[]` is the safe constructor-arg top type for class decorators.)
 */
export type ModelClass = abstract new (...args: never[]) => unknown;

/* -------------------------------------------------------------------------- */
/* IdKind — identity context of a field on this model                         */
/* -------------------------------------------------------------------------- */

/**
 * Which context an identity field serves.
 *
 * `@Id` marks identities **of this model**. Foreign keys to other models are
 * not IdKinds (use relations later).
 */
export const IdKind = {
  /** Database / repository primary key. Several Primary fields = composite PK. */
  Primary: 'primary',
  /** Safe public identifier (URLs, APIs). */
  Public: 'public',
  /** Identifier assigned by an external system. */
  External: 'external',
  /** Retained identity from a previous system / migration. */
  Legacy: 'legacy',
  /** Tenant / organization partition key. */
  Tenant: 'tenant',
  /** Revision / version identity. */
  Version: 'version',
} as const;

export type IdKind = (typeof IdKind)[keyof typeof IdKind];

/* -------------------------------------------------------------------------- */
/* GenerationType — jakarta.persistence.GenerationType                        */
/* -------------------------------------------------------------------------- */

/**
 * Primary-key generation strategies, aligned with Jakarta Persistence
 * `GenerationType` (AUTO, IDENTITY, SEQUENCE, TABLE, UUID).
 *
 * **UUID:** this framework treats `GenerationType.UUID` as **UUIDv7**
 * (RFC 9562 time-ordered), not random v4. Documented divergence from typical
 * Hibernate defaults.
 */
export const GenerationType = {
  Auto: 'auto',
  Identity: 'identity',
  Sequence: 'sequence',
  Table: 'table',
  /** UUIDv7 when adapters generate values. */
  UUID: 'uuid',
} as const;

export type GenerationType = (typeof GenerationType)[keyof typeof GenerationType];

/* -------------------------------------------------------------------------- */
/* Options & metadata shapes                                                  */
/* -------------------------------------------------------------------------- */

export interface IdOptions {
  /**
   * Which identity context this field serves.
   * Defaults to `IdKind.Primary` (JPA `@Id` behavior).
   */
  kind?: IdKind;
}

export interface GeneratedValueOptions {
  /**
   * Generation strategy. Defaults to `GenerationType.Auto` when the decorator
   * is present without an explicit strategy (same as JPA).
   */
  strategy?: GenerationType;
}

export interface IdentityFieldMetadata {
  propertyKey: string;
  kind: IdKind;
  /** Present only when `@GeneratedValue` was applied on this property. */
  generated?: {
    strategy: GenerationType;
  };
}

/**
 * Internal per-property bag while decorators merge (may lack `kind` until `@Id` runs).
 */
interface IdentityFieldDraft {
  propertyKey: string;
  kind?: IdKind;
  markedId?: boolean;
  generated?: {
    strategy: GenerationType;
  };
}

export interface ModelMetadata {
  target: ModelClass;
  identities: IdentityFieldMetadata[];
}

type IdentityFieldMap = Record<string, IdentityFieldDraft>;

/* -------------------------------------------------------------------------- */
/* @Model                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marks a class as a domain data model (the typed shape used with repositories).
 *
 * The class itself is the TypeScript type — no separate interface is required.
 * Mark identity fields with `@Id` and optional `@GeneratedValue` (Spring/JPA style).
 *
 * @example
 * ```ts
 * @Model()
 * class User {
 *   @Id()
 *   @GeneratedValue({ strategy: GenerationType.Identity })
 *   id!: number;
 *
 *   @Id({ kind: IdKind.Public })
 *   @GeneratedValue({ strategy: GenerationType.UUID })
 *   publicId!: string;
 *
 *   name!: string;
 * }
 * ```
 */
export function Model() {
  return <T extends ModelClass>(target: T): T => {
    // Resolve once so invalid stacks fail at decoration time, not only on read.
    const identities = collectIdentities(target);
    const metadata: ModelMetadata = { target, identities };
    defineMetadata(MODEL_METADATA_KEY, metadata, target);
    return target;
  };
}

/* -------------------------------------------------------------------------- */
/* @Id / @GeneratedValue                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Marks a property as an identity field of this model.
 *
 * Defaults to `IdKind.Primary`. Stack with `@GeneratedValue` like JPA.
 * Multiple `@Id` fields are allowed (composite primary keys, public ids, etc.).
 */
export function Id(options: IdOptions = {}) {
  return (target: object, propertyKey: string | symbol): void => {
    mergeIdentityDraft(target, String(propertyKey), {
      markedId: true,
      kind: options.kind ?? IdKind.Primary,
    });
  };
}

/**
 * How an identity value is produced. Must be stacked with `@Id` on the same property.
 *
 * Mirrors `jakarta.persistence.GeneratedValue`. Default strategy is `Auto`.
 * `GenerationType.UUID` means **UUIDv7** in this framework.
 */
export function GeneratedValue(options: GeneratedValueOptions = {}) {
  return (target: object, propertyKey: string | symbol): void => {
    mergeIdentityDraft(target, String(propertyKey), {
      generated: {
        strategy: options.strategy ?? GenerationType.Auto,
      },
    });
  };
}

function mergeIdentityDraft(
  prototype: object,
  propertyKey: string,
  patch: Partial<IdentityFieldDraft>,
): void {
  const map: IdentityFieldMap = getOwnMetadata(IDENTITY_FIELDS_METADATA_KEY, prototype) || {};
  const prev = map[propertyKey] || { propertyKey };
  map[propertyKey] = {
    ...prev,
    ...patch,
    propertyKey,
    generated: patch.generated !== undefined ? patch.generated : prev.generated,
    kind: patch.kind !== undefined ? patch.kind : prev.kind,
    markedId: patch.markedId === true ? true : prev.markedId,
  };
  defineMetadata(IDENTITY_FIELDS_METADATA_KEY, map, prototype);
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Collect identity fields from a class, walking the prototype chain.
 * Subclass property declarations override the same property key from a base.
 *
 * @throws if `@GeneratedValue` appears without `@Id` on the same property.
 */
export function getIdentities(target: ModelClass): IdentityFieldMetadata[] {
  return collectIdentities(target);
}

/**
 * Primary-key identity field(s). Empty if none; one element for a simple PK;
 * several for a composite primary key.
 */
export function getPrimaryId(target: ModelClass): IdentityFieldMetadata[] {
  return collectIdentities(target).filter((field) => field.kind === IdKind.Primary);
}

/**
 * Read `@Model` metadata. Identity list is always resolved live from `@Id` /
 * `@GeneratedValue` so subclasses pick up overrides. Returns `undefined` if
 * the class (and its superclasses) were never decorated with `@Model`.
 */
export function getModelMetadata(target: ModelClass): ModelMetadata | undefined {
  let current: object | null = target;
  while (current !== null && current !== Function.prototype) {
    const found = getOwnMetadata(MODEL_METADATA_KEY, current);
    if (found) {
      return {
        target: (found as ModelMetadata).target,
        identities: collectIdentities(target),
      };
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/** Whether `target` (or a superclass) was decorated with `@Model`. */
export function isModel(target: ModelClass): boolean {
  return getModelMetadata(target) !== undefined;
}

function collectIdentities(target: ModelClass): IdentityFieldMetadata[] {
  // Base first, then subclass — same propertyKey from a subclass wins.
  const chain: object[] = [];
  let prototype: object | null = (target as { prototype?: object }).prototype ?? null;
  while (prototype && prototype !== Object.prototype) {
    chain.unshift(prototype);
    prototype = Object.getPrototypeOf(prototype);
  }

  const merged = new Map<string, IdentityFieldDraft>();
  for (const proto of chain) {
    const map: IdentityFieldMap | undefined = getOwnMetadata(IDENTITY_FIELDS_METADATA_KEY, proto);
    if (!map) continue;
    for (const [key, draft] of Object.entries(map)) {
      const prev = merged.get(key);
      merged.set(key, {
        ...prev,
        ...draft,
        propertyKey: key,
        generated: draft.generated !== undefined ? draft.generated : prev?.generated,
        kind: draft.kind !== undefined ? draft.kind : prev?.kind,
        markedId: draft.markedId === true || prev?.markedId === true,
      });
    }
  }

  const className = (target as { name?: string }).name ?? '(anonymous)';
  const identities: IdentityFieldMetadata[] = [];
  for (const draft of merged.values()) {
    if (draft.generated && !draft.markedId) {
      throw new Error(
        `${className}.${draft.propertyKey}: @GeneratedValue requires @Id on the same property`,
      );
    }
    if (!draft.markedId) continue;
    identities.push({
      propertyKey: draft.propertyKey,
      kind: draft.kind ?? IdKind.Primary,
      ...(draft.generated ? { generated: draft.generated } : {}),
    });
  }

  return identities;
}

/* -------------------------------------------------------------------------- */
/* @Repository                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Repository decorator.
 *
 * This package requires `@di-framework/core` as a peer dependency and
 * delegates to its `@Container` decorator to register repositories with the
 * same singleton/global container instance. Ensure you always import the DI
 * framework using the scoped package name (`@di-framework/core/*`) to
 * avoid loading multiple copies and accidentally creating multiple containers.
 */
export function Repository(options: { singleton?: boolean; container?: DIContainer } = {}) {
  return ContainerDecorator(options);
}
