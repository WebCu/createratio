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
      'const parts = Core.splitInterval(0, 1000);',
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
  assert.match(result.stdout, /invalid\.js\(2,\d+\): error TS2322: Type 'string' is not assignable to type 'LocalDate'/);
  assert.match(result.stdout, /invalid\.js\(4,\d+\): error TS2322: Type 'Seconds' is not assignable to type 'Milliseconds'/);
  assert.match(result.stdout, /invalid\.js\(8,\d+\): error TS2322: Type 'string' is not assignable to type 'LocalDate'/);
  assert.match(result.stdout, /invalid\.js\(11,\d+\): error TS2322: Type 'number' is not assignable to type 'Seconds'/);
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
  ]) assert.match(result.stdout, new RegExp(`converters\\.js\\(${line},\\d+\\): error TS2345: Argument of type '${source}' is not assignable to parameter of type '${target}'`));
});
