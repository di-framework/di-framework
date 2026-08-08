/**
 * Spring Data–style query-method derivation from method names.
 *
 * Parses subjects (`find…By`, `exists…By`, `count…By`, `delete…By`, …),
 * predicates (`And` / `Or` + property operators), optional `OrderBy`,
 * and executes against a repository that can list / delete entities.
 *
 * Use {@link withDerivedQueries} to wrap a repository in a Proxy that
 * derives undeclared methods at call time.
 *
 * @see https://docs.spring.io/spring-data/jpa/reference/repositories/query-keywords-reference.html
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export type QueryLookupStrategy = 'CREATE' | 'CREATE_IF_NOT_FOUND' | 'USE_DECLARED_QUERY';

export type SubjectKind = 'query' | 'exists' | 'count' | 'delete';

export type PredicateOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in'
  | 'notIn'
  | 'containing'
  | 'notContaining'
  | 'startingWith'
  | 'endingWith'
  | 'like'
  | 'notLike'
  | 'isNull'
  | 'isNotNull'
  | 'isTrue'
  | 'isFalse'
  | 'isEmpty'
  | 'isNotEmpty';

export interface PredicateCondition {
  property: string;
  operator: PredicateOperator;
  ignoreCase: boolean;
  /** How many method arguments this condition consumes (0 for null/true/empty). */
  argCount: number;
}

export interface PredicateGroup {
  conditions: PredicateCondition[];
  /** Combinator *before* this condition relative to the previous one. First is ignored. */
  combinators: Array<'and' | 'or'>;
}

export interface OrderSpec {
  property: string;
  direction: 'asc' | 'desc';
}

export interface DerivedQuery {
  subject: SubjectKind;
  /** Original method name. */
  methodName: string;
  distinct: boolean;
  /** Limit after sort; undefined = no limit. */
  limit?: number;
  /** When true and limit is 1, return a single entity or null instead of an array. */
  singleResult: boolean;
  predicate: PredicateGroup;
  orderBy: OrderSpec[];
}

export interface DeriveQueriesOptions {
  /**
   * Default `CREATE_IF_NOT_FOUND`: use an own/declared method when present,
   * otherwise derive from the name. `CREATE` always derives for matching names.
   * `USE_DECLARED_QUERY` never derives.
   */
  queryLookupStrategy?: QueryLookupStrategy;
}

/** Minimal surface needed to execute derived queries. */
export interface DerivableRepository<E> {
  findAll(): Promise<E[]>;
  delete?(id: unknown): Promise<boolean>;
  /** Used when deleting matched entities; defaults to `id`. */
  getEntityId?(entity: E): unknown;
}

/* -------------------------------------------------------------------------- */
/* Keyword tables (Spring Data subject / predicate)                           */
/* -------------------------------------------------------------------------- */

const QUERY_INTRODUCERS = ['find', 'read', 'get', 'query', 'search', 'stream'] as const;
const DELETE_INTRODUCERS = ['delete', 'remove'] as const;

/** Longest-first so GreaterThanEqual wins over GreaterThan. */
const PREDICATE_KEYWORDS: Array<{ suffix: string; operator: PredicateOperator; argCount: number }> =
  [
    { suffix: 'IsGreaterThanEqual', operator: 'gte', argCount: 1 },
    { suffix: 'GreaterThanEqual', operator: 'gte', argCount: 1 },
    { suffix: 'IsLessThanEqual', operator: 'lte', argCount: 1 },
    { suffix: 'LessThanEqual', operator: 'lte', argCount: 1 },
    { suffix: 'IsGreaterThan', operator: 'gt', argCount: 1 },
    { suffix: 'GreaterThan', operator: 'gt', argCount: 1 },
    { suffix: 'IsLessThan', operator: 'lt', argCount: 1 },
    { suffix: 'LessThan', operator: 'lt', argCount: 1 },
    { suffix: 'IsNotContaining', operator: 'notContaining', argCount: 1 },
    { suffix: 'NotContaining', operator: 'notContaining', argCount: 1 },
    { suffix: 'NotContains', operator: 'notContaining', argCount: 1 },
    { suffix: 'IsContaining', operator: 'containing', argCount: 1 },
    { suffix: 'Containing', operator: 'containing', argCount: 1 },
    { suffix: 'Contains', operator: 'containing', argCount: 1 },
    { suffix: 'IsStartingWith', operator: 'startingWith', argCount: 1 },
    { suffix: 'StartingWith', operator: 'startingWith', argCount: 1 },
    { suffix: 'StartsWith', operator: 'startingWith', argCount: 1 },
    { suffix: 'IsEndingWith', operator: 'endingWith', argCount: 1 },
    { suffix: 'EndingWith', operator: 'endingWith', argCount: 1 },
    { suffix: 'EndsWith', operator: 'endingWith', argCount: 1 },
    { suffix: 'IsNotEmpty', operator: 'isNotEmpty', argCount: 0 },
    { suffix: 'NotEmpty', operator: 'isNotEmpty', argCount: 0 },
    { suffix: 'IsEmpty', operator: 'isEmpty', argCount: 0 },
    { suffix: 'Empty', operator: 'isEmpty', argCount: 0 },
    { suffix: 'IsNotNull', operator: 'isNotNull', argCount: 0 },
    { suffix: 'NotNull', operator: 'isNotNull', argCount: 0 },
    { suffix: 'IsNull', operator: 'isNull', argCount: 0 },
    { suffix: 'Null', operator: 'isNull', argCount: 0 },
    { suffix: 'IsNotIn', operator: 'notIn', argCount: 1 },
    { suffix: 'NotIn', operator: 'notIn', argCount: 1 },
    { suffix: 'IsIn', operator: 'in', argCount: 1 },
    { suffix: 'In', operator: 'in', argCount: 1 },
    { suffix: 'IsNotLike', operator: 'notLike', argCount: 1 },
    { suffix: 'NotLike', operator: 'notLike', argCount: 1 },
    { suffix: 'IsLike', operator: 'like', argCount: 1 },
    { suffix: 'Like', operator: 'like', argCount: 1 },
    { suffix: 'IsBetween', operator: 'between', argCount: 2 },
    { suffix: 'Between', operator: 'between', argCount: 2 },
    { suffix: 'IsAfter', operator: 'gt', argCount: 1 },
    { suffix: 'After', operator: 'gt', argCount: 1 },
    { suffix: 'IsBefore', operator: 'lt', argCount: 1 },
    { suffix: 'Before', operator: 'lt', argCount: 1 },
    { suffix: 'IsFalse', operator: 'isFalse', argCount: 0 },
    { suffix: 'False', operator: 'isFalse', argCount: 0 },
    { suffix: 'IsTrue', operator: 'isTrue', argCount: 0 },
    { suffix: 'True', operator: 'isTrue', argCount: 0 },
    { suffix: 'IsNot', operator: 'neq', argCount: 1 },
    { suffix: 'Not', operator: 'neq', argCount: 1 },
    { suffix: 'Equals', operator: 'eq', argCount: 1 },
    { suffix: 'Is', operator: 'eq', argCount: 1 },
  ];

/* -------------------------------------------------------------------------- */
/* Parse                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse a Spring Data–style repository method name into a derived query plan.
 * Returns `null` if the name is not a derivable query method.
 */
export function parseQueryMethod(methodName: string): DerivedQuery | null {
  if (typeof methodName !== 'string' || methodName.length === 0) return null;

  const byIndex = findPredicateByIndex(methodName);
  if (byIndex <= 0) return null;

  const subjectPart = methodName.slice(0, byIndex);
  const afterBy = methodName.slice(byIndex + 2); // skip "By"
  if (!afterBy) return null;

  const subject = parseSubject(subjectPart);
  if (!subject) return null;

  const { predicateText, orderBy } = splitOrderBy(afterBy);
  const predicate = parsePredicate(predicateText);
  if (!predicate) return null;

  return {
    subject: subject.kind,
    methodName,
    distinct: subject.distinct,
    limit: subject.limit,
    singleResult: subject.singleResult,
    predicate,
    orderBy,
  };
}

function findPredicateByIndex(name: string): number {
  // First "By" that starts a capital-letter property (Spring delimiter).
  // Avoid matching lowercase "by" inside words.
  const re = /By(?=[A-Z_])/;
  const m = re.exec(name);
  return m ? m.index : -1;
}

function parseSubject(
  subjectPart: string,
): { kind: SubjectKind; distinct: boolean; limit?: number; singleResult: boolean } | null {
  let rest = subjectPart;
  let kind: SubjectKind | null = null;

  for (const intro of QUERY_INTRODUCERS) {
    if (rest.startsWith(intro)) {
      kind = 'query';
      rest = rest.slice(intro.length);
      break;
    }
  }
  if (!kind && rest.startsWith('exists')) {
    kind = 'exists';
    rest = rest.slice('exists'.length);
  }
  if (!kind && rest.startsWith('count')) {
    kind = 'count';
    rest = rest.slice('count'.length);
  }
  if (!kind) {
    for (const intro of DELETE_INTRODUCERS) {
      if (rest.startsWith(intro)) {
        kind = 'delete';
        rest = rest.slice(intro.length);
        break;
      }
    }
  }
  if (!kind) return null;

  let distinct = false;
  let limit: number | undefined;
  let singleResult = false;

  // Tokens between introducer and By: Distinct, First, Top, First10, Top3, descriptive junk.
  // Process known keywords; ignore descriptive text (findUserBy… → User ignored).
  const tokenRe = /Distinct|First(\d*)|Top(\d*)/g;
  let m = tokenRe.exec(rest);
  while (m !== null) {
    if (m[0] === 'Distinct') {
      distinct = true;
    } else if (m[0].startsWith('First') || m[0].startsWith('Top')) {
      const nRaw = m[1] !== undefined ? m[1] : m[2];
      const n = nRaw === '' || nRaw === undefined ? 1 : Number.parseInt(nRaw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid limit in query method subject: ${subjectPart}`);
      }
      limit = n;
      if (n === 1) singleResult = true;
    }
    m = tokenRe.exec(rest);
  }

  // exists/count/delete ignore single-result array vs entity; query uses limit.
  if (kind !== 'query') {
    singleResult = false;
  }

  return { kind, distinct, limit, singleResult };
}

function splitOrderBy(afterBy: string): { predicateText: string; orderBy: OrderSpec[] } {
  const idx = afterBy.search(/OrderBy(?=[A-Z_])/);
  if (idx === -1) {
    return { predicateText: afterBy, orderBy: [] };
  }
  const predicateText = afterBy.slice(0, idx);
  const orderText = afterBy.slice(idx + 'OrderBy'.length);
  return { predicateText, orderBy: parseOrderBy(orderText) };
}

/**
 * Parse `PropertyAscOtherDesc…` segments without backtracking regexes.
 * Direction keywords must sit at a camelCase boundary: end of string, or
 * followed by an uppercase letter / `_` (start of the next property).
 */
function parseOrderBy(text: string): OrderSpec[] {
  if (!text) return [];
  const specs: OrderSpec[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    let direction: 'asc' | 'desc' | null = null;
    let keywordLen = 0;

    if (rest.startsWith('Desc')) {
      const after = rest[4];
      if (after === undefined || after === '_' || (after >= 'A' && after <= 'Z')) {
        direction = 'desc';
        keywordLen = 4;
      }
    } else if (rest.startsWith('Asc')) {
      const after = rest[3];
      if (after === undefined || after === '_' || (after >= 'A' && after <= 'Z')) {
        direction = 'asc';
        keywordLen = 3;
      }
    }

    if (direction !== null && i > start) {
      specs.push({
        property: toPropertyPath(text.slice(start, i)),
        direction,
      });
      i += keywordLen;
      start = i;
      continue;
    }
    i += 1;
  }

  if (specs.length === 0 && text) {
    // Bare property → ascending
    specs.push({ property: toPropertyPath(text), direction: 'asc' });
  }
  return specs;
}

function parsePredicate(text: string): PredicateGroup | null {
  if (!text) {
    // findAllBy / findBy with empty predicate — treat as match-all
    return { conditions: [], combinators: [] };
  }

  // Global AllIgnoreCase / AllIgnoringCase may appear once in the predicate.
  let allIgnoreCase = false;
  let body = text;
  body = body.replace(/AllIgnoreCase|AllIgnoringCase/g, () => {
    allIgnoreCase = true;
    return '';
  });

  const parts = splitAndOr(body);
  if (parts.segments.length === 0) return null;

  const conditions: PredicateCondition[] = [];
  for (const seg of parts.segments) {
    if (!seg) continue;
    const cond = parseCondition(seg, allIgnoreCase);
    if (!cond) return null;
    conditions.push(cond);
  }
  if (conditions.length === 0 && parts.segments.some(Boolean)) return null;

  return { conditions, combinators: parts.combinators };
}

function splitAndOr(text: string): {
  segments: string[];
  combinators: Array<'and' | 'or'>;
} {
  // Split on And/Or only when they introduce a new property (capital after).
  const segments: string[] = [];
  const combinators: Array<'and' | 'or'> = [];
  const re = /(And|Or)(?=[A-Z_])/g;
  let last = 0;
  let m = re.exec(text);
  while (m !== null) {
    segments.push(text.slice(last, m.index));
    combinators.push(m[1] === 'Or' ? 'or' : 'and');
    last = m.index + (m[1] ? m[1].length : 0);
    m = re.exec(text);
  }
  segments.push(text.slice(last));
  return { segments, combinators };
}

function parseCondition(segment: string, allIgnoreCase: boolean): PredicateCondition | null {
  let s = segment;
  if (!s) return null;

  let ignoreCase = allIgnoreCase;
  if (s.endsWith('IgnoreCase')) {
    ignoreCase = true;
    s = s.slice(0, -'IgnoreCase'.length);
  } else if (s.endsWith('IgnoringCase')) {
    ignoreCase = true;
    s = s.slice(0, -'IgnoringCase'.length);
  }

  for (const { suffix, operator, argCount } of PREDICATE_KEYWORDS) {
    if (s.endsWith(suffix) && s.length > suffix.length) {
      const prop = s.slice(0, -suffix.length);
      // Avoid treating "And" inside empty props; require property text.
      if (!prop) continue;
      return {
        property: toPropertyPath(prop),
        operator,
        ignoreCase,
        argCount,
      };
    }
  }

  // Default equality (Is / no keyword)
  return {
    property: toPropertyPath(s),
    operator: 'eq',
    ignoreCase,
    argCount: 1,
  };
}

/** `LastName` → `lastName`; `Address_ZipCode` → `address.zipCode` (underscore traversal). */
export function toPropertyPath(raw: string): string {
  if (!raw) return raw;
  // Nested path via _
  const parts = raw.split('_').filter(Boolean);
  return parts
    .map((p, i) => {
      if (i === 0) return uncapitalize(p);
      return uncapitalize(p);
    })
    .join('.');
}

function uncapitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Execute                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run a derived query plan against an in-memory entity list (and optional delete).
 */
export async function executeDerivedQuery<E>(
  query: DerivedQuery,
  repo: DerivableRepository<E>,
  args: unknown[],
): Promise<unknown> {
  const all = await repo.findAll();
  let matched = filterEntities(all, query.predicate, args);

  if (query.distinct) {
    matched = distinctByJson(matched);
  }

  if (query.orderBy.length > 0) {
    matched = sortEntities(matched, query.orderBy);
  }

  if (query.limit !== undefined) {
    matched = matched.slice(0, query.limit);
  }

  switch (query.subject) {
    case 'query':
      if (query.singleResult) {
        return matched[0] ?? null;
      }
      return matched;
    case 'exists':
      return matched.length > 0;
    case 'count':
      return matched.length;
    case 'delete': {
      const deleteFn = repo.delete?.bind(repo);
      if (!deleteFn) {
        throw new Error(`Derived delete method ${query.methodName} requires repository.delete(id)`);
      }
      const idOf = repo.getEntityId?.bind(repo) ?? ((e: E) => (e as { id?: unknown }).id);
      let n = 0;
      for (const entity of matched) {
        const id = idOf(entity);
        if (id === undefined) {
          throw new Error(`Cannot delete entity without id for derived method ${query.methodName}`);
        }
        const ok = await deleteFn(id);
        if (ok) n += 1;
      }
      return n;
    }
    default:
      return matched;
  }
}

function filterEntities<E>(entities: E[], predicate: PredicateGroup, args: unknown[]): E[] {
  if (predicate.conditions.length === 0) {
    return [...entities];
  }

  let argIndex = 0;
  const bound: Array<{ cond: PredicateCondition; values: unknown[] }> = [];
  for (const cond of predicate.conditions) {
    const values = args.slice(argIndex, argIndex + cond.argCount);
    argIndex += cond.argCount;
    bound.push({ cond, values });
  }

  return entities.filter((entity) => {
    const first = bound[0];
    if (!first) return false;
    let result = evaluateCondition(entity, first.cond, first.values);
    for (let i = 1; i < bound.length; i++) {
      const item = bound[i];
      if (!item) continue;
      const comb = predicate.combinators[i - 1] ?? 'and';
      const next = evaluateCondition(entity, item.cond, item.values);
      result = comb === 'or' ? result || next : result && next;
    }
    return result;
  });
}

function evaluateCondition<E>(entity: E, cond: PredicateCondition, values: unknown[]): boolean {
  const raw = getPath(entity as object, cond.property);
  const op = cond.operator;

  const norm = (v: unknown) => {
    if (!cond.ignoreCase) return v;
    if (typeof v === 'string') return v.toLowerCase();
    return v;
  };

  switch (op) {
    case 'eq':
      return compareEqual(norm(raw), norm(values[0]));
    case 'neq':
      return !compareEqual(norm(raw), norm(values[0]));
    case 'gt':
      return compareOrdered(raw, values[0]) > 0;
    case 'gte':
      return compareOrdered(raw, values[0]) >= 0;
    case 'lt':
      return compareOrdered(raw, values[0]) < 0;
    case 'lte':
      return compareOrdered(raw, values[0]) <= 0;
    case 'between': {
      const a = values[0];
      const b = values[1];
      return compareOrdered(raw, a) >= 0 && compareOrdered(raw, b) <= 0;
    }
    case 'in': {
      const list = Array.isArray(values[0]) ? values[0] : [];
      return list.some((x) => compareEqual(norm(raw), norm(x)));
    }
    case 'notIn': {
      const list = Array.isArray(values[0]) ? values[0] : [];
      return !list.some((x) => compareEqual(norm(raw), norm(x)));
    }
    case 'containing':
      return String(norm(raw) ?? '').includes(String(norm(values[0]) ?? ''));
    case 'notContaining':
      return !String(norm(raw) ?? '').includes(String(norm(values[0]) ?? ''));
    case 'startingWith':
      return String(norm(raw) ?? '').startsWith(String(norm(values[0]) ?? ''));
    case 'endingWith':
      return String(norm(raw) ?? '').endsWith(String(norm(values[0]) ?? ''));
    case 'like':
      return likeMatch(String(norm(raw) ?? ''), String(norm(values[0]) ?? ''));
    case 'notLike':
      return !likeMatch(String(norm(raw) ?? ''), String(norm(values[0]) ?? ''));
    case 'isNull':
      return raw === null || raw === undefined;
    case 'isNotNull':
      return raw !== null && raw !== undefined;
    case 'isTrue':
      return raw === true;
    case 'isFalse':
      return raw === false;
    case 'isEmpty':
      return isEmptyValue(raw);
    case 'isNotEmpty':
      return !isEmptyValue(raw);
    default:
      return false;
  }
}

function isEmptyValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return raw.length === 0;
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function likeMatch(value: string, pattern: string): boolean {
  // SQL LIKE: % → .* , _ → .
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`);
  return re.test(value);
}

function compareEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && (typeof b === 'string' || typeof b === 'number')) {
    return a.getTime() === new Date(b).getTime();
  }
  return false;
}

function compareOrdered(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string | number).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b as string | number).getTime();
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a > b ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa > sb ? 1 : -1;
}

function getPath(obj: object, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function sortEntities<E>(entities: E[], orderBy: OrderSpec[]): E[] {
  return [...entities].sort((a, b) => {
    for (const spec of orderBy) {
      const av = getPath(a as object, spec.property);
      const bv = getPath(b as object, spec.property);
      const c = compareOrdered(av, bv);
      if (c !== 0) return spec.direction === 'asc' ? c : -c;
    }
    return 0;
  });
}

function distinctByJson<E>(entities: E[]): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const e of entities) {
    const key = JSON.stringify(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Proxy                                                                      */
/* -------------------------------------------------------------------------- */

const DERIVED_QUERIES = Symbol.for('di-framework-repo.derivedQueries');

/**
 * Wrap a repository so undeclared `findBy…` / `existsBy…` / `countBy…` /
 * `deleteBy…` (and subject aliases) are derived from the method name at runtime.
 *
 * Prefer a `Derived<…>` assertion instead of calling this explicitly when using
 * {@link BaseRepository} subclasses (they wrap themselves in the constructor):
 *
 * ```ts
 * const repo = new InMemoryRepository<User, string>() as Derived<
 *   InMemoryRepository<User, string>
 * >;
 * await repo.findByEmail('a@example.com');
 * ```
 *
 * Declared own methods are preferred when `queryLookupStrategy` is
 * `CREATE_IF_NOT_FOUND` (default).
 */
export function withDerivedQueries<T extends DerivableRepository<unknown>>(
  repository: T,
  options: DeriveQueriesOptions = {},
): T {
  // Avoid double-wrapping (e.g. BaseRepository constructor + explicit call).
  if ((repository as { [DERIVED_QUERIES]?: boolean })[DERIVED_QUERIES]) {
    return repository;
  }

  const strategy = options.queryLookupStrategy ?? 'CREATE_IF_NOT_FOUND';

  if (strategy === 'USE_DECLARED_QUERY') {
    return repository;
  }

  const proxy = new Proxy(repository, {
    get(target, prop, receiver) {
      if (prop === DERIVED_QUERIES) return true;

      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver);
      }

      const name = String(prop);
      const existing = Reflect.get(target, prop, receiver);

      // Prefer real methods on the instance/prototype. Do not .bind — callers
      // use `repo.method()`, so `this` should remain the proxy (mocks, overrides).
      if (strategy === 'CREATE_IF_NOT_FOUND') {
        if (typeof existing === 'function' && hasOwnOrProtoMethod(target, name)) {
          return existing;
        }
        if (existing !== undefined && !isDerivableName(name)) {
          return existing;
        }
      }

      if (!isDerivableName(name)) {
        return existing;
      }

      const plan = parseQueryMethod(name);
      if (!plan) {
        if (strategy === 'CREATE') {
          return undefined;
        }
        return existing;
      }

      if (strategy === 'CREATE_IF_NOT_FOUND' && hasOwnOrProtoMethod(target, name)) {
        return existing;
      }

      return (...args: unknown[]) =>
        executeDerivedQuery(plan, target as DerivableRepository<unknown>, args);
    },
  }) as T & { [DERIVED_QUERIES]?: boolean };

  return proxy;
}

function hasOwnOrProtoMethod(target: object, name: string): boolean {
  let cur: object | null = target;
  while (cur && cur !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(cur, name);
    if (desc) {
      return typeof desc.value === 'function' || typeof desc.get === 'function';
    }
    cur = Object.getPrototypeOf(cur);
  }
  return false;
}

function isDerivableName(name: string): boolean {
  return /^(find|read|get|query|search|stream|exists|count|delete|remove)/.test(name);
}

/** Entity keys eligible for typed `findBy*` / `existsBy*` / `countBy*` helpers. */
type FinderKey<E> = Exclude<keyof E & string, 'id'>;

/**
 * Type-level single-property finders: `findByEmail`, `findByName`, …
 * (`id` is excluded so these do not collide with `Repository.findById`.)
 * Equality only; compound names like `findByAAndB` are available at runtime
 * and can be called; add an explicit method signature or cast if you want them typed.
 */
export type SimpleFinders<E> = {
  [K in FinderKey<E> as `findBy${Capitalize<K>}`]: (value: E[K]) => Promise<E[]>;
} & {
  [K in FinderKey<E> as `existsBy${Capitalize<K>}`]: (value: E[K]) => Promise<boolean>;
} & {
  [K in FinderKey<E> as `countBy${Capitalize<K>}`]: (value: E[K]) => Promise<number>;
};

/**
 * Surface derived query method types on a repository.
 *
 * Runtime derivation is already enabled for `BaseRepository` subclasses.
 * TypeScript cannot infer mapped `findBy*` members from `new`, so assert:
 *
 * ```ts
 * const repo = new InMemoryRepository<User, string>() as Derived<
 *   InMemoryRepository<User, string>
 * >;
 * await repo.findByEmail('a@example.com');
 * ```
 */
export type Derived<T extends DerivableRepository<any>> =
  T extends DerivableRepository<infer E> ? T & SimpleFinders<E> : T;

/** @deprecated Prefer {@link Derived}`<YourRepo>` on the variable. */
export type WithDerivedQueries<T, E> = T & SimpleFinders<E>;
