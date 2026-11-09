const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function releaseSmoke() {
  if (process.env.CR_RELEASE_SMOKE === '1') throw new Error('Release smoke cannot run recursively inside its own checks.');
  const source = process.cwd();
  function git(...args) {
    const result = spawnSync('git', ['--no-optional-locks', ...args], { cwd: source, encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error('Release smoke requires a Git checkout.');
    return result.stdout.trim();
  }
  if (path.resolve(git('rev-parse', '--show-toplevel')) !== source) throw new Error('Run release smoke at the repository root.');
  if (git('status', '--porcelain')) throw new Error('Release smoke requires a clean working tree so it tests the committed candidate.');
  const head = git('rev-parse', 'HEAD');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-release-smoke-'));
  const project = path.join(directory, 'project');
  const remote = path.join(directory, 'origin.git');
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'release-smoke.log');
  const descriptor = fs.openSync(log, 'wx', 0o600);
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(GIT_|GH_|GITHUB_|AMO_|CWS_|GOOGLE_)/.test(name)) delete env[name];
  Object.assign(env, {
    CR_RELEASE_SMOKE: '1', CI: '1', GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Release smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Release smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid'
  });
  function run(program, args, cwd = project) {
    fs.writeSync(descriptor, `$ ${program} ${args.join(' ')}\n`);
    const result = spawnSync(program, args, { cwd, env, stdio: ['ignore', descriptor, descriptor], timeout: 300000 });
    if (result.error || result.status !== 0) throw new Error(`Release smoke failed: ${program} ${args.slice(0, 2).join(' ')}; inspect ${log}`);
  }
  function value(...args) {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error('Cannot inspect the disposable Git repository.');
    return result.stdout.trim();
  }
  console.log(`Release smoke logs: ${directory}`);
  try {
    const archive = path.join(directory, 'source.tar');
    run('git', ['archive', '--format=tar', `--output=${archive}`, head], source);
    run('tar', ['-xf', archive, '-C', project]);
    run('git', ['init', '--bare', '--initial-branch=main', remote]);
    run('git', ['init', '--initial-branch=main']);
    run('git', ['config', 'commit.gpgsign', 'false']);
    run('git', ['config', 'tag.gpgsign', 'false']);
    run('git', ['config', 'core.hooksPath', path.join(directory, 'empty-hooks')]);
    fs.appendFileSync(path.join(project, '.git/info/exclude'), '\nnode_modules\n');
    for (const folder of ['node_modules', 'site/node_modules', 'extension/node_modules']) {
      const dependency = path.join(source, folder);
      if (fs.existsSync(dependency)) fs.symlinkSync(dependency, path.join(project, folder), 'dir');
    }
    run('git', ['config', `url.file://${remote}.insteadOf`, 'https://github.com/WebCu/createratio.git']);
    run('git', ['remote', 'add', 'origin', 'https://github.com/WebCu/createratio.git']);
    run('git', ['add', '.']); run('git', ['commit', '-m', 'Release smoke candidate']);
    run('git', ['push', '--set-upstream', 'origin', 'main']);
    run('git', ['tag', '--annotate', 'v-local-only', '--message', 'Unrelated local tag']);
    run('git', ['config', 'push.followTags', 'true']);
    run('git', ['config', 'remote.origin.mirror', 'true']);
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.join(' ') === 'auth status --hostname github.com') process.exit(0);\nif (args[0] === 'pr' && args[1] === 'create') process.exit(0);\nif (args[0] === 'release' && args[1] === 'create' && args.includes('--generate-notes') && args.includes('--verify-tag')) { require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'release.json'))}, JSON.stringify(args)); process.exit(0); }\nprocess.exit(1);\n`, { mode: 0o700 });
    const transport = path.join(directory, 'transport.cjs');
    fs.writeFileSync(transport, `const cp = require('node:child_process');\nconst spawn = cp.spawnSync;\nconst nativeFetch = globalThis.fetch;\nglobalThis.fetch = async (url, options) => {\n  const host = new URL(url instanceof Request ? url.url : url).hostname;\n  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('Release smoke blocks external fetch requests.');\n  return nativeFetch(url, { ...options, redirect: 'error' });\n};\ncp.spawnSync = (program, args, options) => {\n  const result = spawn(program, args, options);\n  if (program === 'git' && args[0] === 'remote' && args[1] === 'get-url' && result.status === 0) result.stdout = result.stdout.split('\\n').map(url => url === ${JSON.stringify(`file://${remote}`)} ? 'https://github.com/WebCu/createratio.git' : url).join('\\n');\n  return result;\n};\n`);
    env.PATH = bin + path.delimiter + process.env.PATH;
    env.NODE_OPTIONS = `--require=${JSON.stringify(transport)}`;
    run('pnpm', ['release', 'prepare', 'patch']);
    const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version;
    if (value('--git-dir', remote, 'tag', '--list')) throw new Error('Preparation unexpectedly published a tag.');
    run('git', ['switch', 'main']); run('git', ['merge', '--ff-only', `release/v${version}`]);
    run('git', ['-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main']);
    run('pnpm', ['release', 'publish']);
    const release = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')));
    if (release[2] !== `v${version}`) throw new Error('Publication did not create the matching GitHub release.');
    if (value('--git-dir', remote, 'tag', '--list') !== `v${version}`) throw new Error('Publication did not select exactly its release tag.');
    if (value('--git-dir', remote, 'rev-parse', `refs/tags/v${version}^{commit}`) !== value('rev-parse', 'HEAD')) throw new Error('The published tag has the wrong commit.');
    env.GITHUB_REF_NAME = `v${version}`; env.GITHUB_SHA = value('rev-parse', `refs/tags/v${version}`);
    run(process.execPath, ['bin/package-release.js']);
    for (const line of fs.readFileSync(path.join(project, 'dist/SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [expected, file] = line.split('  ');
      if (createHash('sha256').update(fs.readFileSync(path.join(project, 'dist', file))).digest('hex') !== expected) throw new Error('Release archive checksum mismatch.');
    }
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ source: head, version, status: 'passed', fetchPolicy: 'loopback-only' }, null, 2) + '\n', { mode: 0o600 });
    console.log('PASS real version preparation/checks, local merge/tag publication, simulated GitHub release creation and archive checksums; no store requests.');
  } catch (error) {
    console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-50).join('\n'));
    throw error;
  } finally { fs.closeSync(descriptor); }
}

try { releaseSmoke(); } catch (error) { console.error(error.message); process.exitCode = 1; }
