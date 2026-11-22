const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function typeCheck(t, sources) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-value-types-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = Object.entries(sources).map(([name, source]) => {
    fs.writeFileSync(path.join(directory, name), source);
    return name;
  });
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    files: ['globals.d.ts', 'messages.d.ts'].map(name => path.join(root, 'extension', 'types', name)).concat(files),
    include: []
  }));
  return spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: directory, encoding: 'utf8' });
}

test('value types accept local dates, guarded values and duration conversions', t => {
  const result = typeCheck(t, {
    'valid.js': [
      '/** @type {TimeSegment} */',
      "const segment = { date: Core.localDate(), mode: 'create', sec: Core.secondsFromMillis(1000) };",
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
      '/** @type {Millis[]} */',
      'const millis = [Core.millisFromMinutes(5), Core.millisFromSeconds(segment.sec), Core.millisFromNumber(0)];',
      '/** @type {Seconds} */',
      'const seconds = Core.secondsFromNumber(0);',
      '/** @type {Minutes[]} */',
      'const minutes = [Core.DEFAULT_SETTINGS.accessMinutes, Core.ACCESS_LIMITS.maxMinutes, Core.minutesFromMillis(60000)];',
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
      "const segment = { date: '2026-11-22', mode: 'create', sec: Core.secondsFromMillis(1000) };",
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
  assert.match(result.stdout, /invalid\.js\(4,\d+\): error TS2322: Type 'Seconds' is not assignable to type 'Millis'/);
  assert.match(result.stdout, /invalid\.js\(8,\d+\): error TS2322: Type 'string' is not assignable to type 'LocalDate'/);
  assert.match(result.stdout, /invalid\.js\(11,\d+\): error TS2322: Type 'number' is not assignable to type 'Seconds'/);
});
