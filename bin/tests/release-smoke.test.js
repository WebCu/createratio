const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

const script = path.resolve(__dirname, '../release-smoke.js');
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-smoke-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('release smoke refuses a non-repository before creating a test release', t => {
  const cwd = directory(t);
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git checkout/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('release smoke refuses uncommitted candidates without discarding their changes', t => {
  const cwd = directory(t);
  assert.equal(spawnSync('git', ['init'], { cwd }).status, 0);
  fs.writeFileSync(path.join(cwd, 'candidate.txt'), 'preserve');
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean working tree/);
  assert.equal(fs.readFileSync(path.join(cwd, 'candidate.txt'), 'utf8'), 'preserve');
});

test('release smoke exposes the failed stage output in CI instead of only a temporary path', t => {
  const cwd = directory(t);
  const git = args => assert.equal(spawnSync('git', args, { cwd }).status, 0);
  git(['init']); git(['config', 'user.name', 'Smoke fixture']); git(['config', 'user.email', 'smoke@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { release: 'node -e "console.error(\'smoke-stage-failure\'); process.exit(7)"' } }));
  git(['add', '.']); git(['commit', '-m', 'Failing fixture']);
  const index = path.join(cwd, '.git/index');
  const originalIndex = fs.readFileSync(index);
  const changedTime = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(cwd, 'package.json'), changedTime, changedTime);
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '', GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  const logs = result.stdout.match(/Release smoke logs: (.+)/)?.[1];
  assert.ok(logs?.startsWith(path.join(os.tmpdir(), 'createratio-release-smoke-')));
  t.after(() => fs.rmSync(logs, { recursive: true, force: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /smoke-stage-failure/);
});

test('release smoke blocks redirects before they reach a disallowed host, including explicit follow requests', async t => {
  let escaped = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `http://0.0.0.0:${server.address().port}/escaped` });
      response.end();
    } else {
      if (request.url === '/escaped') escaped++;
      response.end('local response');
    }
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cwd = directory(t);
  const git = args => assert.equal(spawnSync('git', args, { cwd }).status, 0);
  git(['init']); git(['config', 'user.name', 'Redirect fixture']); git(['config', 'user.email', 'smoke@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(cwd, 'probe.cjs'), `const assert = require('node:assert/strict');
(async () => {
  assert.equal(await (await fetch(${JSON.stringify(base + '/direct')})).text(), 'local response');
  for (const [url, options] of [
    [${JSON.stringify(base + '/redirect')}, undefined],
    [${JSON.stringify(base + '/redirect')}, {redirect: 'follow'}],
    [new Request(${JSON.stringify(base + '/redirect')}, {redirect: 'follow'}), undefined]
  ]) await assert.rejects(fetch(url, options));
  console.error('redirect-guard-passed');
  process.exit(7);
})().catch(error => { console.error(error); process.exit(1); });\n`);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { release: 'node probe.cjs' } }));
  git(['add', '.']); git(['commit', '-m', 'Redirect fixture']);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '', NO_PROXY: '*' }, timeout: 30000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  const logs = result.stdout.match(/Release smoke logs: (.+)/)?.[1];
  assert.ok(logs?.startsWith(path.join(os.tmpdir(), 'createratio-release-smoke-')));
  t.after(() => fs.rmSync(logs, { recursive: true, force: true }));
  assert.equal(escaped, 0, 'a redirect reached a host outside the loopback allowlist');
  assert.match(result.stderr, /redirect-guard-passed/);
});

test('CI runs the full release check outside the fast gate to avoid recursive verification', () => {
  const root = path.resolve(__dirname, '../..');
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
  assert.equal(scripts['check:release'], 'node bin/release-smoke.js');
  assert.doesNotMatch(scripts.check, /check:release/);
  assert.match(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'), /run: pnpm check:release/);
});

test('release smoke blocks recursion before running any nested check', t => {
  const cwd = directory(t);
  const result = spawnSync(process.execPath, [script], { cwd, env: { ...process.env, CR_RELEASE_SMOKE: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /recursively/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});
