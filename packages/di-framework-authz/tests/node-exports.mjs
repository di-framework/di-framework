/*
The .mjs file is a Node-only integration fixture. It verifies the exact packaging bug raised in the review:

- Imports @di-framework/authz and @di-framework/authz/http through Node’s published import exports.
- Registers a policy through the root entry point.
- Resolves it through the HTTP entry point.
- Confirms the shared registry and constructor-identity lookup work.

The accompanying .test.ts builds the packages, launches this script with node, and checks its exit code. A normal Bun test would use the "bun" source exports and could hide the duplicated-registry bug.

.mjs makes ESM execution explicit, though .js would also work because the package has "type": "module".
 */
import assert from 'node:assert/strict';
import { Allow, Policy, policyRegistry } from '@di-framework/authz';
import { ResourceAuthorization } from '@di-framework/authz/http';

policyRegistry.clear();

const First = class SameName {};
const PolicyClass = class SameName {};
Allow('read')(First.prototype, 'read');
Allow('read')(PolicyClass.prototype, 'read');
Policy('first')(First);
Policy('document')(PolicyClass);

const bindings = [];
const read = () => {};
read.path = '/documents/:id';
read.method = 'get';
read[Symbol.for('@di-framework/auth:deferred-authorization')] = (binding) => bindings.push(binding);

class Documents {}
Documents.isController = true;
Documents.read = read;
ResourceAuthorization(PolicyClass)(Documents);

assert.equal(bindings.length, 1);
assert.deepEqual(bindings[0].metadata, {
  resource: 'document',
  action: 'read',
  collection: false,
  idParam: 'id',
});
