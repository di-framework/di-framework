/**
 * Native SQLite openers for Bun and Node. Imported only by the default package
 * entry; the portable entry leaves these unregistered so Wasm bundles never
 * reference `bun:sqlite` or `node:sqlite`.
 */
import { registerSqliteOpener } from './open';
import {
  type BunSqliteLike,
  type NodeSqliteLike,
  type SqlDatabase,
  wrapBunSqliteDatabase,
  wrapNodeSqliteDatabase,
} from './sql-database';

/** Opens `path` with `bun:sqlite` and adapts it to `SqlDatabase`. */
export async function openBunSqliteDatabase(path: string): Promise<SqlDatabase> {
  const { Database } = await import('bun:sqlite');
  return wrapBunSqliteDatabase(new Database(path) as unknown as BunSqliteLike);
}

/** Opens `path` with `node:sqlite` (Node 22+) and adapts it to `SqlDatabase`. */
export async function openNodeSqliteDatabase(path: string): Promise<SqlDatabase> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => NodeSqliteLike;
  };
  return wrapNodeSqliteDatabase(new DatabaseSync(path));
}

registerSqliteOpener('bun', openBunSqliteDatabase);
registerSqliteOpener('node', openNodeSqliteDatabase);
