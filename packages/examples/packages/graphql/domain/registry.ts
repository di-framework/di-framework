/**
 * The registry this application's decorators write to.
 *
 * Decorators record their declarations in whichever registry is current when
 * the class is *defined*, which is import time. An app that owns its process
 * can happily use the global one; give it a registry of its own when anything
 * else in the process might also be declaring semantic types — another schema
 * in the same test run, for instance. Every domain module imports this first,
 * so the swap always happens before the first class is defined.
 */

import { SemanticRegistry, setRegistry } from '@di-framework/graphql';

export const libraryRegistry = new SemanticRegistry();

setRegistry(libraryRegistry);
