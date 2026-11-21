'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('mutation metrics count adapter calls and attribute only extension content CPU', async () => {
  const { mutationMetrics } = await import('../hidden-mutation-profile.mjs');
  const origin = 'chrome-extension://synthetic';
  const functions = [{ functionName: 'mode', ranges: [{ startOffset: 12, count: 3 }] }, { functionName: 'action', ranges: [{ count: 9 }] }];
  const result = mutationMetrics([{ url: origin + '/sites.js', functions }, { url: 'https://x.com/sites.js', functions }], {
    nodes: [origin + '/content.js', origin + '/sites.js', origin + '/background.js', 'https://x.com/content.js'].map((url, index) => ({ id: index + 1, callFrame: { url } })),
    samples: [1, 2, 3, 4], timeDeltas: [100, 200, 300, 400]
  }, origin);
  assert.deepEqual(result, { calls: 3, modes: [{ offset: 12, calls: 3 }], contentCpuMs: 0.3 });
  assert.deepEqual(mutationMetrics([], { nodes: [] }, origin), { calls: 0, modes: [], contentCpuMs: 0 });
  assert.throws(() => mutationMetrics([], { nodes: [{ id: 1, callFrame: { url: origin + '/content.js' } }], samples: [1] }, origin), /Missing CPU sample duration/);
});
