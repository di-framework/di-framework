/**
 * Lending — the bounded context that owns who has what, and until when.
 *
 * This is where behaviour lives with the object that owns the invariant:
 * `Loan.checkIn()` and `Loan.renew()` are `@Action`s declared on the entity, so
 * the rule "you cannot renew a returned loan" cannot be routed around by a
 * resolver. The schema surfaces them as `loanCheckIn` / `loanRenew` mutations
 * keyed by the loan's id, and the entity is loaded through `@Lookup` before the
 * method runs.
 */

import { useContainer } from '@di-framework/di-framework/container';
import { Component, Container, Publisher } from '@di-framework/di-framework/decorators';
import {
  Action,
  Arg,
  BoundedContext,
  Ctx,
  DateTime,
  Extends,
  Field,
  ID,
  Int,
  Lookup,
  Parent,
  Portal,
  registerEnum,
  SemanticType,
  Subscription,
} from '@di-framework/graphql';
import { Book, type BookRow } from './catalog.ts';
import { type LibraryContext, requireMember } from './context.ts';

export const LoanState = {
  Active: 'Active',
  Returned: 'Returned',
} as const;

registerEnum(LoanState, { name: 'LoanState', description: 'Where a loan is in its life.' });

const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface LoanRow {
  id: string;
  bookId: string;
  memberId: string;
  dueAt: Date;
  state: string;
  renewals: number;
}

@Container()
export class LoanService {
  reads = 0;

  private sequence = 0;

  private readonly rows: LoanRow[] = [
    {
      id: 'l1',
      bookId: 'b1',
      memberId: 'm1',
      dueAt: new Date(Date.now() + 5 * DAY_MS),
      state: LoanState.Active,
      renewals: 0,
    },
    {
      id: 'l2',
      bookId: 'b2',
      memberId: 'm2',
      dueAt: new Date(Date.now() - 2 * DAY_MS),
      state: LoanState.Returned,
      renewals: 1,
    },
  ];

  find(id: string): LoanRow | null {
    this.reads++;
    return this.rows.find((row) => row.id === id) ?? null;
  }

  forMember(memberId: string): LoanRow[] {
    this.reads++;
    return this.rows.filter((row) => row.memberId === memberId);
  }

  /** One query for every book resolved in the same tick. */
  activeCountForBooks(bookIds: string[]): number[] {
    this.reads++;
    return bookIds.map(
      (bookId) =>
        this.rows.filter((row) => row.bookId === bookId && row.state === LoanState.Active).length,
    );
  }

  /**
   * Publishing on the container is all the service does about subscriptions —
   * `LendingPortal.loanCheckedOut` does the rest.
   */
  @Publisher('loan.checkedOut')
  checkOut(bookId: string, memberId: string): LoanRow {
    this.sequence++;
    const row: LoanRow = {
      id: `l-new-${this.sequence}`,
      bookId,
      memberId,
      dueAt: new Date(Date.now() + LOAN_DAYS * DAY_MS),
      state: LoanState.Active,
      renewals: 0,
    };
    this.rows.push(row);
    return row;
  }
}

/* -------------------------------------------------------------------------- */
/* The semantic type                                                          */
/* -------------------------------------------------------------------------- */

@BoundedContext('Lending')
@SemanticType({
  boundary: true,
  key: 'id',
  description: 'A book in somebody’s hands.',
  expose: {
    memberId: () => ID,
    dueAt: () => DateTime,
    state: () => LoanState,
    renewals: () => Int,
  },
})
export class Loan {
  constructor(
    public id: string,
    public bookId: string,
    public memberId: string,
    public dueAt: Date,
    public state: string,
    public renewals: number,
  ) {}

  @Lookup()
  static load(id: string): LoanRow | null {
    return useContainer().resolve(LoanService).find(id);
  }

  /**
   * A cross-context reference. It is legal because `Book` is a boundary type;
   * pointing at one of Catalog's internal types would fail the build. The id is
   * turned back into a `Book` through Catalog's own `@Lookup`, so Lending never
   * touches Catalog's storage.
   */
  @Field(() => Book, { nullable: true, description: 'The title on loan.' })
  book(): BookRow | null {
    return Book.load(this.bookId);
  }

  @Field(() => Boolean)
  renewable(): boolean {
    return this.state === LoanState.Active && this.renewals < MAX_RENEWALS;
  }

  @Field(() => Int, { description: 'Negative once it is overdue.' })
  daysRemaining(): number {
    return Math.ceil((this.dueAt.getTime() - Date.now()) / DAY_MS);
  }

  /**
   * An `@Action` on a semantic type becomes `loanCheckIn(id: ID!): Loan!`.
   * The method returns nothing, so the mutation resolves to the entity it was
   * invoked on — after the invariant has had its say.
   */
  @Action({ description: 'Give the book back.' })
  checkIn(): void {
    if (this.state !== LoanState.Active) {
      throw new Error(`Loan ${this.id} was already returned.`);
    }
    this.state = LoanState.Returned;
    this.persist();
  }

  @Action({ description: 'Keep it a little longer.' })
  renew(@Arg('days', () => Int, { defaultValue: 14 }) days: number): void {
    if (!this.renewable()) {
      throw new Error(
        `Loan ${this.id} cannot be renewed (${this.renewals} renewals, ${this.state}).`,
      );
    }
    this.dueAt = new Date(this.dueAt.getTime() + days * DAY_MS);
    this.renewals++;
    this.persist();
  }

  /** The hydrated instance is a view over the stored row; write changes back. */
  private persist(): void {
    const row = useContainer().resolve(LoanService).find(this.id);
    if (!row) return;
    row.state = this.state;
    row.dueAt = this.dueAt;
    row.renewals = this.renewals;
  }
}

/* -------------------------------------------------------------------------- */
/* A second context extending the same boundary type                          */
/* -------------------------------------------------------------------------- */

/**
 * `Book` now carries fields contributed by Reviews *and* Lending, and Catalog
 * still has no idea either context exists.
 */
@BoundedContext('Lending')
@Extends(() => Book)
export class BookAvailability {
  constructor(@Component(LoanService) private readonly loans: LoanService) {}

  @Field(() => Int, { batch: 'onLoanForBooks', description: 'Copies currently checked out.' })
  onLoan(@Parent() book: BookRow): number {
    return this.loans.activeCountForBooks([book.id])[0] ?? 0;
  }

  onLoanForBooks(books: BookRow[]): number[] {
    return this.loans.activeCountForBooks(books.map((book) => book.id));
  }
}

/* -------------------------------------------------------------------------- */
/* Portal                                                                     */
/* -------------------------------------------------------------------------- */

@BoundedContext('Lending')
@Portal()
export class LendingPortal {
  constructor(@Component(LoanService) private readonly loans: LoanService) {}

  @Field(() => Loan, { nullable: true })
  loan(@Arg('id', () => ID) id: string): LoanRow | null {
    return this.loans.find(id);
  }

  /** An undecorated parameter named `ctx` is the request context. */
  @Field(() => [Loan], { description: 'Everything the signed-in member has out.' })
  myLoans(ctx: LibraryContext): LoanRow[] {
    return this.loans.forMember(requireMember(ctx));
  }

  @Action(() => Loan, { description: 'Borrow a title.' })
  checkOut(@Arg('bookId', () => ID) bookId: string, @Ctx() ctx: LibraryContext): LoanRow {
    const book = Book.load(bookId);
    if (!book) throw new Error(`No such book: ${bookId}`);
    return this.loans.checkOut(bookId, requireMember(ctx));
  }

  @Subscription('loan.checkedOut', () => Loan, {
    description: 'Every checkout, or just one member’s.',
    filter: (payload, args) => !args.memberId || payload?.result?.memberId === args.memberId,
  })
  loanCheckedOut(
    @Parent() loan: LoanRow,
    @Arg('memberId', () => ID, { nullable: true }) _memberId: string | null,
  ): LoanRow {
    return loan;
  }
}
