/**
 * Reviews — the bounded context that owns opinions about books.
 *
 * Two things worth noticing:
 *
 * 1. `Review` is *not* a boundary type. It is internal to this context, and the
 *    schema builder rejects any other context that tries to reference it.
 * 2. `Review`s still show up on `Book`, through an `@Extends` class. Reviews
 *    reaches into Catalog the only sanctioned way — through Catalog's boundary
 *    type — and Catalog never learns that reviews exist.
 */

import { Component, Container, Publisher } from '@di-framework/di-framework/decorators';
import {
  Action,
  Arg,
  BoundedContext,
  Ctx,
  DateTime,
  Extends,
  Field,
  Float,
  ID,
  InputType,
  Int,
  Parent,
  Portal,
  SemanticType,
  Subscription,
} from '@di-framework/graphql';
import { Book, type BookRow } from './catalog.ts';
import { type LibraryContext, requireMember } from './context.ts';

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface ReviewRow {
  id: string;
  bookId: string;
  memberId: string;
  rating: number;
  body: string | null;
  postedAt: Date;
}

@Container()
export class ReviewRepository {
  /** How many times the store was hit. The batching demo asserts on this. */
  reads = 0;

  private sequence = 0;

  private readonly rows: ReviewRow[] = [
    {
      id: 'r1',
      bookId: 'b1',
      memberId: 'm1',
      rating: 5,
      body: 'Still the best thing about winter.',
      postedAt: new Date('2024-01-04T10:00:00.000Z'),
    },
    {
      id: 'r2',
      bookId: 'b1',
      memberId: 'm2',
      rating: 4,
      body: null,
      postedAt: new Date('2024-02-11T10:00:00.000Z'),
    },
    {
      id: 'r3',
      bookId: 'b2',
      memberId: 'm1',
      rating: 5,
      body: 'Wizards all the way down.',
      postedAt: new Date('2024-03-02T10:00:00.000Z'),
    },
  ];

  /** The naive read: one round trip per book. */
  forBook(bookId: string): ReviewRow[] {
    this.reads++;
    return this.rows.filter((row) => row.bookId === bookId);
  }

  /** The batched read: one round trip for every book resolved in the same tick. */
  forBooks(bookIds: string[]): ReviewRow[][] {
    this.reads++;
    return bookIds.map((bookId) => this.rows.filter((row) => row.bookId === bookId));
  }

  latest(limit: number): ReviewRow[] {
    this.reads++;
    return [...this.rows]
      .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
      .slice(0, limit);
  }

  add(row: Omit<ReviewRow, 'id'>): ReviewRow {
    this.sequence++;
    const created: ReviewRow = { ...row, id: `r-new-${this.sequence}` };
    this.rows.push(created);
    return created;
  }
}

/* -------------------------------------------------------------------------- */
/* The semantic type                                                          */
/* -------------------------------------------------------------------------- */

/**
 * No `boundary: true` — this type belongs to Reviews and stays there. Fields
 * declared on properties are read straight off the (hydrated) object; fields
 * declared on methods are invoked.
 */
@BoundedContext('Reviews')
@SemanticType({ description: "A member's verdict on a title." })
export class Review {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  memberId!: string;

  @Field(() => Int, { description: 'One to five stars.' })
  rating!: number;

  @Field(() => String, { nullable: true })
  body!: string | null;

  @Field(() => DateTime)
  postedAt!: Date;

  @Field(() => String)
  headline(): string {
    return `${'★'.repeat(this.rating)}${'☆'.repeat(5 - this.rating)}`;
  }
}

@InputType({ description: 'A review to post.' })
export class ReviewInput {
  @Field(() => ID)
  bookId!: string;

  @Field(() => Int)
  rating!: number;

  @Field(() => String, { nullable: true })
  body?: string;

  /** Behaviour on an input object, callable because the input is hydrated. */
  clampedRating(): number {
    return Math.min(5, Math.max(1, Math.round(this.rating)));
  }
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

@Container()
export class ReviewService {
  constructor(@Component(ReviewRepository) private readonly repo: ReviewRepository) {}

  /**
   * `@Publisher` emits on the container. The `@Subscription` below turns that
   * same event into a GraphQL subscription — the service knows nothing about
   * GraphQL.
   */
  @Publisher('review.posted')
  post(memberId: string, input: ReviewInput): ReviewRow {
    return this.repo.add({
      bookId: input.bookId,
      memberId,
      rating: input.clampedRating(),
      body: input.body ?? null,
      postedAt: new Date(),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Extending a boundary type from another context                             */
/* -------------------------------------------------------------------------- */

/**
 * Contributes `reviews` and `averageRating` to Catalog's `Book`.
 *
 * `batch: '<method>'` names the counterpart that receives every parent resolved
 * in the same tick and returns one result per parent, in order — real batching,
 * not just memoization. Without it, `{ books { reviews } }` is an N+1.
 */
@BoundedContext('Reviews')
@Extends(() => Book)
export class BookReviews {
  constructor(@Component(ReviewRepository) private readonly repo: ReviewRepository) {}

  @Field(() => [Review], { batch: 'reviewsForBooks', description: 'Newest first.' })
  reviews(@Parent() book: BookRow): ReviewRow[] {
    return this.repo.forBook(book.id);
  }

  reviewsForBooks(books: BookRow[]): ReviewRow[][] {
    return this.repo.forBooks(books.map((book) => book.id));
  }

  @Field(() => Float, {
    nullable: true,
    batch: 'averageRatingForBooks',
    description: 'Null until somebody has an opinion.',
  })
  averageRating(@Parent() book: BookRow): number | null {
    return average(this.repo.forBook(book.id));
  }

  averageRatingForBooks(books: BookRow[]): Array<number | null> {
    return this.repo.forBooks(books.map((book) => book.id)).map(average);
  }
}

function average(reviews: ReviewRow[]): number | null {
  if (reviews.length === 0) return null;
  return reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length;
}

/* -------------------------------------------------------------------------- */
/* Portal                                                                     */
/* -------------------------------------------------------------------------- */

@BoundedContext('Reviews')
@Portal()
export class ReviewsPortal {
  constructor(
    @Component(ReviewRepository) private readonly repo: ReviewRepository,
    @Component(ReviewService) private readonly reviews: ReviewService,
  ) {}

  @Field(() => [Review], { description: 'Most recent reviews across the catalog.' })
  latestReviews(
    @Arg('limit', () => Int, { nullable: true, defaultValue: 5 }) limit: number | null,
  ): ReviewRow[] {
    return this.repo.latest(limit ?? 5);
  }

  @Action(() => Review, { description: 'Post a review as the signed-in member.' })
  postReview(
    @Arg('input', () => ReviewInput) input: ReviewInput,
    @Ctx() ctx: LibraryContext,
  ): ReviewRow {
    return this.reviews.post(requireMember(ctx), input);
  }

  /**
   * Subscriptions read the container's event bus.
   *
   * `filter` runs against the raw `@Publisher` envelope — `{ className,
   * methodName, args, result, ... }` — before the payload is unwrapped, which
   * is why it reaches through `payload.result`.
   */
  @Subscription('review.posted', () => Review, {
    filter: (payload, args) => !args.bookId || payload?.result?.bookId === args.bookId,
  })
  reviewPosted(
    @Parent() review: ReviewRow,
    @Arg('bookId', () => ID, { nullable: true }) _bookId: string | null,
  ): ReviewRow {
    return review;
  }
}
