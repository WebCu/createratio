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

test('a live legacy deadline is migrated before a wait is considered', () => {
  assert.deepEqual(
    M.siteAccessFromStored({ expiresAt: now + 60000, readyAt: now + 1000, waitMs: 300000 }, now),
    session({ remainingMs: 60000, expiresAt: now + 60000 })
  );
});

const dayStart = new Date(2026, 0, 15).getTime();
const midnight = new Date(2026, 0, 16).getTime();
const refilled = now - 60000;
const facts = changes => ({
  now,
  date: today,
  dayStart,
  midnight,
  restart: false,
  enabled: true,
  goalAllowed: false,
  focused: false,
  accessMinutes: 5,
  hasRules: false,
  hasWindows: false,
  closeAll: false,
  ...changes
});
const decision = changes => ({
  rules: 'none',
  alarmAt: 0,
  expire: false,
  window: null,
  clearWindows: false,
  ...changes
});
const paused = session({ remainingMs: 300000, expiresAt: 0, refilledAt: refilled, date: today });

const cases = [
  [
    'Off site drops access and lifts blocking',
    paused,
    { enabled: false },
    decision({ state: null, rules: 'unrestricted', clearWindows: true })
  ],
  [
    'paused budget stays paused away from the site',
    paused,
    {},
    decision({ state: paused, rules: 'session', window: { start: now, end: Number.MAX_SAFE_INTEGER } })
  ],
  [
    'focused budget starts running with an expiry alarm',
    paused,
    { focused: true },
    decision({
      state: { ...paused, expiresAt: now + 300000 },
      rules: 'session',
      alarmAt: now + 300000,
      window: { start: now, end: now + 300000 }
    })
  ],
  [
    'spent running budget expires and keeps refill eligibility',
    session({ remainingMs: 1000, expiresAt: now - 1, refilledAt: refilled, date: today }),
    {},
    decision({
      state: session({ refilledAt: refilled, date: today }),
      expire: true,
      window: { start: now, end: now - 1 }
    })
  ],
  [
    'midnight refill back-dates a paused budget window to midnight',
    session({ remainingMs: 60000, expiresAt: 0, refilledAt: dayStart - 3600000, date: '2026-01-14' }),
    {},
    decision({
      state: session({ remainingMs: 300000, expiresAt: 0, refilledAt: dayStart, date: today }),
      rules: 'session',
      window: { start: dayStart, end: Number.MAX_SAFE_INTEGER }
    })
  ],
  [
    'midnight refill after restart starts the window now',
    session({ remainingMs: 60000, expiresAt: 0, refilledAt: dayStart - 3600000, date: '2026-01-14' }),
    { restart: true },
    decision({
      state: session({ remainingMs: 300000, expiresAt: 0, refilledAt: dayStart, date: today }),
      rules: 'session',
      window: { start: now, end: Number.MAX_SAFE_INTEGER }
    })
  ],
  [
    'budget running at midnight is refilled and spent by noon',
    session({ remainingMs: 60000, expiresAt: dayStart + 30000, refilledAt: dayStart - 3600000, date: '2026-01-14' }),
    {},
    decision({
      state: session({ refilledAt: dayStart, date: today }),
      expire: true,
      window: { start: dayStart, end: dayStart + 300000 }
    })
  ],
  [
    'restart keeps a running budget and restarts its clock',
    session({ remainingMs: 300000, expiresAt: now + 100000, refilledAt: refilled, date: today }),
    { restart: true, focused: true },
    decision({
      state: session({ remainingMs: 300000, expiresAt: now + 300000, refilledAt: refilled, date: today }),
      rules: 'session',
      alarmAt: now + 300000,
      window: { start: now, end: now + 300000 }
    })
  ],
  [
    'above goal without an entry grants access but stores nothing',
    null,
    { goalAllowed: true, focused: true },
    decision({ state: null, rules: 'session', window: { start: now, end: midnight } })
  ],
  [
    'above goal marks a focused budget as goal-active',
    paused,
    { goalAllowed: true, focused: true },
    decision({ state: { ...paused, goalActive: true }, rules: 'session', window: { start: now, end: midnight } })
  ],
  [
    'above goal stamps an exhausted session with a zero deadline',
    session({ refilledAt: refilled, date: today }),
    { goalAllowed: true },
    decision({
      state: session({ expiresAt: 0, refilledAt: refilled, date: today }),
      rules: 'session',
      window: { start: now, end: midnight }
    })
  ],
  [
    'legacy deadline becomes a paused budget',
    session({ remainingMs: 60000, expiresAt: now + 60000 }),
    {},
    decision({ state: session({ remainingMs: 60000, expiresAt: 0, date: today }), rules: 'session' })
  ],
  [
    'above goal keeps a pending request as a request',
    request({ readyAt: now + 30000, waitMs: 300000 }),
    { goalAllowed: true },
    decision({
      state: request({ readyAt: now + 30000, waitMs: 300000 }),
      rules: 'session',
      window: { start: now, end: midnight }
    })
  ],
  [
    'waiting request is left alone',
    request({ readyAt: now + 30000, waitMs: 300000 }),
    {},
    decision({ state: request({ readyAt: now + 30000, waitMs: 300000 }) })
  ],
  [
    'closing all expires a waiting request',
    request({ readyAt: now + 30000, waitMs: 300000 }),
    { closeAll: true },
    decision({ state: request({ readyAt: now + 30000, waitMs: 300000 }), expire: true })
  ],
  ['leftover session rules without access expire', null, { hasRules: true }, decision({ state: null, expire: true })]
];

for (const [name, state, changes, expected] of cases)
  test(`reconcile: ${name}`, () => assert.deepEqual(M.reconcileSiteAccess(state, facts(changes)), expected));

test('reconcile never mutates its input', () => {
  const input = structuredClone(paused);
  M.reconcileSiteAccess(input, facts({ focused: true }));
  assert.deepEqual(input, paused);
});

test('invalid stored session dates make the entry unreadable', () => {
  for (const date of ['not-a-date', '2026-02-30', '2026-13-01', '2026-10-1', 1, true, {}, [], null, ''])
    assert.equal(M.siteAccessFromStored({ date, remainingMs: 120000, expiresAt: 0 }, now), null, JSON.stringify(date));
});

test('invalid stored session numbers make the entry unreadable', () => {
  for (const field of ['remainingMs', 'expiresAt', 'refilledAt'])
    for (const invalid of [-1, -Infinity, Infinity, NaN, '120000', true, null, undefined, {}, []]) {
      const raw = {
        date: today,
        remainingMs: 120000,
        expiresAt: now + 120000,
        refilledAt: now - 600000,
        [field]: invalid
      };
      assert.equal(M.siteAccessFromStored(raw, now), null, `${field}: ${String(invalid)}`);
    }
});

test('malformed or too distant stored wait deadlines make the entry unreadable', () => {
  const entries = [
    ...[0, -1, -Infinity, Infinity, NaN, '1', null, undefined, true, {}, []].map(readyAt => ({ readyAt })),
    {},
    { readyAt: now + C.ACCESS_LIMITS.maxMinutes * 60000 + 1 }
  ];
  for (const raw of entries) assert.equal(M.siteAccessFromStored(raw, now), null, JSON.stringify(raw));
});

test('a stored wait keeps its deadline and falls back to one minute when its duration is invalid', () => {
  for (const waitMs of [
    undefined,
    null,
    0,
    -60000,
    60001,
    '60000',
    NaN,
    Infinity,
    (C.ACCESS_LIMITS.maxMinutes + 1) * 60000
  ]) {
    const state = M.siteAccessFromStored({ readyAt: now + 30000, ...(waitMs === undefined ? {} : { waitMs }) }, now);
    assert.equal(state.readyAt, now + 30000, String(waitMs));
    assert.equal(M.waitDuration(state), 60000, String(waitMs));
  }
});

test('a stored wait is readable up to its own validated duration and no further', () => {
  for (const waitMs of [60000, 300000, undefined, null, 0, -60000, 60001, '60000', NaN, Infinity, 241 * 60000]) {
    const duration = C.validAccessMinutes(waitMs / 60000) && typeof waitMs === 'number' ? waitMs : 60000;
    const stored = readyAt => ({ readyAt, ...(waitMs === undefined ? {} : { waitMs }) });
    assert.equal(M.siteAccessFromStored(stored(now + duration + 1), now), null, String(waitMs));
    const pending = M.siteAccessFromStored(stored(now + duration), now);
    assert.equal(pending.readyAt, now + duration, String(waitMs));
    assert.equal(M.waitDuration(pending), duration, String(waitMs));
  }
});
