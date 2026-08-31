#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fixture = require('../fixture/dist/greet.js');
const { ApiService, createService } = require('../fixture/dist/service.js');

const throwsTypeError = (run) => assert.throws(run, TypeError);

throwsTypeError(() => fixture.add('1', 2));
throwsTypeError(() => new fixture.Greeter(1));
throwsTypeError(() => new fixture.Greeter('hello').greet({ id: '1', name: 'Ada' }));
throwsTypeError(() => fixture.increment('1'));
throwsTypeError(() => fixture.unionValues(false, null, { kind: 'success', value: 1 }));
throwsTypeError(() => fixture.unionValues('ok', null, { kind: 'success', value: 'bad' }));
throwsTypeError(() => fixture.arrayValues([1, 'bad'], []));
throwsTypeError(() => fixture.tupleValues([1], ['ok', { id: 1, name: 'Ada' }], [1]));
throwsTypeError(() => fixture.optionalValues(1, null));
throwsTypeError(() =>
  fixture.intersectionValues(
    { left: 'left', shared: 1 },
    { item: { id: 1, 'x-id': 'external' } },
    { kind: 'fallback', enabled: true },
  ),
);
throwsTypeError(() =>
  fixture.intersectionValues(
    { left: 'left', right: true, shared: 'bad' },
    { item: { id: 1, 'x-id': 'external' } },
    { kind: 'fallback', enabled: true },
  ),
);
throwsTypeError(() =>
  fixture.intersectionValues(
    { left: 'left', right: true, shared: 1 },
    { item: { id: 1 } },
    { kind: 'fallback', enabled: true },
  ),
);
throwsTypeError(() =>
  fixture.intersectionValues(
    { left: 'left', right: true, shared: 1 },
    { item: { id: 1, 'x-id': 'external' } },
    { kind: 'full', count: 'bad' },
  ),
);
throwsTypeError(() => fixture.intersectionArray([{ left: 1, right: 'first' }, { left: 2 }]));
throwsTypeError(() =>
  fixture.recordValues({ fixed: 1, first: 2, second: 'bad' }, {}, { primary: 1, 'x-id': 2 }),
);
throwsTypeError(() =>
  fixture.recordValues({ fixed: 1 }, { first: 1, second: 'bad' }, { primary: 1, 'x-id': 2 }),
);
throwsTypeError(() => fixture.recordValues({ fixed: 1 }, {}, { primary: 1 }));
throwsTypeError(() => fixture.recordValues({ fixed: 1 }, {}, { primary: 1, 'x-id': 'bad' }));
throwsTypeError(() => fixture.nestedRecord({ outer: { first: 1, second: 'bad' } }));
throwsTypeError(() => fixture.rootKeyRecord({ first: 1, second: 'bad' }));
throwsTypeError(() => fixture.specialKeyRecord({ __id: 1 }));
throwsTypeError(() => fixture.specialKeyRecord({ '': 1 }));
throwsTypeError(() => fixture.specialKeyRecord({ '': 'bad', __id: 1 }));
throwsTypeError(() => fixture.specialKeyRecord({ '': 1, __id: 'bad' }));
throwsTypeError(() => fixture.recursiveValue({ value: 'bad' }));
throwsTypeError(() => fixture.sum(1, 'bad'));
throwsTypeError(() => fixture.destructuredValues({ id: 'bad', name: 'Ada' }, [1, 'ok']));
throwsTypeError(() => createService({ endpoint: '/api', retries: 'bad' }));

const service = new ApiService({ endpoint: '/api', retries: 2 });
throwsTypeError(() => service.execute({ id: 1, tags: [false] }));
throwsTypeError(() => service.execute({ id: 1, tags: [] }, 'later'));

assert.deepEqual(fixture.arrayValues([1, 2], [{ id: 1, name: 'Ada' }]).numbers, [1, 2]);
assert.deepEqual(
  fixture.intersectionValues(
    { left: 'left', right: true, shared: 1 },
    { item: { id: 1, 'x-id': undefined } },
    { kind: 'full', count: 2 },
  ).value,
  { left: 'left', right: true, shared: 1 },
);
assert.deepEqual(fixture.intersectionArray([{ left: 1, right: 'first' }]), [
  { left: 1, right: 'first' },
]);
assert.deepEqual(
  fixture.recordValues({ fixed: 1, extra: 2 }, { first: 1, second: 2 }, { primary: 1, 'x-id': 2 })
    .fixed,
  { primary: 1, 'x-id': 2 },
);
assert.deepEqual(fixture.nestedRecord({ outer: { first: 1, second: 2 } }), {
  outer: { first: 1, second: 2 },
});
assert.deepEqual(fixture.rootKeyRecord({ first: 1, second: 2 }), { first: 1, second: 2 });
assert.deepEqual(fixture.specialKeyRecord({ '': 1, __id: 2 }), { '': 1, __id: 2 });
const callable = (input) => input;
callable.label = 'callable';
assert.equal(fixture.callableIntersection(callable), callable);
class Constructable {
  static label = 'constructable';

  constructor(value) {
    this.value = value;
  }
}
assert.equal(fixture.constructableIntersection(Constructable), Constructable);
assert.deepEqual(fixture.recursiveValue({ value: 1, next: { value: 2 } }), {
  value: 1,
  next: { value: 2 },
});
assert.deepEqual(fixture.requiredRecursiveValue({ next: null }), { next: null });
assert.deepEqual(fixture.recursiveIndexValue({ nested: 1 }), { nested: 1 });
assert.deepEqual(fixture.optionalObject({ label: 1 }), { label: 1 });
assert.deepEqual(fixture.unsupportedNumberIndex({ 0: 'unchecked' }), { 0: 'unchecked' });
assert.deepEqual(fixture.unsupportedSymbolIndex({ [Symbol.iterator]: 'unchecked' }), {
  [Symbol.iterator]: 'unchecked',
});
assert.deepEqual(fixture.unsupportedRecordValues({ bad: {} }), { bad: {} });
assert.deepEqual(service.execute({ id: 1, tags: ['a'] }), [1, '/api:sync:a']);

console.log('check-runtime: ok — injected guards accept valid calls and reject invalid calls');
