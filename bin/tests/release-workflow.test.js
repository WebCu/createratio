const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-chrome.yml'), 'utf8');

function job(name) {
  const source = workflow.split(`  ${name}:\n`)[1];
  assert.ok(source, `Missing ${name} job`);
  return source.split(/^  [\w-]+:\n/m)[0];
}

function expression(source, key, context) {
  const value = source.match(new RegExp(`${key}: \\$\\{\\{ (.+) \\}\\}`))?.[1];
  assert.ok(value, `Missing ${key} expression`);
  return vm.runInNewContext(value, context, { timeout: 1000 });
}

test('manual releases offer an explicit browser choice and default to both', () => {
  const dispatch = workflow.split('  workflow_dispatch:\n')[1]?.split(/^\S/m)[0];
  assert.ok(dispatch);
  assert.match(dispatch, /browser:\n/);
  assert.match(dispatch, /required: true/);
  assert.match(dispatch, /type: choice/);
  assert.match(dispatch, /default: both/);
  assert.match(dispatch, /options:\n        - both\n        - chrome\n        - firefox/);
});

test('only selected store jobs reach their approval environments', () => {
  for (const [event, browser, expected] of [
    ['push', undefined, [true, true]],
    ['workflow_dispatch', 'both', [true, true]],
    ['workflow_dispatch', 'chrome', [true, false]],
    ['workflow_dispatch', 'firefox', [false, true]],
    ['workflow_dispatch', '', [false, false]],
    ['workflow_dispatch', 'edge', [false, false]],
    ['workflow_dispatch', undefined, [false, false]],
    ['pull_request', 'both', [false, false]]
  ]) {
    const context = { github: { event_name: event }, inputs: { browser } };
    assert.deepEqual(['submit', 'submit-firefox'].map(name => expression(job(name), 'if', context)), expected, `${event}: ${browser}`);
  }
});

test('manual and automatic release guards validate the selected tag before any store submission', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'release@example.invalid'
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const file of ['package.json', 'extension/package.json', 'extension/src/manifest.json']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), JSON.stringify({ version: '1.2.3' }));
  }
  fs.mkdirSync(path.join(directory, 'bin'));
  for (const file of ['release.js', 'chrome-store-release.js']) fs.copyFileSync(path.join(root, 'bin', file), path.join(directory, 'bin', file));
  git('init', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'Release fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', '--annotate', 'v1.2.3', '--message', 'Release fixture');
  const guard = job('validate-release');
  const run = guard.match(/        run: \|\n((?:          [^\n]*\n)+)/)?.[1];
  assert.ok(run);
  for (const [event, browser, refType, tag, succeeds] of [
    ['push', undefined, 'tag', 'v1.2.3', true],
    ['workflow_dispatch', 'both', 'tag', 'v1.2.3', true],
    ['workflow_dispatch', 'chrome', 'tag', 'v1.2.3', true],
    ['workflow_dispatch', 'firefox', 'tag', 'v1.2.3', true],
    ['workflow_dispatch', 'edge', 'tag', 'v1.2.3', false],
    ['workflow_dispatch', '', 'tag', 'v1.2.3', false],
    ['workflow_dispatch', 'chrome', 'branch', 'main', false],
    ['workflow_dispatch', 'firefox', 'tag', 'v1.2.4', false],
    ['workflow_dispatch', 'both', 'tag', 'v1.2.3;echo injected', false]
  ]) {
    const result = spawnSync('bash', ['-e', '-c', run.replace(/^ {10}/gm, '')], {
      cwd: directory, env: {
        ...env, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: tag,
        RELEASE_BROWSER: expression(guard, 'RELEASE_BROWSER', { github: { event_name: event }, inputs: { browser } })
      }, encoding: 'utf8', timeout: 5000
    });
    assert.equal(result.status === 0, succeeds, `${event}: ${browser}: ${refType}: ${tag}\n${result.stderr}`);
  }
  git('commit', '--allow-empty', '-m', 'Not merged into main');
  const unmerged = spawnSync('bash', ['-e', '-c', run.replace(/^ {10}/gm, '')], {
    cwd: directory, env: { ...env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3', RELEASE_BROWSER: 'chrome' },
    encoding: 'utf8', timeout: 5000
  });
  assert.notEqual(unmerged.status, 0);
});
