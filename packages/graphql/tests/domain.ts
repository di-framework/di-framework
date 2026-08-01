/**
 * A two-context domain used across the tests: `Users` owns people, `Orders`
 * owns purchases and reaches into `Users` only through its boundary type.
 */

import { useContainer } from '@di-framework/di-framework/container';
import { Component, Container, Publisher } from '@di-framework/di-framework/decorators';
import {
  Action,
  Arg,
  BoundedContext,
  Ctx,
  Extends,
  Field,
  InputType,
  Lookup,
  Parent,
  Portal,
  registerEnum,
  SemanticType,
  Subscription,
} from '../src/decorators.ts';
import { SemanticRegistry, setRegistry } from '../src/registry.ts';
import { Float, ID, Int } from '../src/scalars.ts';
import type { GraphQLContext } from '../src/types.ts';

// Decorators read the registry when they are applied — which happens below, as
// each class is defined — so an isolated registry can be swapped in first.
export const domainRegistry = new SemanticRegistry();
setRegistry(domainRegistry);

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

export interface UserRow {
  id: string;
  name: string;
  email: string;
}

@Container()
export class UserRepository {
  readonly rows: UserRow[] = [
    { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'u2', name: 'Alan Turing', email: 'alan@example.com' },
  ];

  find(id: string): UserRow | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

@BoundedContext('Users')
@SemanticType({
  boundary: true,
  key: 'id',
  description: 'Someone who can place orders.',
  expose: { name: () => String, email: () => String },
})
@Container()
export class User {
  constructor(
    public id: string,
    public name: string,
    public email: string,
  ) {}

  @Field(() => String, { description: 'First name, or the whole name if there is only one.' })
  displayName(): string {
    return this.name.split(' ')[0] ?? this.name;
  }
}

@BoundedContext('Users')
@Portal()
export class UsersPortal {
  constructor(@Component(UserRepository) private repo: UserRepository) {}

  @Field(() => User, { nullable: true })
  user(@Arg('id', () => ID) id: string): UserRow | null {
    return this.repo.find(id);
  }

  @Field(() => User)
  me(ctx: GraphQLContext): UserRow {
    const row = this.repo.find(ctx.userId);
    if (!row) throw new Error('Not authenticated');
    return row;
  }
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export const OrderState = {
  Pending: 'Pending',
  Shipped: 'Shipped',
  Cancelled: 'Cancelled',
} as const;

registerEnum(OrderState, { name: 'OrderState', description: 'Lifecycle of an order.' });

@InputType({ description: 'One line of a new order.' })
export class OrderItemInput {
  @Field(() => String)
  sku!: string;

  @Field(() => Int)
  quantity!: number;

  /** Only callable if the input object was hydrated onto this class. */
  lineTotal(unitPrice: number): number {
    return unitPrice * this.quantity;
  }
}

export interface OrderRow {
  id: string;
  userId: string;
  total: number;
  state: string;
}

@Container()
export class OrderService {
  private sequence = 0;

  readonly rows: OrderRow[] = [
    { id: 'o1', userId: 'u1', total: 42, state: OrderState.Pending },
    { id: 'o2', userId: 'u1', total: 7, state: OrderState.Shipped },
    { id: 'o3', userId: 'u2', total: 13, state: OrderState.Pending },
  ];

  /** Counts loads, so batching can be asserted. */
  loads = 0;

  find(id: string): OrderRow | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  forUser(userId: string): OrderRow[] {
    this.loads++;
    return this.rows.filter((row) => row.userId === userId);
  }

  forUsers(userIds: string[]): OrderRow[][] {
    this.loads++;
    return userIds.map((userId) => this.rows.filter((row) => row.userId === userId));
  }

  @Publisher('order.placed')
  place(userId: string, items: OrderItemInput[]): OrderRow {
    this.sequence++;
    const row: OrderRow = {
      id: `o-new-${this.sequence}`,
      userId,
      // Calls a method on the input object: proof that GraphQL input values are
      // hydrated onto their @InputType class.
      total: items.reduce((sum, item) => sum + item.lineTotal(10), 0),
      state: OrderState.Pending,
    };
    this.rows.push(row);
    return row;
  }
}

@BoundedContext('Orders')
@SemanticType({
  boundary: true,
  key: 'id',
  expose: { total: () => Float, state: () => OrderState },
})
@Container()
export class Order {
  constructor(
    public id: string,
    public userId: string,
    public total: number,
    public state: string,
  ) {}

  @Lookup()
  static load(id: string): OrderRow | null {
    return useContainer().resolve(OrderService).find(id);
  }

  @Field(() => Boolean)
  cancellable(): boolean {
    return this.state === OrderState.Pending;
  }

  /** The invariant lives with the object that owns it. */
  @Action({ description: 'Cancel an order that has not shipped.' })
  cancel(@Arg('reason', () => String, { nullable: true }) reason?: string): void {
    if (!this.cancellable()) {
      throw new Error(`Order ${this.id} has already shipped and cannot be cancelled.`);
    }
    this.state = OrderState.Cancelled;
    const row = useContainer().resolve(OrderService).find(this.id);
    if (row) row.state = OrderState.Cancelled;
    if (reason) this.cancelReason = reason;
  }

  cancelReason?: string;
}

/** Orders reaches into the Users context through its boundary type. */
@BoundedContext('Orders')
@Extends(() => User)
export class UserOrders {
  constructor(@Component(OrderService) private orders: OrderService) {}

  @Field(() => [Order], { batch: 'ordersForUsers' })
  orders(@Parent() user: UserRow): OrderRow[] {
    return this.orders.forUser(user.id);
  }

  /** Batch counterpart: one call for every user resolved in the same tick. */
  ordersForUsers(users: UserRow[]): OrderRow[][] {
    return this.orders.forUsers(users.map((user) => user.id));
  }
}

@BoundedContext('Orders')
@Portal()
export class OrdersPortal {
  constructor(@Component(OrderService) private orders: OrderService) {}

  @Field(() => Order, { nullable: true })
  order(@Arg('id', () => ID) id: string): OrderRow | null {
    return this.orders.find(id);
  }

  @Action(() => Order)
  placeOrder(
    @Arg('items', () => [OrderItemInput]) items: OrderItemInput[],
    @Ctx() ctx: GraphQLContext,
  ): OrderRow {
    return this.orders.place(ctx.userId, items);
  }

  @Subscription('order.placed', () => Order)
  orderPlaced(@Parent() order: OrderRow): OrderRow {
    return order;
  }
}
