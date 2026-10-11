import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { pgValue as pgValueFromIndex } from '../src/index';
import { pgValue as pgValueFromPortable } from '../src/portable';
import {
  assertBatch,
  float8,
  int8,
  isUniqueViolation,
  pgScalar,
  pgValue,
  postgresError,
  readRows,
  text,
  uuid,
} from '../src/postgres';

const cell = (val: string) => ({ tag: 'text' as const, val });

function stream(rows: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const row of rows) yield row;
    },
  };
}

function table(columns: unknown, rows: readonly unknown[], done: unknown = null): unknown[] {
  return [columns, stream(rows), done];
}

describe('wasmCloud postgres values', () => {
  let errorLog: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorLog = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  test('tags parameters for the binary postgres binding', () => {
    expect(pgValue(null)).toEqual({ tag: 'null' });
    expect(pgValue(undefined)).toEqual({ tag: 'null' });
    expect(pgValue('acme')).toEqual(text('acme'));
    expect(text('acme')).toEqual({ tag: 'text', val: 'acme' });
    expect(pgValue('11111111-1111-4111-8111-111111111111')).toEqual({
      tag: 'uuid',
      val: '11111111-1111-4111-8111-111111111111',
    });
    expect(pgValue('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toEqual({
      tag: 'uuid',
      val: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    });
    expect(pgValue(true)).toEqual({ tag: 'bool', val: true });
    expect(pgValue(false)).toEqual({ tag: 'bool', val: false });
    expect(pgValue(4)).toEqual({ tag: 'int4', val: 4 });
    expect(pgValue(-2_147_483_648)).toEqual({ tag: 'int4', val: -2_147_483_648 });
    expect(pgValue(2_147_483_647)).toEqual({ tag: 'int4', val: 2_147_483_647 });
    expect(pgValue(2_147_483_648)).toEqual({ tag: 'int8', val: 2_147_483_648n });
    expect(pgValue(-2_147_483_649)).toEqual({ tag: 'int8', val: -2_147_483_649n });
    expect(pgValue(3n)).toEqual({ tag: 'int8', val: 3n });
    expect(pgValue(9007199254740993n)).toEqual({ tag: 'int8', val: 9007199254740993n });
    expect(pgValue(1.5)).toEqual({ tag: 'numeric', val: '1.5' });
    expect(() => pgValue(2 ** 53)).toThrow('exact integer');
    expect(() => pgValue(9223372036854775808n)).toThrow('signed 64-bit range');
    expect(() => pgValue(-9223372036854775809n)).toThrow('signed 64-bit range');
    expect(() => pgValue(Number.NaN)).toThrow('finite number');
    expect(() => pgValue(Number.POSITIVE_INFINITY)).toThrow('finite number');
    expect(pgValue(new Uint8Array([1, 2]))).toEqual({ tag: 'bytea', val: [1, 2] });
    expect(pgValue({ id: 1 })).toEqual({ tag: 'jsonb', val: '{"id":1}' });
    const date = new Date('2026-10-03T13:04:05.006Z');
    expect(pgValue(date)).toEqual({
      tag: 'timestamp-tz',
      val: {
        timestamp: {
          date: { tag: 'ymd', val: [2026, 10, 3] },
          time: { hour: 13, min: 4, sec: 5, micro: 6000 },
        },
        offset: { tag: 'eastern-hemisphere-secs', val: 0 },
      },
    });
  });

  test('decodes result scalars to JSON values', () => {
    expect(pgScalar(null)).toBeNull();
    expect(pgScalar(1)).toBe(1);
    expect(pgScalar({ tag: 'null' })).toBeNull();
    expect(pgScalar({ tag: 'text' })).toBeNull();
    expect(pgScalar({ tag: 'text', val: 'acme' })).toBe('acme');
    expect(pgScalar({ tag: 'varchar', val: 'plain' })).toBe('plain');
    expect(pgScalar({ tag: 'varchar', val: [null, { 1: 99, 0: 65 }] })).toBe('Ac');
    expect(pgScalar({ tag: 'varchar', val: [null, [65, 99]] })).toBe('Ac');
    expect(pgScalar({ tag: 'name', val: [4, new Uint8Array([65, 99, 109, 101])] })).toBe('Acme');
    expect(pgScalar({ tag: 'text', val: 1 })).toBeNull();
    expect(pgScalar({ tag: 'text', val: { unused: true } })).toBeNull();
    expect(pgScalar({ other: true })).toEqual({ other: true });
    expect(pgScalar({ tag: 'int4', val: 4 })).toBe(4);
    expect(pgScalar({ tag: 'int8', val: 3n })).toBe(3);
    expect(pgScalar({ tag: 'int8', val: 9007199254740993n })).toBe('9007199254740993');
    expect(pgScalar({ tag: 'big-int', val: 4n })).toBe(4);
    expect(pgScalar({ tag: 'bigserial', val: 8n })).toBe(8);
    expect(pgScalar({ tag: 'serial8', val: 9n })).toBe(9);
    expect(pgScalar({ tag: 'int8', val: 4 })).toBe(4);
    expect(pgScalar({ tag: 'int8' })).toBeNull();
    expect(JSON.stringify(pgScalar({ tag: 'int8', val: 9007199254740993n }))).toBe(
      '"9007199254740993"',
    );
    expect(pgScalar({ tag: 'uuid', val: '11111111-1111-4111-8111-111111111111' })).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pgScalar({ tag: 'bool', val: false })).toBe(false);
    expect(pgScalar({ tag: 'boolean', val: true })).toBe(true);
    expect(pgScalar({ tag: 'jsonb', val: '{"a":1}' })).toEqual({ a: 1 });
    expect(pgScalar({ tag: 'jsonb', val: 'not-json' })).toBe('not-json');
    expect(pgScalar({ tag: 'json', val: 1 })).toBe(1);
    expect(pgScalar({ tag: 'timestamp', val: '2026-10-03T00:00:00.000Z' })).toBe(
      '2026-10-03T00:00:00.000Z',
    );
    expect(pgScalar({ tag: 'timestamp', val: 1 })).toBeNull();
    expect(pgScalar({ tag: 'timestamp', val: { date: { tag: 'other' } } })).toBeNull();
    expect(
      pgScalar({ tag: 'timestamp', val: { timestamp: { date: { tag: 'other' } } } }),
    ).toBeNull();
    expect(pgScalar({ tag: 'timestamp', val: { timestamp: 'nope' } })).toBeNull();
    expect(
      pgScalar({
        tag: 'timestamp',
        val: { timestamp: { date: { tag: 'ymd', val: [2026, 10] } } },
      }),
    ).toBeNull();
    expect(
      pgScalar({
        tag: 'timestamp',
        val: {
          val: {
            date: { tag: 'ymd', val: [2026, 1, 2] },
            time: { hour: 1, min: 2, sec: 3, micro: 4000 },
          },
        },
      }),
    ).toBe('2026-01-02T01:02:03.004Z');
    expect(pgScalar({ tag: 'json' })).toBeNull();
    expect(pgScalar({ tag: 'int4' })).toBeNull();
    const date = new Date('2026-10-03T13:04:05.006Z');
    expect(pgScalar({ tag: 'timestamp-tz', val: pgValue(date).val })).toBe(
      '2026-10-03T13:04:05.006Z',
    );
  });

  describe('64-bit payloads from either componentize-qjs runtime', () => {
    // di.4 and older lift s64/u64 as a Number; di.5 and jco lift a BigInt.
    const runtimes = [
      { name: 'BigInt (0.4.4-di.5, jco)', lift: (value: bigint): bigint | number => value },
      { name: 'Number (0.4.4-di.4)', lift: (value: bigint): bigint | number => Number(value) },
    ];

    /** `f64::integer_decode`, the layout the host uses for float8. */
    const f64Tuple = (value: number) => float8(value).val as [bigint, number, number];

    /** `f32::integer_decode`, the layout the host uses for float4. */
    function f32Tuple(value: number): [bigint, number, number] {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, value);
      const bits = view.getUint32(0);
      const sign = bits >>> 31 === 0 ? 1 : -1;
      const exponent = (bits >>> 23) & 0xff;
      const fraction = bits & 0x7fffff;
      const mantissa = exponent === 0 ? fraction << 1 : fraction | 0x800000;
      return [BigInt(mantissa), exponent - 150, sign];
    }

    const F64_SAMPLES = [
      0,
      -0,
      1.5,
      -0.1,
      Math.PI,
      1e300,
      -1e-300,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      2 ** -1022,
      2 ** -1074 * 12345,
      2 ** 53 + 2,
    ];
    const F32_SAMPLES = [0, 1.5, Math.fround(0.1), Math.fround(-3.4e38), Math.fround(1e-40)];

    for (const { name, lift } of runtimes) {
      const f64 = (value: number) => {
        const [mantissa, exponent, sign] = f64Tuple(value);
        return [lift(mantissa), exponent, sign];
      };
      const f32 = (value: number) => {
        const [mantissa, exponent, sign] = f32Tuple(value);
        return [lift(mantissa), exponent, sign];
      };
      const pt = (x: number, y: number) => [f64(x), f64(y)];

      test(`decodes integer cases lifted as ${name}`, () => {
        for (const tag of [
          'int8',
          'big-int',
          'big-serial',
          'bigserial',
          'serial8',
          'txid-snapshot',
          'pg-lsn',
        ]) {
          expect(pgScalar({ tag, val: lift(42n) })).toBe(42);
          expect(pgScalar({ tag, val: lift(-(2n ** 53n) + 1n) })).toBe(-(2 ** 53) + 1);
          expect(pgScalar({ tag })).toBeNull();
        }
        expect(pgScalar({ tag: 'int8-array', val: [lift(1n), lift(-2n)] })).toEqual([1, -2]);
        expect(pgScalar({ tag: 'pg-lsn-array', val: [lift(7n)] })).toEqual([7]);
        expect(pgScalar({ tag: 'pg-snapshot', val: [lift(10n), lift(12n), [lift(11n)]] })).toEqual([
          10,
          12,
          [11],
        ]);
      });

      test(`decodes float and geometric cases lifted as ${name}`, () => {
        for (const sample of F64_SAMPLES) {
          expect(pgScalar({ tag: 'float8', val: f64(sample) })).toBe(sample);
          expect(pgScalar({ tag: 'double', val: f64(sample) })).toBe(sample);
        }
        for (const sample of F32_SAMPLES) {
          expect(pgScalar({ tag: 'float4', val: f32(sample) })).toBe(sample);
          expect(pgScalar({ tag: 'real', val: f32(sample) })).toBe(sample);
        }
        // Infinity and NaN, in both the f64 and the f32 layout, decode to
        // PostgreSQL's text forms so JSON.stringify does not turn them into null.
        expect(pgScalar({ tag: 'float8', val: [lift(2n ** 52n), 972, 1] })).toBe('Infinity');
        expect(pgScalar({ tag: 'float8', val: [lift(2n ** 52n), 972, -1] })).toBe('-Infinity');
        expect(pgScalar({ tag: 'float8', val: [lift(2n ** 52n + 1n), 972, 1] })).toBe('NaN');
        expect(pgScalar({ tag: 'float4', val: f32(Number.NEGATIVE_INFINITY) })).toBe('-Infinity');
        expect(pgScalar({ tag: 'float4', val: f32(Number.NaN) })).toBe('NaN');
        expect(
          JSON.parse(
            JSON.stringify(
              pgScalar({ tag: 'float8-array', val: [[lift(2n ** 52n), 972, -1], f64(1)] }),
            ),
          ),
        ).toEqual(['-Infinity', 1]);

        expect(pgScalar({ tag: 'float8-array', val: [f64(1.5), f64(-2)] })).toEqual([1.5, -2]);
        expect(pgScalar({ tag: 'float4-array', val: [f32(0.5)] })).toEqual([0.5]);
        expect(pgScalar({ tag: 'point', val: pt(1, -2) })).toEqual([1, -2]);
        expect(pgScalar({ tag: 'point-array', val: [pt(1, 2)] })).toEqual([[1, 2]]);
        for (const tag of ['path', 'polygon']) {
          expect(pgScalar({ tag, val: [pt(0, 0), pt(1.5, 2)] })).toEqual([
            [0, 0],
            [1.5, 2],
          ]);
          expect(pgScalar({ tag: `${tag}-array`, val: [[pt(0, 1)]] })).toEqual([[[0, 1]]]);
        }
        for (const tag of ['box', 'line', 'lseg']) {
          expect(pgScalar({ tag, val: [pt(0, 0.25), pt(3, 4)] })).toEqual([
            [0, 0.25],
            [3, 4],
          ]);
          expect(pgScalar({ tag: `${tag}-array`, val: [[pt(0, 1), pt(2, 3)]] })).toEqual([
            [
              [0, 1],
              [2, 3],
            ],
          ]);
        }
        expect(pgScalar({ tag: 'circle', val: [pt(1, 2), f64(0.5)] })).toEqual([[1, 2], 0.5]);
        expect(pgScalar({ tag: 'circle-array', val: [[pt(1, 2), f64(3)]] })).toEqual([[[1, 2], 3]]);
      });
    }

    test('keeps BigInt values above 2^53 exact as decimal strings', () => {
      expect(pgScalar({ tag: 'int8', val: 9007199254740993n })).toBe('9007199254740993');
      expect(pgScalar({ tag: 'big-serial', val: 2n ** 62n })).toBe('4611686018427387904');
      expect(pgScalar({ tag: 'big-int', val: -(2n ** 63n) })).toBe('-9223372036854775808');
      expect(pgScalar({ tag: 'txid-snapshot', val: 2n ** 63n - 1n })).toBe('9223372036854775807');
      expect(pgScalar({ tag: 'pg-lsn', val: 2n ** 64n - 1n })).toBe('18446744073709551615');
      expect(pgScalar({ tag: 'int8-array', val: [1n, 2n ** 53n + 1n] })).toEqual([
        1,
        '9007199254740993',
      ]);
      expect(pgScalar({ tag: 'pg-lsn-array', val: [2n ** 60n] })).toEqual(['1152921504606846976']);
      expect(pgScalar({ tag: 'pg-snapshot', val: [10n, 2n ** 60n, [2n ** 53n + 1n]] })).toEqual([
        10,
        '1152921504606846976',
        ['9007199254740993'],
      ]);
      // A Number from an older runtime was already rounded; it passes through.
      expect(pgScalar({ tag: 'int8', val: 2 ** 60 })).toBe(2 ** 60);
    });

    test('passes malformed 64-bit payloads through unchanged', () => {
      expect(pgScalar({ tag: 'float8', val: 'nope' })).toBe('nope');
      expect(pgScalar({ tag: 'float8', val: [1n, 0] })).toEqual([1n, 0]);
      expect(pgScalar({ tag: 'float8', val: ['1', 0, 1] })).toEqual(['1', 0, 1]);
      // A malformed exponent or sign passes through rather than decoding to NaN.
      expect(pgScalar({ tag: 'float8', val: [1n, 'x', 1] })).toEqual([1n, 'x', 1]);
      expect(pgScalar({ tag: 'float8', val: [1, 0, null] })).toEqual([1, 0, null]);
      expect(pgScalar({ tag: 'float4', val: [1n, undefined, 1] })).toEqual([1n, undefined, 1]);
      expect(pgScalar({ tag: 'float8-array', val: 'nope' })).toBe('nope');
      expect(pgScalar({ tag: 'point', val: 'nope' })).toBe('nope');
      expect(pgScalar({ tag: 'float8' })).toBeNull();
      // Elements beyond the WIT tuple shape pass through unchanged.
      expect(pgScalar({ tag: 'pg-snapshot', val: [1n, 2n, [], 2n ** 60n] })).toEqual([
        1,
        2,
        [],
        2n ** 60n,
      ]);
      expect(pgScalar({ tag: 'point', val: [f64Tuple(1), f64Tuple(2), 2n ** 60n, 'z'] })).toEqual([
        1,
        2,
        2n ** 60n,
        'z',
      ]);
      // Tags are looked up as own keys only.
      expect(pgScalar({ tag: 'constructor', val: 1 })).toBe(1);
    });

    test('readRows output is JSON-safe and exact for BigInt and Number cells', async () => {
      const columns = [
        'id',
        'ids',
        'serial',
        'lsn',
        'lsns',
        'txid',
        'snapshot',
        'score',
        'scores',
        'ratio',
        'ratios',
        'at',
        'area',
      ];
      const pointCell = (lift: (value: bigint) => bigint | number) => {
        const [xm, xe, xs] = f64Tuple(1.25);
        const [ym, ye, ys] = f64Tuple(-2);
        return [
          [lift(xm), xe, xs],
          [lift(ym), ye, ys],
        ];
      };
      const bigRow = [
        { tag: 'int8', val: 9007199254740993n },
        { tag: 'int8-array', val: [1n, 2n ** 62n] },
        { tag: 'big-serial', val: 2n ** 53n + 1n },
        { tag: 'pg-lsn', val: 2n ** 64n - 1n },
        { tag: 'pg-lsn-array', val: [16n] },
        { tag: 'txid-snapshot', val: 2n ** 63n - 1n },
        { tag: 'pg-snapshot', val: [5n, 2n ** 60n, [6n]] },
        { tag: 'float8', val: f64Tuple(0.1) },
        { tag: 'float8-array', val: [f64Tuple(1e300), f64Tuple(Number.MIN_VALUE)] },
        { tag: 'float4', val: f32Tuple(Math.fround(0.1)) },
        { tag: 'float4-array', val: [f32Tuple(2.5)] },
        { tag: 'point', val: pointCell((value) => value) },
        { tag: 'circle', val: [pointCell((value) => value), f64Tuple(3)] },
      ];
      const numberRow = bigRow.map((cell) => ({
        tag: cell.tag,
        val: JSON.parse(
          JSON.stringify(cell.val, (_key, value) =>
            typeof value === 'bigint' ? Number(value) : value,
          ),
        ) as unknown,
      }));

      const rows = await readRows(table(columns, [bigRow, numberRow]));
      expect(() => JSON.stringify(rows)).not.toThrow();
      expect(JSON.parse(JSON.stringify(rows[0]))).toEqual({
        id: '9007199254740993',
        ids: [1, '4611686018427387904'],
        serial: '9007199254740993',
        lsn: '18446744073709551615',
        lsns: [16],
        txid: '9223372036854775807',
        snapshot: [5, '1152921504606846976', [6]],
        score: 0.1,
        scores: [1e300, Number.MIN_VALUE],
        ratio: Math.fround(0.1),
        ratios: [2.5],
        at: [1.25, -2],
        area: [[1.25, -2], 3],
      });
      // An older runtime rounds integers above 2^53; floats and safe integers stay exact.
      expect(JSON.parse(JSON.stringify(rows[1]))).toEqual({
        id: 9007199254740992,
        ids: [1, 2 ** 62],
        serial: 9007199254740992,
        lsn: 2 ** 64,
        lsns: [16],
        txid: 2 ** 63,
        snapshot: [5, 2 ** 60, [6]],
        score: 0.1,
        scores: [1e300, Number.MIN_VALUE],
        ratio: Math.fround(0.1),
        ratios: [2.5],
        at: [1.25, -2],
        area: [[1.25, -2], 3],
      });
    });
  });

  test('detects unique violations and formats err variant messages', () => {
    const wrapped = new Error('PostgreSQL already');
    expect(postgresError(wrapped)).toBe(wrapped);
    expect(errorLog).not.toHaveBeenCalled();

    expect(postgresError({ code: '23505', message: 'duplicate key value' }).message).toBe(
      'PostgreSQL 23505 duplicate key value',
    );
    expect(postgresError({ val: { code: '42601' } }).message).toBe('PostgreSQL 42601');
    expect(postgresError({ message: 'down' }).message).toBe('PostgreSQL down');
    expect(postgresError({ code: '' }).message).toBe('PostgreSQL rejected the statement');
    const payload = Object.assign(new Error('[object Object] (see error.payload)'), {
      payload: { tag: 'query-failed', val: { code: '42601', message: 'syntax error' } },
    });
    expect(postgresError(payload).message).toBe('PostgreSQL 42601 syntax error');
    expect(postgresError({ tag: 'invalid-params', val: 'wrong type' }).message).toBe(
      'PostgreSQL invalid-params wrong type',
    );
    expect(postgresError({ tag: 'access-denied' }).message).toBe('PostgreSQL access-denied');
    expect(postgresError({ tag: 'err', val: { message: 'bad' } }).message).toBe('PostgreSQL bad');
    expect(postgresError({ tag: 'ok' }).message).toBe('PostgreSQL rejected the statement');
    expect(postgresError(new Error('connection reset')).message).toBe(
      'PostgreSQL connection reset',
    );
    expect(postgresError(null).message).toBe('PostgreSQL rejected the statement');
    expect(postgresError({ tag: 1, val: 2 }).message).toBe('PostgreSQL rejected the statement');

    expect(isUniqueViolation(postgresError({ code: '23505', message: 'duplicate key' }))).toBe(
      true,
    );
    expect(isUniqueViolation(new Error('duplicate key value'))).toBe(true);
    expect(isUniqueViolation(new Error('PostgreSQL 42P01 missing'))).toBe(false);
    expect(
      isUniqueViolation(new Error('PostgreSQL 22P02 invalid input syntax for type uuid: "123505"')),
    ).toBe(false);
    expect(isUniqueViolation(new Error('PostgreSQL 235050 too wide'))).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  test('reads row streams and rejects a failed err variant', async () => {
    const rows = await readRows({
      tag: 'ok',
      val: table(['id', 'slug'], [[cell('u'), cell('acme')]]),
    });
    expect(rows).toEqual([{ id: 'u', slug: 'acme' }]);
    expect(await readRows(table(['id'], [[cell('u')]], {}))).toEqual([{ id: 'u' }]);

    let reads = 0;
    const readable = {
      read: async (count?: number) => {
        expect(count).toBe(64);
        reads += 1;
        return reads === 1 ? [[cell('only')]] : [];
      },
    };
    expect(await readRows([['name'], readable, null])).toEqual([{ name: 'only' }]);
    const sync = {
      *[Symbol.iterator]() {
        yield [cell('sync')];
      },
    };
    expect(await readRows([['name'], sync, Promise.resolve({ tag: 'ok' })])).toEqual([
      { name: 'sync' },
    ]);
    expect(await readRows(table([1, 'id'], [[cell('skip'), cell('keep')]]))).toEqual([
      { id: 'keep' },
    ]);

    const failed = { tag: 'err', val: { code: '23505', message: 'duplicate key value' } };
    const rejected = await readRows(failed).then(
      () => {
        throw new Error('expected the err variant to reject');
      },
      (cause: unknown) => cause,
    );
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe('PostgreSQL 23505 duplicate key value');
    expect(isUniqueViolation(rejected)).toBe(true);
    expect(() => assertBatch(failed)).toThrow('PostgreSQL 23505 duplicate key value');
    expect(() => assertBatch({ tag: 'ok' })).not.toThrow();

    await expect(readRows({ tag: 'err', val: { message: 'bad' } })).rejects.toThrow(
      'PostgreSQL bad',
    );
    await expect(readRows({ tag: 'ok' })).rejects.toThrow('unexpected result');
    await expect(readRows(['id', 'nope', null])).rejects.toThrow('row stream');
    await expect(readRows(['id', { nope: true }, null])).rejects.toThrow('row stream');
    await expect(readRows(table('id', [[cell('u')]]))).rejects.toThrow('unexpected row');
    await expect(readRows(table(['id'], ['nope']))).rejects.toThrow('unexpected row');
    await expect(readRows(null)).rejects.toThrow('unexpected result');
    await expect(
      readRows(table(['id'], [], { read: async () => ({ tag: 'err', val: { message: 'late' } }) })),
    ).rejects.toThrow('PostgreSQL late');
    await expect(
      readRows(table(['id'], [], Promise.resolve({ tag: 'err', val: { code: '57014' } }))),
    ).rejects.toThrow('PostgreSQL 57014');
  });

  test('lets the caller name the column type', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(pgValue(id, 'text')).toEqual(text(id));
    expect(text(id).tag).toBe('text');
    expect(pgValue('not-a-uuid', 'uuid')).toEqual(uuid('not-a-uuid'));
    expect(uuid(id)).toEqual({ tag: 'uuid', val: id });
    expect(pgValue(4, 'int8')).toEqual(int8(4));
    expect(int8(4)).toEqual({ tag: 'int8', val: 4n });
    expect(int8(4n)).toEqual({ tag: 'int8', val: 4n });
    expect(pgValue(4, 'int4')).toEqual({ tag: 'int4', val: 4 });
    expect(pgValue(4n, 'int4')).toEqual({ tag: 'int4', val: 4 });
    expect(pgValue(-2_147_483_648, 'int4')).toEqual({ tag: 'int4', val: -2_147_483_648 });
    expect(pgValue(1.5, 'numeric')).toEqual({ tag: 'numeric', val: '1.5' });
    expect(pgValue('1.50', 'numeric')).toEqual({ tag: 'numeric', val: '1.50' });
    expect(pgValue(true, 'bool')).toEqual({ tag: 'bool', val: true });
    expect(pgValue('{"a":1}', 'jsonb')).toEqual({ tag: 'jsonb', val: '{"a":1}' });
    expect(pgValue({ a: 1 }, 'jsonb')).toEqual({ tag: 'jsonb', val: '{"a":1}' });
    expect(pgValue(new Uint8Array([1]), 'bytea')).toEqual({ tag: 'bytea', val: [1] });
    const date = new Date('2026-10-03T13:04:05.006Z');
    expect(pgValue(date, 'timestamp-tz')).toEqual(pgValue(date));
    expect(pgValue(null, 'int8')).toEqual({ tag: 'null' });

    const encoded = float8(1.5);
    expect(encoded.tag).toBe('float8');
    expect(pgValue(1.5, 'float8')).toEqual(encoded);
    const [mantissa, exponent, sign] = encoded.val as [bigint, number, number];
    expect(sign * Number(mantissa) * 2 ** exponent).toBe(1.5);
    const negative = float8(-0);
    const [zeroMantissa, , zeroSign] = negative.val as [bigint, number, number];
    expect(zeroMantissa).toBe(0n);
    expect(zeroSign).toBe(-1);
    expect(float8(Number.MIN_VALUE).tag).toBe('float8');
    const [subMantissa] = float8(Number.MIN_VALUE).val as [bigint, number, number];
    expect(subMantissa).toBeGreaterThan(0n);

    expect(() => pgValue(1, 'text')).toThrow('text parameter has the wrong type');
    expect(() => pgValue(1, 'uuid')).toThrow('uuid parameter has the wrong type');
    expect(() => pgValue('no', 'bool')).toThrow('bool parameter has the wrong type');
    expect(() => pgValue(1.5, 'int4')).toThrow('int4 parameter has the wrong type');
    expect(() => pgValue(2_147_483_648, 'int4')).toThrow('int4 parameter has the wrong type');
    expect(() => pgValue(2_147_483_648n, 'int4')).toThrow('int4 parameter has the wrong type');
    expect(() => pgValue(1.5, 'int8')).toThrow('int8 parameter has the wrong type');
    expect(() => pgValue('4', 'int8')).toThrow('int8 parameter has the wrong type');
    expect(() => int8(1.5)).toThrow('int8 parameter has the wrong type');
    expect(() => pgValue('1', 'float8')).toThrow('float8 parameter has the wrong type');
    expect(() => float8(Number.NaN)).toThrow('float8 parameter has the wrong type');
    expect(() => float8(Number.POSITIVE_INFINITY)).toThrow('float8 parameter has the wrong type');
    expect(() => pgValue(Number.NaN, 'numeric')).toThrow('numeric parameter has the wrong type');
    expect(() => pgValue(true, 'numeric')).toThrow('numeric parameter has the wrong type');
    expect(() => pgValue('2026-10-03', 'timestamp-tz')).toThrow(
      'timestamp-tz parameter has the wrong type',
    );
    expect(() => pgValue(new Date(Number.NaN), 'timestamp-tz')).toThrow(
      'timestamp-tz parameter has the wrong type',
    );
    expect(() => pgValue('bytes', 'bytea')).toThrow('bytea parameter has the wrong type');
  });

  test('ships from the postgres entry and the portable wasmCloud build', () => {
    expect(pgValueFromPortable(null)).toEqual({ tag: 'null' });
    expect(pgValueFromIndex).toBe(pgValueFromPortable);
    expect(pgValueFromPortable).toBe(pgValue);
  });
});
