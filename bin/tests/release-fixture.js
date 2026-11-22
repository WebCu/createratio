'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../release.js');
const files = ['package.json', 'extension/package.json', 'extension/src/manifest.json'];

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'checkout');
  const remote = path.join(directory, 'origin.git');
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'commands.jsonl');
  for (const folder of [checkout, bin]) fs.mkdirSync(folder, { recursive: true });
  const transport = path.join(directory, 'git-transport.cjs');
  fs.writeFileSync(transport, `const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = (program, args, options) => {
  const result = spawnSync(program, args, options);
  if (program === 'git' && args[0] === 'remote' && args[1] === 'get-url' && result.status === 0) {
    result.stdout = result.stdout.split('\\n').map(url => url === ${JSON.stringify(`file://${remote}`)} ? 'https://github.com/WebCu/createratio.git' : url).join('\\n');
  }
  return result;
};\n`);
  const env = {
    ...process.env, NODE_OPTIONS: `--require=${transport}`, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'release@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'release@example.invalid',
    CLI_LOG: log
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: checkout, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(directory, 'empty-hooks'));
  git('config', `url.file://${remote}.insteadOf`, 'https://github.com/WebCu/createratio.git');
  git('remote', 'add', 'origin', 'https://github.com/WebCu/createratio.git');
  assert.equal(git('remote', 'get-url', '--push', 'origin'), `file://${remote}`);
  fs.mkdirSync(path.join(checkout, 'extension/src'), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(checkout, file), '{\n  "version": "0.0.1",\n  "description": "keep formatting"\n}\n');
  git('add', '.');
  git('commit', '-m', 'Initial fixture');
  git('push', '--set-upstream', 'origin', 'main');
  for (const tool of ['gh', 'pnpm']) fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLI_LOG, JSON.stringify({tool: ${JSON.stringify(tool)}, args}) + '\\n');
if (${JSON.stringify(tool)} === 'gh' && args[0] === 'auth' && process.env.FAIL_AUTH) process.exit(1);
if (${JSON.stringify(tool)} === 'pnpm' && process.env.FAIL_CHECK) { console.error('Synthetic check failure'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/WebCu/createratio/pull/123');
if (args[0] === 'release' && args[1] === 'create') {
  if (process.env.FAIL_RELEASE || fs.existsSync(process.env.CLI_LOG + '.release')) process.exit(1);
  fs.writeFileSync(process.env.CLI_LOG + '.release', JSON.stringify(args));
  console.log('https://github.com/WebCu/createratio/releases/tag/' + args[2]);
}
`, { mode: 0o755 });
  return {
    checkout, remote, env, git,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    run: (args, overrides = {}) => spawnSync(process.execPath, [script, ...args], {
      cwd: checkout, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000
    })
  };
}

module.exports = { files, repository };
