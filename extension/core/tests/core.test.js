'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

test('classifies consuming routes, including profiles and SPA query strings', () => {
  for (const url of ['https://x.com/home', 'https://x.com/explore/', 'https://x.com/search?q=js', 'https://x.com/someone', 'https://x.com/someone/with_replies', 'https://x.com/someone/status/42', 'https://www.linkedin.com/feed/', 'https://www.linkedin.com/in/someone/', 'https://www.linkedin.com/company/acme/posts/']) assert.equal(C.classifyPage({ url }), 'consume', url);
});
test('creation overrides feed and profile routes when composer state matches', () => {
  for (const url of ['https://x.com/compose/post', 'https://x.com/compose/tweet', 'https://x.com/compose/anything']) assert.equal(C.classifyPage({ url }), 'create');
  assert.equal(C.classifyPage({ url: 'https://x.com/home', xComposerOpen: true }), 'create');
  assert.equal(C.classifyPage({ url: 'https://x.com/person/status/42', xComposerOpen: true }), 'create');
  assert.equal(C.classifyPage({ url: 'https://www.linkedin.com/feed/', linkedinEditorFocused: true }), 'create');
});
test('empty home composer, own profiles and unsupported pages are neutral or consume', () => {
  assert.equal(C.classifyPage({ url: 'https://x.com/home', xComposerOpen: false }), 'consume');
  assert.equal(C.classifyPage({ url: 'https://www.linkedin.com/feed/', linkedinEditorFocused: false }), 'consume');
  assert.equal(C.classifyPage({ url: 'https://x.com/ME/media', ownProfilePath: '/me' }), 'neutral');
  assert.equal(C.classifyPage({ url: 'https://www.linkedin.com/in/me/details/', ownProfilePath: '/in/me' }), 'neutral');
  for (const url of ['https://x.com.evil.test/home', 'https://example.com/home', 'invalid']) assert.equal(C.classifyPage({ url, xComposerOpen: true, linkedinEditorFocused: true }), 'neutral');
  for (const url of ['https://x.com/messages', 'https://x.com/settings/profile', 'https://x.com/notifications', 'https://x.com/i/bookmarks', 'https://www.linkedin.com/messaging/', 'https://www.linkedin.com/jobs/']) assert.equal(C.classifyPage({ url }), 'neutral');
});
test('score implements the exact formula; light actions and quote subtype add no bonus', () => {
  assert.equal(C.score(C.emptyStats()), 0);
  assert.equal(C.score({ consumeSec: 600, createSec: 120, posts: 1, replies: 2, comments: 1 }), 1);
  assert.equal(C.score({ consumeSec: 0, createSec: 60 }), 60);
  assert.equal(C.score({ consumeSec: 100, likes: 1000, bookmarks: 1000, reposts: 1000, quotes: 1 }), 0);
  assert.equal(C.score({ consumeSec: 120, posts: 1, quotes: 1 }), 1);
  assert.equal(C.score({ consumeSec: -10, createSec: NaN }), 0);
});
test('stats snapshots retain only known nonnegative numbers without coercion or mutation', () => {
  const saved = { consumeSec: 12.5, createSec: '10', posts: 2, replies: -1, comments: NaN, likes: Infinity, bookmarks: null, quotes: true, reposts: 0.5, unknown: 50 };
  const original = { ...saved };
  assert.deepEqual(C.statsSnapshot(saved), { consumeSec: 12.5, createSec: 0, posts: 2, replies: 0, comments: 0, likes: 0, bookmarks: 0, quotes: 0, reposts: 0.5 });
  for (const value of [undefined, null, {}, 'invalid', 12, false]) assert.deepEqual(C.statsSnapshot(value), { consumeSec: 0, createSec: 0, posts: 0, replies: 0, comments: 0, likes: 0, bookmarks: 0, quotes: 0, reposts: 0 });
  assert.deepEqual(saved, original);
  const snapshot = C.statsSnapshot(saved);
  snapshot.posts = 10;
  assert.equal(saved.posts, 2);
});

test('score aggregates both sites before dividing and uses exact badge thresholds', () => {
  const total = C.aggregate({ x: { consumeSec: 240, posts: 1 }, linkedin: { consumeSec: 120, comments: 1, createSec: 60 } });
  assert.equal(C.score(total), 300 / 360);
  assert.equal(C.scoreColor(0.4999), '#be3f43'); assert.equal(C.scoreColor(0.5), '#b77900');
  assert.equal(C.scoreColor(0.9999), '#b77900'); assert.equal(C.scoreColor(1), '#16804a');
  assert.equal(C.badgeText(100), '99+');
});
test('daily target resolves the current setting with safe defaults for legacy or invalid preferences', () => {
  assert.equal(C.dailyTarget(), 1);
  assert.equal(C.dailyTarget({}), 1);
  for (const dailyTarget of [0.1, 0.5, 1, 2.5, 100]) {
    assert.equal(C.validDailyTarget(dailyTarget), true);
    assert.equal(C.dailyTarget({ dailyTarget }), dailyTarget);
  }
  for (const dailyTarget of [undefined, null, '2', 0, -1, 0.05, 2.55, 101, NaN, Infinity]) {
    assert.equal(C.validDailyTarget(dailyTarget), false);
    assert.equal(C.dailyTarget({ dailyTarget }), 1);
  }
});

test('scroll friction defaults on without replacing saved choices or resistance', () => {
  for (const settings of [undefined, {}, { accessMinutes: 12 }]) {
    assert.equal(C.settingsSnapshot(settings).scrollFrictionEnabled, true);
    assert.equal(C.settingsSnapshot(settings).scrollFrictionStrength, 50);
  }
  for (const enabled of [false, true]) for (const strength of [50, 75, 90, 95]) {
    const settings = { scrollFrictionEnabled: enabled, scrollFrictionStrength: strength };
    for (const resolved of [C.settingsSnapshot(settings), C.updatePreferences(settings, { accessMinutes: 12 })]) {
      assert.equal(resolved.scrollFrictionEnabled, enabled);
      assert.equal(resolved.scrollFrictionStrength, strength);
    }
    assert.deepEqual(settings, { scrollFrictionEnabled: enabled, scrollFrictionStrength: strength });
  }
});
test('saved zero resistance resolves to Off without mutating preferences', () => {
  for (const enabled of [undefined, false, true]) {
    const settings = { scrollFrictionEnabled: enabled, scrollFrictionStrength: 0 };
    for (const saved of [settings, C.updatePreferences(settings, { accessMinutes: 12 })]) {
      const resolved = C.settingsSnapshot(saved);
      assert.equal(resolved.scrollFrictionEnabled, false); assert.equal(resolved.scrollFrictionStrength, 50);
    }
    assert.deepEqual(settings, { scrollFrictionEnabled: enabled, scrollFrictionStrength: 0 });
  }
});
test('saved strengths below the new minimum resolve to 50% without enabling an Off choice', () => {
  for (const enabled of [false, true]) for (const strength of [5, 25, 45]) {
    const settings = { scrollFrictionEnabled: enabled, scrollFrictionStrength: strength };
    const resolved = C.settingsSnapshot(settings);
    assert.equal(resolved.scrollFrictionEnabled, enabled); assert.equal(resolved.scrollFrictionStrength, 50);
    assert.deepEqual(settings, { scrollFrictionEnabled: enabled, scrollFrictionStrength: strength });
  }
});
test('scroll resistance accepts only 50–95% in five-point steps', () => {
  assert.equal(C.settingsSnapshot({ scrollFrictionEnabled: true }).scrollFrictionStrength, 50);
  for (const strength of [50, 55, 75, 90, 95]) {
    assert.equal(C.validScrollFrictionStrength(strength), true);
    assert.equal(C.settingsSnapshot({ scrollFrictionStrength: strength }).scrollFrictionStrength, strength);
  }
  for (const strength of [undefined, null, false, true, '75', 0, -5, 5, 25, 45, 49, 96, 99, 100, 1, 50.5, NaN, Infinity, [], {}]) {
    assert.equal(C.validScrollFrictionStrength(strength), false);
    assert.equal(C.settingsSnapshot({ scrollFrictionStrength: strength }).scrollFrictionStrength, 50);
  }
});
test('access minutes require a numeric whole number within the access limits', () => {
  assert.deepEqual(C.ACCESS_LIMITS, { minMinutes: 1, maxMinutes: 240 });
  for (const value of [1, 5, 120, 240]) assert.equal(C.validAccessMinutes(value), true);
  for (const value of [undefined, null, true, false, '5', '', 0, -1, 1.5, 241, NaN, Infinity, {}, [], new Number(5)]) assert.equal(C.validAccessMinutes(value), false);
});

test('intentions use trimmed minimum length and raw maximum length without coercion', () => {
  assert.deepEqual(C.INTENTION_LIMITS, { minLength: 20, maxLength: 280 });
  for (const value of ['a'.repeat(20), 'a'.repeat(280), `  ${'a'.repeat(20)}  `]) assert.equal(C.validIntention(value), true);
  for (const value of ['a'.repeat(19), ' '.repeat(20), ` ${'a'.repeat(19)}`, 'a'.repeat(281), `${'a'.repeat(20)}${' '.repeat(261)}`, undefined, null, 123, {}, [], new String('a'.repeat(20))]) assert.equal(C.validIntention(value), false);
});

test('delivery policy exposes bounded batches, seconds, identifiers and receipts', () => {
  assert.deepEqual(C.DELIVERY_LIMITS, { maxPackets: 64, maxItems: 64, maxSeconds: 3600, maxIdLength: 100, receiptLimit: 512 });
});

test('active time clips exactly at 30 seconds and never backfills after new input', () => {
  const state = { start: 28000, end: 33000, lastInput: 0, visible: true, focused: true, mode: 'consume' };
  assert.equal(C.activeMillis(state), 2000);
  assert.equal(C.activeMillis({ ...state, start: 33000, end: 38000 }), 0);
  assert.equal(C.activeMillis({ ...state, lastInput: 32000 }), 1000);
  assert.equal(C.activeMillis({ ...state, lastInput: -Infinity }), 0);
  for (const change of [{ visible: false }, { focused: false }, { mode: 'neutral' }, { end: 60000 }, { end: 27000 }]) assert.equal(C.activeMillis({ ...state, ...change }), 0);
});
test('local dates require an exact calendar day including leap years and years below 100', () => {
  for (const value of ['2026-10-11', '2024-02-29', '2000-02-29', '0099-01-01', '0000-02-29', '2026-12-31']) assert.equal(C.validLocalDate(value), true, value);
  for (const value of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-01-00', '2026-01-32', '2026-1-01', '2026-01-1', '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01\n', 'invalid', undefined, null, 20260101, {}, new Date(2026, 0, 1)]) assert.equal(C.validLocalDate(value), false);
});

test('local date buckets split a tick across local midnight without losing time', () => {
  const start = new Date(2026, 9, 11, 23, 59, 58).getTime();
  assert.deepEqual(C.splitInterval(start, start + 5000), [{ date: '2026-10-11', sec: 2 }, { date: '2026-10-12', sec: 3 }]);
  assert.deepEqual(C.recentDates(3, new Date(2026, 0, 1, 10)), ['2025-12-30', '2025-12-31', '2026-01-01']);
});
test('settings snapshots omit retired nudges without changing saved preferences', () => {
  const settings = { accessMinutes: 12, nudgeEnabled: true, nudgeMinutes: 1, trackedSites: [], siteOverrides: { x: { accessMinutes: 2, nudgeEnabled: true, nudgeMinutes: 1 }, linkedin: { nudgeEnabled: true } } };
  const snapshot = C.settingsSnapshot(settings);
  assert.deepEqual(snapshot, { ...C.DEFAULT_SETTINGS, accessMinutes: 12, trackedSites: [], siteOverrides: { x: { accessMinutes: 2 } } });
  assert.equal(settings.nudgeEnabled, true); assert.equal(settings.siteOverrides.x.nudgeEnabled, true); assert.deepEqual(settings.siteOverrides.linkedin, { nudgeEnabled: true });
  assert.equal(C.DEFAULT_SETTINGS.nudgeEnabled, undefined); assert.equal(C.shouldNudge, undefined);
});
test('restored access minutes fall back consistently without changing saved values', () => {
  for (const accessMinutes of [undefined, null, '12', false, 0, -1, 1.5, 241, NaN, Infinity]) {
    const saved = { accessMinutes, trackedSites: [], unknown: 'keep', nudgeEnabled: true };
    const original = { ...saved };
    const snapshot = C.settingsSnapshot(saved);
    assert.equal(snapshot.accessMinutes, 5);
    assert.equal(C.siteSettings('x', saved).accessMinutes, 5);
    assert.equal(snapshot.unknown, 'keep');
    assert.deepEqual(snapshot.trackedSites, []);
    assert.equal(snapshot.nudgeEnabled, undefined);
    assert.deepEqual(saved, original);
  }
  for (const accessMinutes of [1, 12, 240]) {
    assert.equal(C.settingsSnapshot({ accessMinutes }).accessMinutes, accessMinutes);
    assert.equal(C.siteSettings('x', { accessMinutes }).accessMinutes, accessMinutes);
  }
});

test('restored boolean preferences accept only booleans and default missing or malformed values', () => {
  for (const key of ['allowAboveGoal', 'intentionHistoryEnabled']) {
    for (const value of [undefined, null, 'false', 'true', 0, 1, [], {}]) {
      const saved = { [key]: value };
      assert.equal(C.settingsSnapshot(saved)[key], false);
      assert.equal(C.siteSettings('x', saved)[key], false);
      assert.equal(saved[key], value);
    }
    for (const value of [false, true]) assert.equal(C.settingsSnapshot({ [key]: value })[key], value);
    assert.equal(C.settingsSnapshot({})[key], false);
  }
});

test('settings snapshots and daily target resolve the same restored target', () => {
  for (const dailyTarget of [undefined, null, '2', true, 0, -1, 0.05, 2.55, 101, NaN, Infinity]) {
    const saved = { dailyTarget };
    assert.equal(C.settingsSnapshot(saved).dailyTarget, 1);
    assert.equal(C.siteSettings('x', saved).dailyTarget, 1);
    assert.equal(C.dailyTarget(saved), 1);
    assert.deepEqual(saved, { dailyTarget });
  }
  for (const dailyTarget of [0.1, 1, 2.5, 100]) assert.equal(C.settingsSnapshot({ dailyTarget }).dailyTarget, dailyTarget);
});

test('malformed site access limits inherit Default while unknown and retired preferences survive', () => {
  for (const accessMinutes of [undefined, null, '2', false, 0, -1, 1.5, 241, NaN, Infinity]) {
    const saved = { accessMinutes: 12, siteOverrides: { x: { accessMinutes, unknown: 'keep', nudgeMinutes: 1 }, retired: { accessMinutes: 30, unknown: true } } };
    const original = structuredClone(saved);
    const snapshot = C.settingsSnapshot(saved);
    assert.deepEqual(snapshot.siteOverrides, { x: { unknown: 'keep' }, retired: { accessMinutes: 30, unknown: true } });
    assert.equal(C.siteSettings('x', saved).accessMinutes, 12);
    assert.equal(C.siteSettings('x', snapshot).accessMinutes, 12);
    assert.equal(C.siteSettings('retired', saved).accessMinutes, 30);
    assert.equal(C.siteSettings('x', { ...saved, accessMinutes: 'bad' }).accessMinutes, 5);
    assert.deepEqual(saved, original);
  }
  for (const accessMinutes of [1, 2, 240]) assert.equal(C.siteSettings('x', { accessMinutes: 12, siteOverrides: { x: { accessMinutes } } }).accessMinutes, accessMinutes);
});

test('malformed override containers and entries cannot manufacture preferences', () => {
  for (const siteOverrides of [null, 'invalid', 12, false, [], [{ accessMinutes: 2 }]]) {
    const saved = { accessMinutes: 12, siteOverrides };
    assert.deepEqual(C.settingsSnapshot(saved).siteOverrides, {});
    assert.equal(C.siteSettings('x', saved).accessMinutes, 12);
    assert.equal(saved.siteOverrides, siteOverrides);
  }
  const saved = { accessMinutes: 12, unknown: { mode: 'keep' }, siteOverrides: { x: 'bad', linkedin: [2], retired: { accessMinutes: 30, future: { mode: 'keep' } }, other: null, empty: {}, nudgeOnly: { nudgeEnabled: true } } };
  const original = structuredClone(saved);
  assert.deepEqual(C.settingsSnapshot(saved).siteOverrides, { retired: { accessMinutes: 30, future: { mode: 'keep' } } });
  assert.deepEqual(C.settingsSnapshot(saved).unknown, { mode: 'keep' });
  assert.equal(C.siteSettings('x', saved).accessMinutes, 12);
  assert.deepEqual(saved, original);
});

test('missing or malformed restored settings resolve defaults without fabricated fields', () => {
  for (const saved of [undefined, null, 'bad', 12, false, [], ['bad']]) {
    assert.deepEqual(C.settingsSnapshot(saved), C.DEFAULT_SETTINGS);
    assert.deepEqual(C.siteSettings('x', saved), C.DEFAULT_SETTINGS);
    assert.equal(C.dailyTarget(saved), 1);
  }
});

test('normalized settings copy valid tracking arrays and site overrides without changing saved choices', () => {
  const saved = { trackedSites: ['x', 'retired'], siteOverrides: { x: { accessMinutes: 2, unknown: 'keep' } } };
  const original = structuredClone(saved);
  const snapshot = C.settingsSnapshot(saved);
  assert.deepEqual(snapshot.trackedSites, ['x', 'retired']);
  assert.notEqual(snapshot.trackedSites, saved.trackedSites);
  snapshot.trackedSites.push('linkedin');
  snapshot.siteOverrides.x.accessMinutes = 30;
  assert.deepEqual(saved, original);
  assert.notEqual(C.settingsSnapshot().trackedSites, C.DEFAULT_SETTINGS.trackedSites);
  assert.deepEqual(C.settingsSnapshot({ trackedSites: [] }).trackedSites, []);
});

test('site access limits inherit Default and reset without changing creation tracking', () => {
  const original = { accessMinutes: 12, trackedSites: [] };
  assert.equal(C.siteSettings('x', original).accessMinutes, 12); assert.equal(C.siteSettings('x').accessMinutes, 5);
  let settings = C.updatePreferences(original, { accessMinutes: 2 }, 'x');
  assert.equal(C.siteSettings('x', settings).accessMinutes, 2); assert.equal(C.siteSettings('linkedin', settings).accessMinutes, 12);
  settings = C.updatePreferences(settings, { accessMinutes: 30 });
  assert.equal(C.siteSettings('x', settings).accessMinutes, 2); assert.equal(C.siteSettings('linkedin', settings).accessMinutes, 30);
  settings = C.updatePreferences(settings, { accessMinutes: null }, 'x');
  assert.equal(C.siteSettings('x', settings).accessMinutes, 30); assert.deepEqual(settings.siteOverrides, {}); assert.deepEqual(settings.trackedSites, []);
  assert.equal(original.accessMinutes, 12); assert.equal(original.siteOverrides, undefined);
});
test('preference updates reject unsupported keys and invalid values without mutating settings', () => {
  const settings = { siteOverrides: { x: { accessMinutes: 2 } } };
  for (const changes of [{ accessMinutes: 0 }, { accessMinutes: 241 }, { accessMinutes: 1.5 }, { nudgeEnabled: 'false' }, { nudgeMinutes: undefined }, { trackedSites: null }]) {
    assert.throws(() => C.updatePreferences(settings, changes, 'x'));
  }
  assert.throws(() => C.updatePreferences(settings, { accessMinutes: null }));
  assert.deepEqual(settings, { siteOverrides: { x: { accessMinutes: 2 } } });
});
test('preference updates reject malformed changes and accept only valid minutes or per-site reset', () => {
  const saved = { accessMinutes: 12, trackedSites: [], unknown: 'keep', siteOverrides: { x: { accessMinutes: 2 }, retired: { accessMinutes: 30 } } };
  const original = structuredClone(saved);
  for (const changes of [undefined, null, '', 0, false, true, [], [2]]) {
    assert.throws(() => C.updatePreferences(saved, changes));
    assert.throws(() => C.updatePreferences(saved, changes, 'x'));
  }
  for (const accessMinutes of [undefined, null, '5', true, false, 0, 1.5, 241, NaN, Infinity, {}]) {
    assert.throws(() => C.updatePreferences(saved, { accessMinutes }));
    if (accessMinutes !== null) assert.throws(() => C.updatePreferences(saved, { accessMinutes }, 'x'));
  }
  for (const accessMinutes of [1, 240]) {
    assert.equal(C.siteSettings('linkedin', C.updatePreferences(saved, { accessMinutes })).accessMinutes, accessMinutes);
    assert.equal(C.siteSettings('x', C.updatePreferences(saved, { accessMinutes }, 'x')).accessMinutes, accessMinutes);
  }
  const reset = C.updatePreferences(saved, { accessMinutes: null }, 'x');
  assert.equal(C.siteSettings('x', reset).accessMinutes, 12);
  assert.equal(reset.unknown, 'keep');
  assert.deepEqual(reset.siteOverrides, { retired: { accessMinutes: 30 } });
  assert.throws(() => C.updatePreferences(saved, { accessMinutes: null }, 'retired'), /vetted website/);
  assert.deepEqual(saved, original);
});

test('preference updates copy restored settings without erasing unrelated saved data', () => {
  for (const siteOverrides of [null, 'bad', [], { x: 'bad', retired: { accessMinutes: 30, nudgeEnabled: true, unknown: 'keep' } }]) {
    const saved = { accessMinutes: 'bad', nudgeEnabled: true, unknown: 'keep', trackedSites: [], siteOverrides };
    const original = structuredClone(saved);
    const updated = C.updatePreferences(saved, { accessMinutes: 2 }, 'x');
    assert.deepEqual(updated.siteOverrides.x, { accessMinutes: 2 });
    assert.equal(updated.accessMinutes, 'bad');
    assert.equal(updated.nudgeEnabled, true);
    assert.equal(updated.unknown, 'keep');
    assert.equal(C.siteSettings('linkedin', updated).accessMinutes, 5);
    assert.equal(C.siteSettings('x', updated).accessMinutes, 2);
    if (siteOverrides?.retired) assert.deepEqual(updated.siteOverrides.retired, { accessMinutes: 30, nudgeEnabled: true, unknown: 'keep' });
    else assert.deepEqual(updated.siteOverrides, { x: { accessMinutes: 2 } });
    assert.deepEqual(saved, original);
  }
  assert.equal(C.siteSettings('x', C.updatePreferences(null, { accessMinutes: 2 }, 'x')).accessMinutes, 2);
});

test('retired nudge preferences cannot be changed or used as site access limits', () => {
  const stored = { accessMinutes: 12, nudgeEnabled: true, nudgeMinutes: 1, siteOverrides: { x: { nudgeEnabled: true, nudgeMinutes: 1 } } };
  for (const changes of [{ nudgeEnabled: true }, { nudgeMinutes: 1 }, { nudgeEnabled: null }]) assert.throws(() => C.updatePreferences(stored, changes, 'x'), /Unsupported preference/);
  const settings = C.siteSettings('x', stored);
  assert.equal(settings.accessMinutes, 12); assert.equal(settings.nudgeEnabled, undefined); assert.deepEqual(settings.siteOverrides, {});
});
test('CSV exports all date buckets and both sites, excluding internal keys', () => {
  const output = C.csv({ settings: C.DEFAULT_SETTINGS, _receipts: ['abc'], '2026-10-11': { x: { consumeSec: 120, posts: 1, quotes: 1 } }, '2026-10-10': {} });
  const lines = output.trim().split('\r\n'); assert.equal(lines.length, 5);
  assert.match(lines[1], /^2026-10-10,x,/); assert.match(lines[3], /^2026-10-11,x,120\.000,0\.000,1,/);
  assert.match(lines[3], /,1\.000$/); assert.ok(!output.includes('settings')); assert.ok(!output.includes('abc'));
});
test('tracking defaults enable X and LinkedIn and an empty selection disables all sites', () => {
  assert.deepEqual(C.DEFAULT_SETTINGS.trackedSites, ['x', 'linkedin']);
  for (const { id } of C.SITES) {
    assert.equal(C.trackingEnabled(id), ['x', 'linkedin'].includes(id));
    assert.equal(C.trackingEnabled(id, { nudgeEnabled: true }), ['x', 'linkedin'].includes(id));
    assert.equal(C.trackingEnabled(id, { trackedSites: [] }), false);
  }
  assert.equal(C.trackingEnabled('x', { trackedSites: ['linkedin'] }), false);
  assert.equal(C.trackingEnabled('linkedin', { trackedSites: ['linkedin'] }), true);
  assert.equal(C.trackingEnabled('unvetted'), false);
});
test('malformed saved tracking selections recover to Off without changing missing-preference defaults', () => {
  for (const trackedSites of [null, 'prefix-x-suffix', 'x', {}, { x: true }, true, false, 0, 1]) {
    const saved = { trackedSites, accessMinutes: 12, unknown: 'keep' };
    const original = structuredClone(saved);
    const snapshot = C.settingsSnapshot(saved);
    assert.deepEqual(snapshot.trackedSites, []);
    for (const { id } of C.SITES) {
      assert.equal(C.trackingEnabled(id, saved), false);
      assert.equal(C.trackingEnabled(id, snapshot), false);
    }
    assert.equal(snapshot.accessMinutes, 12);
    assert.equal(snapshot.unknown, 'keep');
    assert.deepEqual(saved, original);
  }
  assert.deepEqual(C.settingsSnapshot().trackedSites, ['x', 'linkedin']);
  assert.deepEqual(C.settingsSnapshot({ accessMinutes: 12 }).trackedSites, ['x', 'linkedin']);
  assert.deepEqual(C.settingsSnapshot({ trackedSites: undefined }).trackedSites, ['x', 'linkedin']);
  assert.equal(C.trackingEnabled('x', { trackedSites: undefined }), true);
});
test('default activation follows module declarations without treating familiar IDs specially', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const sites = [{ id: 'x', defaultEnabled: false }, { id: 'linkedin', defaultEnabled: false }, { id: 'example', defaultEnabled: true }, { id: 'reading' }];
  const context = vm.createContext({ C3Sites: { sites } });
  vm.runInContext(fs.readFileSync(require.resolve('../core.js'), 'utf8'), context);
  assert.deepEqual(Array.from(context.C3.DEFAULT_SETTINGS.trackedSites), ['example']);
  assert.equal(context.C3.trackingEnabled('x'), false);
  assert.equal(context.C3.trackingEnabled('example'), true);
  assert.equal(context.C3.trackingEnabled('reading'), false);
  assert.equal(context.C3.trackingEnabled('x', { trackedSites: ['x'] }), true);
});

test('newly available integrations stay disabled until selected', () => {
  C.SITES.push({ id: 'example' });
  try {
    assert.equal(C.trackingEnabled('example'), false);
    assert.equal(C.trackingEnabled('example', { trackedSites: ['example'] }), true);
  } finally {
    C.SITES.pop();
  }
});
test('vetted catalog uses unique stable IDs, exact hosts and supported action fields', () => {
  assert.equal(new Set(C.SITES.map(site => site.id)).size, C.SITES.length);
  const hosts = C.SITES.flatMap(site => site.hosts);
  assert.equal(new Set(hosts).size, hosts.length);
  for (const site of C.SITES) {
    for (const host of site.hosts) {
      assert.equal(C.siteForURL(`https://${host}/`), site.id);
      assert.equal(C.siteForURL(`https://${host}.evil.test/`), null);
      assert.equal(C.siteForURL(`http://${host}/`), null);
    }
    assert.ok(site.actions.every(action => C.FIELDS.includes(action) && !action.endsWith('Sec')));
  }
});
test('disabling tracking does not hide historical totals or CSV rows', () => {
  const day = { x: { consumeSec: 120, posts: 1 }, linkedin: { createSec: 60 } };
  const settings = { ...C.DEFAULT_SETTINGS, trackedSites: [] };
  assert.equal(C.aggregate(day).consumeSec, 120);
  const output = C.csv({ settings, '2026-10-11': day });
  assert.match(output, /2026-10-11,x,120\.000/);
  assert.match(output, /2026-10-11,linkedin,0\.000,60\.000/);
});
test('retired integrations remain visible in history and export without accepting new collection', () => {
  const day = { x: { consumeSec: 60 }, retired: { consumeSec: 120, posts: 1 } };
  assert.equal(C.aggregate(day).consumeSec, 180);
  assert.equal(C.aggregate(day).posts, 1);
  assert.equal(C.trackingEnabled('retired', { trackedSites: ['retired'] }), false);
  assert.equal(C.siteForURL('https://retired.test/feed'), null);
  assert.match(C.csv({ '2026-10-11': day }), /2026-10-11,retired,120\.000,0\.000,1,/);
});
test('historical site IDs cannot inject CSV formulas or additional columns', () => {
  const day = { retired: { consumeSec: 10 }, '=formula': { consumeSec: 1000 }, 'bad,id': { consumeSec: 1000 } };
  assert.deepEqual(C.recordedSites(day), ['retired']);
  assert.equal(C.aggregate(day).consumeSec, 10);
  assert.ok(!C.csv({ '2026-10-11': day }).includes('formula'));
});
