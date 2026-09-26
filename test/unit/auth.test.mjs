import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, constantTimeEqual } from '../../worker/auth.mjs';

const req = headers => new Request('https://muu.test/api/tracks/x', { method: 'DELETE', headers });

test('constant time equal', () => {
  assert.ok(constantTimeEqual('abc', 'abc'));
  assert.ok(!constantTimeEqual('abc', 'abd'));
  assert.ok(!constantTimeEqual('abc', 'abcd'));
});

test('authorize', () => {
  assert.equal(authorize(req({}), '').status, 503);
  assert.equal(authorize(req({}), 'pw').status, 401);
  assert.equal(authorize(req({ authorization: 'Bearer nope' }), 'pw').status, 401);
  assert.equal(authorize(req({ authorization: 'Bearer pw', 'sec-fetch-site': 'cross-site' }), 'pw').status, 403);
  assert.ok(authorize(req({ authorization: 'Bearer pw', 'sec-fetch-site': 'same-origin' }), 'pw').ok);
  assert.ok(authorize(req({ authorization: 'Bearer pw' }), 'pw').ok);
});
