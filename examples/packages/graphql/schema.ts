/**
 * Schema assembly.
 *
 * Importing the domain modules is all the registration there is: the decorators
 * ran when the classes were defined, so by the time `buildSemanticSchema()` is
 * called the registry already knows every type, portal, extension and enum.
 *
 * Two schemas are built from the same domain to show that bounded contexts are
 * a real seam and not documentation:
 *
 * - `library` — everything, with boundaries enforced and untyped fields banned.
 * - `publicCatalog` — Catalog and Reviews only. `Loan` disappears, and so do
 *   the fields Lending contributed to `Book`.
 */

import { buildSemanticSchema } from '@di-framework/graphql';

// Side-effect imports: defining the classes is what registers them.
import './domain/catalog.ts';
import './domain/reviews.ts';
import './domain/lending.ts';
import { libraryRegistry } from './domain/registry.ts';

/** The whole library API. */
export const library = buildSemanticSchema({
  // Read this application's declarations, not whatever else the process has
  // defined. Omit it and you get the global registry, which is fine for an app
  // that owns its process.
  registry: libraryRegistry,
  // Cross-context references to non-boundary types are a build error. This is
  // the point of the package — leave it on.
  enforceBoundaries: true,
  // Every field and argument must declare its type instead of defaulting to
  // String. Worth turning on once a schema is past its first draft.
  strictTypes: true,
  print: { directives: true },
});

/** What a public, read-mostly catalog service would expose. */
export const publicCatalog = buildSemanticSchema({
  registry: libraryRegistry,
  contexts: ['Catalog', 'Reviews'],
  enforceBoundaries: true,
  strictTypes: true,
});

export * from './domain/catalog.ts';
export * from './domain/context.ts';
export * from './domain/lending.ts';
export * from './domain/registry.ts';
export * from './domain/reviews.ts';
