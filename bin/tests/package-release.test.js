const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'bin/package-release.js');

function command(program, args, cwd, env = process.env) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function files(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix)).flatMap(name => {
    const relative = path.join(prefix, name);
    return fs.statSync(path.join(directory, relative)).isDirectory() ? files(directory, relative) : [relative];
  }).sort();
}

test('release packages contain only browser bundles and source reproduces the exact Firefox files', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['package.json', 'LICENSE', '.node-version', 'extension/package.json', 'extension/build.js', 'bin/package-release.js', 'bin/release.js']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  for (const folder of ['extension/src', 'extension/core', 'extension/sites']) fs.cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true });
  fs.mkdirSync(path.join(directory, 'docs'));
  fs.writeFileSync(path.join(directory, 'docs/firefox-add-ons.md'), 'Build: node extension/build.js firefox\n');
  for (const file of ['.env', 'extension/src/.env', 'extension/src/.env.json', 'extension/src/private.pem']) {
    fs.writeFileSync(path.join(directory, file), 'synthetic credential must not ship');
  }
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Package fixture', GIT_AUTHOR_EMAIL: 'package@example.invalid',
    GIT_COMMITTER_NAME: 'Package fixture', GIT_COMMITTER_EMAIL: 'package@example.invalid'
  };
  for (const file of ['package.json', 'extension/package.json', 'extension/src/manifest.json']) {
    const target = path.join(directory, file);
    const metadata = JSON.parse(fs.readFileSync(target, 'utf8'));
    metadata.version = '7.8.9';
    fs.writeFileSync(target, JSON.stringify(metadata, null, 2) + '\n');
  }
  const testEnv = { ...env };
  delete testEnv.NODE_TEST_CONTEXT;
  const buildTests = spawnSync(process.execPath, ['--test', 'extension/src/tests/build.test.js'], { cwd: directory, env: testEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(buildTests.status, 0, buildTests.stdout + buildTests.stderr);
  command('git', ['init', '--initial-branch=main'], directory, env);
  command('git', ['config', 'commit.gpgsign', 'false'], directory, env);
  command('git', ['add', '.'], directory, env);
  command('git', ['commit', '-m', 'Package fixture'], directory, env);
  const commit = command('git', ['rev-parse', 'HEAD'], directory, env);
  fs.writeFileSync(path.join(directory, 'extension/src/untracked.js'), 'untracked source must not ship');
  fs.mkdirSync(path.join(directory, 'dist/chrome'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'dist/createratio-firefox.zip'), 'stale archive must be replaced');
  fs.writeFileSync(path.join(directory, 'dist/chrome/stale.txt'), 'stale asset must not ship');
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version;
  command('git', ['tag', '--annotate', `v${version}`, '--message', 'Annotated release fixture'], directory, env);
  const tagObject = command('git', ['rev-parse', `v${version}`], directory, env);
  assert.notEqual(tagObject, commit);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-chrome.yml'), 'utf8');
  const packagingRun = workflow.match(/run: \|\n(          node bin\/package-release\.js\n(?:          [^\n]*\n)*)/)?.[1];
  assert.ok(packagingRun);
  const summary = path.join(directory, 'step-summary.md');
  const result = spawnSync('bash', ['-e', '-c', packagingRun.replace(/^ {10}/gm, '')], {
    cwd: directory, env: {
      ...env, GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: tagObject, GITHUB_STEP_SUMMARY: summary,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'WebCu/createratio'
    }, encoding: 'utf8', timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.readFileSync(summary, 'utf8').includes(`https://github.com/WebCu/createratio/blob/${commit}/docs/testing.md#store-integration-acceptance`));
  const dist = path.join(directory, 'dist');
  const checksums = fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(checksums.length, 3);
  for (const line of checksums) {
    const [expected, name] = line.split('  ');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex'), expected);
  }
  for (const browser of ['chrome', 'firefox']) {
    const zip = path.join(dist, `createratio-${browser}.zip`);
    const manifest = JSON.parse(command('unzip', ['-p', zip, 'manifest.json'], directory));
    assert.equal(manifest.version, version);
    const names = command('unzip', ['-Z1', zip], directory).split('\n');
    assert.ok(names.includes('manifest.json'));
    assert.ok(!names.includes('stale.txt'));
    assert.ok(names.every(name => !/(?:\.env|\.test\.js|^site\/|^node_modules\/|_metadata)/.test(name)));
  }
  const source = path.join(dist, 'createratio-source.zip');
  const sourceNames = command('unzip', ['-Z1', source], directory).split('\n');
  assert.ok(sourceNames.includes('extension/build.js'));
  assert.ok(sourceNames.includes('docs/firefox-add-ons.md'));
  assert.ok(sourceNames.every(name => !/(?:\.env|private\.pem|untracked\.js|^\.git\/|^site\/|^dist\/)/.test(name)));
  const rebuilt = path.join(directory, 'rebuilt');
  fs.mkdirSync(rebuilt);
  command('unzip', ['-q', source, '-d', rebuilt], directory);
  command(process.execPath, ['extension/build.js', 'firefox'], rebuilt);
  const original = path.join(dist, 'firefox');
  const candidate = path.join(rebuilt, 'dist/firefox');
  assert.deepEqual(files(candidate), files(original));
  for (const file of files(original)) assert.deepEqual(fs.readFileSync(path.join(candidate, file)), fs.readFileSync(path.join(original, file)), file);
  assert.match(fs.readFileSync(path.join(dist, 'release.txt'), 'utf8'), new RegExp(commit));
  for (const override of [{ GITHUB_SHA: 'a'.repeat(40) }, { GITHUB_REF_NAME: 'v65535.0.0' }]) {
    const failed = spawnSync(process.execPath, [script], {
      cwd: directory, env: { ...env, GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: commit, ...override }, encoding: 'utf8', timeout: 10000
    });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8').trim(), checksums.join('\n'));
  }
  fs.appendFileSync(path.join(directory, 'extension/src/manifest.json'), '\n');
  const dirty = spawnSync(process.execPath, [script], {
    cwd: directory, env: { ...env, GITHUB_REF_NAME: `v${version}`, GITHUB_SHA: commit }, encoding: 'utf8', timeout: 10000
  });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /Commit tracked source changes/);
});
