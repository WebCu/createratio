const { test } = require('node:test');
const assert = require('node:assert/strict');
const { typeCheck } = require('./type-probe.js');

test('value types accept local dates, guarded values and duration conversions', t => {
  const result = typeCheck(t, {
    'valid.js': [
      '/** @type {TimeSegment} */',
      "const segment = { date: Core.localDate(), mode: 'create', sec: Core.secondsFromMilliseconds(Core.asMilliseconds(1000)) };",
      '/** @param {unknown} value */',
      'function guarded(value) {',
      '  if (Core.validLocalDate(value)) {',
      '    /** @type {SiteActionEntry} */',
      "    const action = { date: value, action: 'posts' };",
      '  }',
      '  if (Core.validAccessMinutes(value)) {',
      '    /** @type {Minutes} */',
      '    const minutes = value;',
      '  }',
      '}',
      '/** @type {Milliseconds[]} */',
      'const milliseconds = [Core.millisecondsFromMinutes(Core.asMinutes(5)), Core.asMilliseconds(0)];',
      '/** @type {Seconds[]} */',
      'const seconds = [Core.asSeconds(0), Core.secondsFromMinutes(Core.DEFAULT_SETTINGS.waitMinutes)];',
      '/** @type {Minutes[]} */',
      'const minutes = [Core.DEFAULT_SETTINGS.accessMinutes, Core.ACCESS_LIMITS.maxMinutes, Core.minutesFromMilliseconds(Core.asMilliseconds(60000)), Core.minutesFromSeconds(segment.sec)];',
      '/** @type {{ date: LocalDate, sec: Seconds }[]} */',
      'const parts = Core.splitInterval(Core.asEpochTime(0), Core.asEpochTime(1000));',
      ''
    ].join('\n')
  });
  assert.equal(result.status, 0, result.stdout);
});

test('value types reject raw dates, unguarded values and mixed duration units', t => {
  const result = typeCheck(t, {
    'invalid.js': [
      '/** @type {TimeSegment} */',
      "const segment = { date: '2026-11-22', mode: 'create', sec: Core.secondsFromMilliseconds(Core.asMilliseconds(1000)) };",
      '/** @param {AccessStatus} status */',
      'function mixed(status) { status.remainingMs = status.waitSeconds; }',
      '/** @param {string} value */',
      'function unguarded(value) {',
      '  /** @type {LocalDate} */',
      '  const date = value;',
      '}',
      '/** @type {Seconds} */',
      'const seconds = 1;',
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout,
    /invalid\.js\(2,\d+\): error TS2322: Type 'string' is not assignable to type 'LocalDate'/
  );
  assert.match(
    result.stdout,
    /invalid\.js\(4,\d+\): error TS2322: Type 'Seconds' is not assignable to type 'Milliseconds'/
  );
  assert.match(
    result.stdout,
    /invalid\.js\(8,\d+\): error TS2322: Type 'string' is not assignable to type 'LocalDate'/
  );
  assert.match(result.stdout, /invalid\.js\(11,\d+\): error TS2322: Type 'number' is not assignable to type 'Seconds'/);
});

test('access minutes enter only through the guard and still count as minutes', t => {
  const accepted = typeCheck(t, {
    'accepted.js': [
      '/** @param {unknown} value */',
      'function guarded(value) {',
      '  if (!Core.validAccessMinutes(value)) return;',
      '  /** @type {AccessMinutes} */',
      '  const preference = value;',
      '  /** @type {Minutes} */',
      '  const minutes = preference;',
      '}',
      '/** @type {AccessMinutes[]} */',
      'const preferences = [Core.DEFAULT_SETTINGS.accessMinutes, Core.DEFAULT_SETTINGS.waitMinutes, Core.ACCESS_LIMITS.minMinutes, Core.ACCESS_LIMITS.maxMinutes];',
      ''
    ].join('\n')
  });
  assert.equal(accepted.status, 0, accepted.stdout);
  const rejected = typeCheck(t, {
    'rejected.js': [
      '/** @type {AccessMinutes} */',
      'const fromMinutes = Core.minutesFromMilliseconds(Core.asMilliseconds(90000));',
      '/** @type {AccessMinutes} */',
      'const fromNumber = 5;',
      '/** @type {AccessMinutes} */',
      'const fromCast = Core.asMinutes(5);',
      ''
    ].join('\n')
  });
  assert.notEqual(rejected.status, 0);
  for (const [line, source] of [
    [2, 'Minutes'],
    [4, 'number'],
    [6, 'Minutes']
  ])
    assert.match(
      rejected.stdout,
      new RegExp(
        `rejected\\.js\\(${line},\\d+\\): error TS2322: Type '${source}' is not assignable to type 'AccessMinutes'`
      )
    );
});

test('access sessions start only from access minutes', t => {
  const result = typeCheck(t, {
    'sessions.js': [
      'const now = Core.asEpochTime(Date.now());',
      'const minutes = Core.minutesFromMilliseconds(Core.asMilliseconds(90000));',
      'SiteAccessModel.confirmRequest(null, minutes, now);',
      '/** @param {AccessStatus} status */',
      'function session(status) { status.sessionMinutes = minutes; }',
      '/** @param {Parameters<typeof SiteAccessModel.reconcileSiteAccess>[1]} facts */',
      'function refill(facts) { facts.accessMinutes = minutes; }',
      'SiteAccessModel.confirmRequest(null, Core.DEFAULT_SETTINGS.accessMinutes, now);',
      '/** @param {ReplyAccess} reply */',
      'function fromReply(reply) { SiteAccessModel.confirmRequest(null, reply.sessionMinutes, now); }',
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  for (const line of [3, 5, 7, 10])
    assert.match(
      result.stdout,
      new RegExp(`sessions\\.js\\(${line},\\d+\\): error TS\\d+: .*'Minutes' is not assignable to .*'AccessMinutes'`)
    );
  assert.doesNotMatch(result.stdout, /sessions\.js\(8,/);
});

test('clock types accept same-clock arithmetic and explicit clock conversion', t => {
  const result = typeCheck(t, {
    'clocks.js': [
      'const epochNow = Core.asEpochTime(Date.now());',
      'const pageNow = Core.asPageTime(performance.now());',
      '/** @type {EpochTime} */',
      'const later = Core.timeAfter(epochNow, Core.asMilliseconds(1000));',
      '/** @type {PageTime} */',
      'const pageLater = Core.timeAfter(pageNow, Core.asMilliseconds(1000));',
      '/** @type {Milliseconds[]} */',
      'const gaps = [Core.millisecondsBetween(epochNow, later), Core.millisecondsBetween(pageNow, pageLater)];',
      'const pageOrigin = Core.pageOriginFromClocks(epochNow, pageNow);',
      '/** @type {EpochTime} */',
      'const converted = Core.epochTimeFromPageTime(pageLater, pageOrigin);',
      '/** @type {EpochTime[]} */',
      'const sentinels = [Core.asEpochTime(0), Core.asEpochTime(Number.MAX_SAFE_INTEGER)];',
      ''
    ].join('\n')
  });
  assert.equal(result.status, 0, result.stdout);
});

test('clock types reject mixed clocks, durations and raw numbers', t => {
  const result = typeCheck(t, {
    'mixed.js': [
      'const epochNow = Core.asEpochTime(Date.now());',
      'const pageNow = Core.asPageTime(performance.now());',
      '/** @type {EpochTime} */',
      'const fromPage = pageNow;',
      '/** @type {EpochTime} */',
      'const fromNumber = 1;',
      '/** @type {EpochTime} */',
      'const fromDuration = Core.asMilliseconds(1);',
      'Core.millisecondsBetween(epochNow, pageNow);',
      'Core.timeAfter(epochNow, 1000);',
      'Core.epochTimeFromPageTime(epochNow, epochNow);',
      '/** @type {EpochTime} */',
      'const pageResult = Core.timeAfter(pageNow, Core.asMilliseconds(1));',
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  for (const [line, pattern] of [
    [4, "Type 'PageTime' is not assignable to type 'EpochTime'"],
    [6, "Type 'number' is not assignable to type 'EpochTime'"],
    [8, "Type 'Milliseconds' is not assignable to type 'EpochTime'"],
    [9, "Argument of type 'PageTime' is not assignable to parameter of type 'EpochTime'"],
    [10, "Argument of type 'number' is not assignable to parameter of type 'Milliseconds'"],
    [11, "Argument of type 'EpochTime' is not assignable to parameter of type 'PageTime'"],
    [13, "Type 'PageTime' is not assignable to type 'EpochTime'"]
  ])
    assert.match(result.stdout, new RegExp(`mixed\\.js\\(${line},\\d+\\): error TS\\d+: ${pattern}`));
});

test('access and history records require epoch times', t => {
  const result = typeCheck(t, {
    'records.js': [
      '/** @param {AccessStatus} status */',
      'function pageClock(status) { status.expiresAt = Core.asPageTime(performance.now()); }',
      '/** @param {AccessStatus} status */',
      'function rawReady(status) { status.readyAt = 1; }',
      '/** @type {SavedIntention} */',
      "const intention = { site: 'x', reason: 'r', requestedAt: 1 };",
      '/** @type {SiteActionEntry} */',
      "const action = { date: Core.localDate(), action: 'posts', at: Core.asPageTime(performance.now()) };",
      'SiteAccessModel.requestAccess(null, Core.asMilliseconds(1), 1);',
      'SiteAccessModel.confirmRequest(null, Core.DEFAULT_SETTINGS.accessMinutes, Core.asPageTime(performance.now()));',
      '/** @type {TimeSegment} */',
      "const segment = { date: Core.localDate(), mode: 'create', sec: Core.asSeconds(1), start: Core.asPageTime(performance.now()) };",
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  for (const [line, source] of [
    [2, 'PageTime'],
    [4, 'number'],
    [6, 'number'],
    [8, 'PageTime'],
    [9, 'number'],
    [10, 'PageTime'],
    [12, 'PageTime']
  ])
    assert.match(
      result.stdout,
      new RegExp(
        `records\\.js\\(${line},\\d+\\): error TS\\d+: .*'${source}' is not assignable to (parameter of )?type 'EpochTime'`
      )
    );
});

test('tracker helpers keep page time and epoch time on their own side', t => {
  const accepted = typeCheck(t, {
    'helpers.js': [
      'const pageNow = Core.asPageTime(performance.now());',
      "Core.activeMilliseconds({ start: pageNow, end: pageNow, lastInput: pageNow, visible: true, focused: true, mode: 'create' });",
      'Core.splitInterval(Core.asEpochTime(Date.now()), Core.asEpochTime(Date.now()));',
      '/** @type {Milliseconds} */',
      'const duration = Core.millisecondsFromSeconds(Core.asSeconds(1));',
      ''
    ].join('\n')
  });
  assert.equal(accepted.status, 0, accepted.stdout);
  const rejected = typeCheck(t, {
    'helpers.js': [
      'const epochNow = Core.asEpochTime(Date.now());',
      "Core.activeMilliseconds({ start: epochNow, end: epochNow, lastInput: epochNow, visible: true, focused: true, mode: 'create' });",
      'Core.splitInterval(Core.asPageTime(performance.now()), Core.asPageTime(performance.now()));',
      'Core.millisecondsFromSeconds(Core.asMilliseconds(1));',
      ''
    ].join('\n')
  });
  assert.notEqual(rejected.status, 0);
  for (const [line, pattern] of [
    [2, "Type 'EpochTime' is not assignable to type 'PageTime'"],
    [3, "Argument of type 'PageTime' is not assignable to parameter of type 'EpochTime'"],
    [4, "Argument of type 'Milliseconds' is not assignable to parameter of type 'Seconds'"]
  ])
    assert.match(rejected.stdout, new RegExp(`helpers\\.js\\(${line},\\d+\\): error TS\\d+: ${pattern}`));
});

test('duration converters reject mismatched source units and raw numbers', t => {
  const result = typeCheck(t, {
    'converters.js': [
      'const seconds = Core.asSeconds(1);',
      'const milliseconds = Core.asMilliseconds(1000);',
      'Core.millisecondsFromMinutes(seconds);',
      'Core.minutesFromSeconds(milliseconds);',
      'Core.secondsFromMilliseconds(seconds);',
      'Core.minutesFromMilliseconds(seconds);',
      'Core.secondsFromMinutes(seconds);',
      'Core.millisecondsFromMinutes(1);',
      'Core.minutesFromSeconds(1);',
      'Core.secondsFromMilliseconds(1);',
      'Core.minutesFromMilliseconds(1);',
      'Core.secondsFromMinutes(1);',
      "Core.asMilliseconds('1000');",
      'Core.asSeconds({});',
      'Core.asMinutes(true);',
      ''
    ].join('\n')
  });
  assert.notEqual(result.status, 0);
  for (const [line, source, target] of [
    [3, 'Seconds', 'Minutes'],
    [4, 'Milliseconds', 'Seconds'],
    [5, 'Seconds', 'Milliseconds'],
    [6, 'Seconds', 'Milliseconds'],
    [7, 'Seconds', 'Minutes'],
    [8, 'number', 'Minutes'],
    [9, 'number', 'Seconds'],
    [10, 'number', 'Milliseconds'],
    [11, 'number', 'Milliseconds'],
    [12, 'number', 'Minutes'],
    [13, 'string', 'number'],
    [14, '{}', 'number'],
    [15, 'boolean', 'number']
  ])
    assert.match(
      result.stdout,
      new RegExp(
        `converters\\.js\\(${line},\\d+\\): error TS2345: Argument of type '${source}' is not assignable to parameter of type '${target}'`
      )
    );
});
