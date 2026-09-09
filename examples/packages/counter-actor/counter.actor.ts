import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorMigration,
} from "@di-framework/actors";

@ActorMigration({
  actorType: "CounterActor",
  version: "1",
  description: "Initialize counter schema",
  up: async (ctx) => {
    if (ctx.db) {
      await ctx.db.run(`
        CREATE TABLE IF NOT EXISTS counter_stats (
          id TEXT PRIMARY KEY,
          total INTEGER NOT NULL
        );
      `);
    }
  },
})
@Actor({ name: "CounterActor", namespace: "examples" })
export class CounterActor {
  @ActorContext()
  private context!: ActorContext;

  private activated = false;

  async onActivate(): Promise<void> {
    this.activated = true;
  }

  async onDeactivate(): Promise<void> {
    this.activated = false;
  }

  @ActorMethod()
  async increment(step = 1): Promise<number> {
    const current = (await this.context.storage.get<number>("count")) ?? 0;
    const next = current + step;
    await this.context.storage.set("count", next);
    return next;
  }

  @ActorMethod()
  async decrement(step = 1): Promise<number> {
    const current = (await this.context.storage.get<number>("count")) ?? 0;
    const next = current - step;
    await this.context.storage.set("count", next);
    return next;
  }

  @ActorMethod()
  async getCount(): Promise<number> {
    return (await this.context.storage.get<number>("count")) ?? 0;
  }

  @ActorMethod()
  async reset(): Promise<void> {
    await this.context.storage.set("count", 0);
  }
}
