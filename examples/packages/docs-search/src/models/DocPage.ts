import { Id, Model } from '@di-framework/repo';

/**
 * Document **metadata** lives in @di-framework/repo.
 * **Vectors** live in Vectorize (keyed by `id`) — not on the entity.
 */
@Model()
export class DocPage {
  /** Primary key (stable id, e.g. `docs_overview`) — also the Vectorize vector id. */
  @Id()
  id!: string;

  url!: string;
  pageTitle!: string;
  mainTitle!: string;
  breadcrumbs!: string;
  content!: string;
  product!: string;
  version!: string;
}
