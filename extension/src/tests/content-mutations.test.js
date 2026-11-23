'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const integrations = require('../../sites/index.js');
const { tracker } = require('./content-harness.js');

for (const inactive of ['hidden', 'pagehide'])
  test(`mutation batches skip classification while ${inactive} and resume on return`, async () => {
    let calls = 0,
      mutate;
    const timers = [];
    const integration = integrations.get('x');
    const t = await tracker('chrome', {
      integration: {
        ...integration,
        create(context) {
          const adapter = integration.create(context);
          return {
            ...adapter,
            mode() {
              calls++;
              return adapter.mode();
            }
          };
        }
      },
      observeMutations(fn) {
        mutate = fn;
      },
      scheduleTimeout(fn) {
        timers.push(fn);
      }
    });
    const batches = () => {
      for (let i = 0; i < 10; i++) {
        mutate([]);
        while (timers.length) timers.shift()();
      }
    };
    if (inactive === 'hidden') t.visible(false);
    else t.event('pagehide', { persisted: true });
    await new Promise(resolve => setImmediate(resolve));
    calls = 0;
    batches();
    assert.equal(calls, 0, 'inactive mutations must not classify');
    if (inactive === 'hidden') t.visible(true);
    else t.event('pageshow', { persisted: true });
    assert.ok(calls > 0, 'return boundary must reclassify');
    await new Promise(resolve => setImmediate(resolve));
    calls = 0;
    batches();
    assert.equal(calls, 10, 'visible mutation batches must still classify');
  });
