'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('../tests/ui-harness.js');

for (const name of ['settings', 'dashboard', 'popup', 'blocked']) {
  test(`${name}: pending updates use storage notifications, require consent and expose save failures`, async () => {
    const p = page(name); await p.ready();
    assert.equal(p.nodes['update-notice'].hidden, true);
    p.change({ _pendingUpdate: { newValue: '0.0.5' } });
    assert.equal(p.nodes['update-notice'].hidden, false);
    const before = p.messages.length;
    p.state.confirm = false; await p.nodes['update-apply'].fire('click');
    assert.equal(p.messages.length, before);
    p.state.confirm = true; await p.nodes['update-apply'].fire('click');
    assert.equal(p.messages.at(-1).type, 'update-apply');
    assert.match(p.nodes['update-status'].textContent, /could not finish saving/);
    assert.equal(p.nodes['update-apply'].disabled, false);
    p.change({ _pendingUpdate: { oldValue: '0.0.5' } });
    assert.equal(p.nodes['update-notice'].hidden, true);
  });
}
