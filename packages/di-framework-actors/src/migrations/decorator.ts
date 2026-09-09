/**
 * Actor migration decorator and registry.
 */
import type { ActorMigrationDefinition, ActorMigrationOptions } from './types.js';

const actorMigrationRegistry = new Map<string, ActorMigrationDefinition[]>();

export function registerActorMigration(
  actorTypeOrClass: any,
  migration: ActorMigrationDefinition,
): void {
  const actorName =
    typeof actorTypeOrClass === 'string'
      ? actorTypeOrClass
      : (actorTypeOrClass?.name ?? String(actorTypeOrClass));

  let list = actorMigrationRegistry.get(actorName);
  if (!list) {
    list = [];
    actorMigrationRegistry.set(actorName, list);
  }
  list.push(migration);
}

export function getRegisteredActorMigrations(actorTypeOrClass: any): ActorMigrationDefinition[] {
  const actorName =
    typeof actorTypeOrClass === 'string'
      ? actorTypeOrClass
      : (actorTypeOrClass?.name ?? String(actorTypeOrClass));

  return actorMigrationRegistry.get(actorName) ? [...actorMigrationRegistry.get(actorName)!] : [];
}

export function clearRegisteredActorMigrations(): void {
  actorMigrationRegistry.clear();
}

/**
 * Decorator to register an actor migration class.
 */
export function ActorMigration(options: ActorMigrationOptions): ClassDecorator {
  return (target: any) => {
    const instance = new target();
    const up = typeof instance.up === 'function' ? instance.up.bind(instance) : () => {};
    const down = typeof instance.down === 'function' ? instance.down.bind(instance) : undefined;

    const def: ActorMigrationDefinition = {
      version: options.version,
      description: options.description,
      up,
      down,
    };

    if (options.actor) {
      registerActorMigration(options.actor, def);
    }
  };
}
