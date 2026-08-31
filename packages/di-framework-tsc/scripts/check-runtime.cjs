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
throwsTypeError(() => fixture.sum(1, 'bad'));
throwsTypeError(() => fixture.destructuredValues({ id: 'bad', name: 'Ada' }, [1, 'ok']));
throwsTypeError(() => createService({ endpoint: '/api', retries: 'bad' }));

const service = new ApiService({ endpoint: '/api', retries: 2 });
throwsTypeError(() => service.execute({ id: 1, tags: [false] }));
throwsTypeError(() => service.execute({ id: 1, tags: [] }, 'later'));

assert.deepEqual(fixture.arrayValues([1, 2], [{ id: 1, name: 'Ada' }]).numbers, [1, 2]);
assert.deepEqual(service.execute({ id: 1, tags: ['a'] }), [1, '/api:sync:a']);

console.log('check-runtime: ok — injected guards accept valid calls and reject invalid calls');
