import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSubmission, getOrCreateSubmission } from '../../public/generation.mjs';

test('request retry reuses the same id and body until form version changes', () => {
  const state = {};
  const first = getOrCreateSubmission(state, 1, ' https://example.com/a ', 'voice', 'auto', 'recommended', 'standard', '11111111-1111-4111-8111-111111111111');
  const retry = getOrCreateSubmission(state, 1, 'https://example.com/a', 'voice', 'auto', 'recommended', 'standard');
  assert.equal(retry, first);
  assert.equal(retry.id, '11111111-1111-4111-8111-111111111111');
  const changed = getOrCreateSubmission(state, 2, 'https://example.com/b', 'voice', 2, 'bright', 'wide', '22222222-2222-4222-8222-222222222222');
  assert.notEqual(changed.id, retry.id);
  assert.deepEqual(changed, { id: '22222222-2222-4222-8222-222222222222', url: 'https://example.com/b', voice: 'voice', key: 2, preset: 'bright', mix_preset: 'wide' });
});

test('submission trims URL and keeps explicit options in API body', () => {
  assert.deepEqual(makeSubmission(' https://example.com ', 'voice', 'auto', 'recommended', 'standard', 'id'), {
    id: 'id', url: 'https://example.com', voice: 'voice', key: 'auto', preset: 'recommended', mix_preset: 'standard',
  });
});
