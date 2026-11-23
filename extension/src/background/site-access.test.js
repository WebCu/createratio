'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const M = require('./site-access.js');

const now = new Date(2026, 0, 15, 12).getTime();
const today = '2026-01-15';
const session = fields => ({
  phase: 'session',
  remainingMs: null,
  expiresAt: null,
  refilledAt: null,
  date: null,
  goalActive: false,
  ...fields
});
const request = fields => ({ phase: 'request', waitMs: null, ...fields });

test('unreadable or invalid stored entries have no site access', () => {
  const invalid = [
    undefined,
    null,
    'x',
    [],
    {},
    { readyAt: 0 },
    { remainingMs: -1 },
    { refilledAt: NaN },
    { date: '2026-02-30', remainingMs: 1 },
    { remainingMs: C.millisecondsFromMinutes(C.asMinutes(241)) },
    { expiresAt: now + C.millisecondsFromMinutes(C.asMinutes(241)) },
    { readyAt: now + 3600000, waitMs: 60000 }
  ];
  for (const raw of invalid) assert.equal(M.siteAccessFromStored(raw, now), null, JSON.stringify(raw));
});

test('stored waits become access requests', () => {
  assert.deepEqual(
    M.siteAccessFromStored({ readyAt: now + 30000, waitMs: 300000 }, now),
    request({ readyAt: now + 30000, waitMs: 300000 })
  );
  assert.deepEqual(M.siteAccessFromStored({ readyAt: now + 30000 }, now), request({ readyAt: now + 30000 }));
  assert.deepEqual(
    M.siteAccessFromStored({ readyAt: now + 30000, waitMs: '60000' }, now),
    request({ readyAt: now + 30000 })
  );
});

test('stored budgets become access sessions, including exhausted and legacy-deadline sessions', () => {
  assert.deepEqual(
    M.siteAccessFromStored({ refilledAt: now - 600000, date: today }, now),
    session({ refilledAt: now - 600000, date: today })
  );
  assert.deepEqual(
    M.siteAccessFromStored({ expiresAt: now + 60000 }, now),
    session({ remainingMs: 60000, expiresAt: now + 60000 })
  );
  assert.deepEqual(
    M.siteAccessFromStored({ expiresAt: now - 1 }, now),
    session({ remainingMs: 0, expiresAt: now - 1 })
  );
  assert.deepEqual(
    M.siteAccessFromStored({ remainingMs: 1000, readyAt: now + 30000 }, now),
    session({ remainingMs: 1000 })
  );
});

test('every shape the extension writes survives a round trip unchanged', () => {
  const shapes = [
    { readyAt: now + 30000, waitMs: 300000 },
    { readyAt: now + 30000 },
    { remainingMs: 120000, expiresAt: 0, refilledAt: 0, date: today },
    { remainingMs: 300000, expiresAt: now + 1000, refilledAt: now - 1000, date: today, goalActive: true },
    { date: today, refilledAt: now - 600000 },
    { refilledAt: now - 600000, date: today, expiresAt: 0, remainingMs: 0 }
  ];
  for (const raw of shapes) assert.deepEqual(M.storedFromSiteAccess(M.siteAccessFromStored(raw, now)), raw);
  assert.deepEqual(
    M.siteAccessFromStored({ refilledAt: now - 600000, date: today, expiresAt: 0 }, now),
    session({ remainingMs: 0, expiresAt: 0, refilledAt: now - 600000, date: today })
  );
  assert.equal(M.storedFromSiteAccess(null), undefined);
  assert.deepEqual(M.storedFromSiteAccess(session({})), {});
});

test('wait duration falls back to one minute for missing or invalid stored durations', () => {
  assert.equal(M.waitDuration(request({ readyAt: now, waitMs: 300000 })), 300000);
  assert.equal(M.waitDuration(request({ readyAt: now })), 60000);
});

test('stored entries compare by content, not key order', () => {
  assert.equal(M.sameStoredEntry({ remainingMs: 1, date: today }, { date: today, remainingMs: 1 }), true);
  assert.equal(M.sameStoredEntry(undefined, undefined), true);
  assert.equal(M.sameStoredEntry(undefined, {}), false);
  assert.equal(M.sameStoredEntry({ expiresAt: 0 }, {}), false);
  assert.equal(M.sameStoredEntry({ refilledAt: 0 }, { refilledAt: 1 }), false);
});

test('a request starts only when no request or budget is open', () => {
  const open = session({ remainingMs: 300000, expiresAt: 0, refilledAt: now });
  const waiting = request({ readyAt: now + 1000, waitMs: 300000 });
  assert.deepEqual(M.requestAccess(null, 300000, now), request({ readyAt: now + 300000, waitMs: 300000 }));
  assert.equal(M.requestAccess(open, 300000, now), open);
  assert.equal(M.requestAccess(waiting, 300000, now), waiting);
  assert.deepEqual(
    M.requestAccess(session({ refilledAt: now - 1, date: today }), 300000, now),
    request({ readyAt: now + 300000, waitMs: 300000 })
  );
});

test('cancelling removes only a request', () => {
  const open = session({ remainingMs: 1000 });
  assert.equal(M.cancelRequest(request({ readyAt: now })), null);
  assert.equal(M.cancelRequest(open), open);
  assert.equal(M.cancelRequest(null), null);
});

test('confirming after the wait starts a full session; anything else is not ready', () => {
  assert.deepEqual(M.confirmRequest(request({ readyAt: now }), 5, now), {
    ready: true,
    state: session({ remainingMs: 300000, expiresAt: 0, refilledAt: now })
  });
  assert.deepEqual(M.storedFromSiteAccess(M.confirmRequest(request({ readyAt: now }), 5, now).state), {
    remainingMs: 300000,
    expiresAt: 0,
    refilledAt: now
  });
  for (const state of [request({ readyAt: now + 1 }), null, session({ refilledAt: now, date: today })])
    assert.deepEqual(M.confirmRequest(state, 5, now), { ready: false });
});

test('a valid wait with leftover session fields stays a request', () => {
  const expected = request({ readyAt: now + 30000, waitMs: 300000 });
  assert.deepEqual(M.siteAccessFromStored({ readyAt: now + 30000, waitMs: 300000, expiresAt: 0 }, now), expected);
  assert.deepEqual(
    M.siteAccessFromStored({ readyAt: now + 30000, waitMs: 300000, expiresAt: 0, remainingMs: 0 }, now),
    expected
  );
});
