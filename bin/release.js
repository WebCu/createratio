const { readFileSync, writeFileSync, lstatSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const versionFiles = ['package.json', 'extension/package.json', 'extension/src/manifest.json'];

function releaseVersion(tag, versions) {
  const version = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag || '')?.[1];
  if (!version || version.split('.').some(part => Number(part) > 65535) || version === '0.0.0') {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH with a valid Chrome version.');
  }
  if (!versions.length || versions.some(value => value !== version)) {
    throw new Error('Release tag and all package/manifest versions must match.');
  }
  return version;
}

function sourceVersion() {
  const versions = versionFiles.map(file => {
    if (!lstatSync(file).isFile()) throw new Error('Version files must be regular files.');
    return JSON.parse(readFileSync(file, 'utf8')).version;
  });
  return releaseVersion(`v${versions[0]}`, versions);
}

function compareVersions(left, right) {
  if (![left, right].every(value => /^\d+(?:\.\d+){0,3}$/.test(value || ''))) {
    throw new Error('Cannot compare a nonnumeric store version; inspect the store before releasing.');
  }
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function run(program, args, stdio = 'pipe') {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio, timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed. Your branch, files and tags are preserved; inspect the command before retrying.`);
  }
  return (result.stdout || '').trim();
}

function git(...args) {
  return run('git', args);
}

function requireOfficialOrigin() {
  const origin = git('config', '--get', 'remote.origin.url');
  const destinations = [origin, git('remote', 'get-url', 'origin'), ...git('remote', 'get-url', '--push', '--all', 'origin').split('\n')];
  if (!destinations.every(url => /^(?:https:\/\/github\.com\/|git@github\.com:)WebCu\/createratio(?:\.git)?$/.test(url))) {
    throw new Error('Origin must fetch and push only to the official WebCu/createratio repository.');
  }
}

function requireCurrentMain() {
  process.chdir(git('rev-parse', '--show-toplevel'));
  if (git('status', '--porcelain')) throw new Error('A clean working tree is required.');
  if (git('branch', '--show-current') !== 'main') throw new Error('Run this command on main.');
  requireOfficialOrigin();
  git('fetch', '--no-tags', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    throw new Error('Main must match origin/main. Update it without rewriting history first.');
  }
}

function prepare(increment) {
  if (!['patch', 'minor', 'major'].includes(increment)) throw new Error('Choose patch, minor, or major.');
  requireCurrentMain();
  const current = sourceVersion();
  const parts = current.split('.').map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[increment];
  parts[index]++;
  for (let lower = index + 1; lower < parts.length; lower++) parts[lower] = 0;
  const version = releaseVersion(`v${parts.join('.')}`, [parts.join('.')]);
  const branch = `release/v${version}`;
  if (git('branch', '--list', branch) || git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) {
    throw new Error('The release branch already exists; inspect its PR instead of overwriting it.');
  }
  if (git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`)) throw new Error('This release tag already exists.');
  const edits = versionFiles.map(file => {
    const text = readFileSync(file, 'utf8');
    const matches = [...text.matchAll(/("version"\s*:\s*")[^"]+("\s*[,}])/g)];
    if (matches.length !== 1) throw new Error('Each version file must contain one unambiguous version field.');
    return [file, text.replace(matches[0][0], `${matches[0][1]}${version}${matches[0][2]}`)];
  });
  run('gh', ['auth', 'status', '--hostname', 'github.com']);
  git('switch', '-c', branch);
  for (const [file, text] of edits) writeFileSync(file, text);
  run('pnpm', ['check'], 'inherit');
  git('add', '--', ...versionFiles);
  git('commit', '-m', `Release ${version}`);
  git('pull', '--rebase', '--ff-only', 'origin', 'main');
  requireOfficialOrigin();
  git('-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  const body = `## Summary\n\nPrepare version ${version} for Chrome and Firefox. All three version fields are updated together.\n\n## Evidence\n\n- pnpm check passed.\n- Store submission reruns CI and requires separate approval after the GitHub release is published.\n\n## Merge Danger\n\n**Door:** two-way\n\nMerging updates source versions only; it does not push a release tag.\n\n**Blast Radius:** releases\n\nAfter merge, run pnpm release publish from clean, current main to publish a GitHub release with generated change notes and trigger store submissions.\n`;
  process.stdout.write(run('gh', ['pr', 'create', '--repo', 'WebCu/createratio', '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body', body]) + '\n');
}

function publish() {
  requireCurrentMain();
  git('pull', '--rebase', '--ff-only', 'origin', 'main');
  const version = sourceVersion();
  const tag = `v${version}`;
  const remoteTag = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').filter(Boolean);
  const remoteCommit = remoteTag.find(line => line.endsWith(`\trefs/tags/${tag}^{}`))?.split('\t')[0];
  if (remoteTag.length && remoteCommit !== git('rev-parse', 'HEAD')) {
    throw new Error('The remote tag must be annotated and point to current main; never move a release tag.');
  }
  if (git('tag', '--list', tag)) {
    const ref = `refs/tags/${tag}`;
    if (git('cat-file', '-t', ref) !== 'tag') {
      throw new Error('The existing local release tag must be annotated; refusing to replace or publish it.');
    }
    if (git('rev-parse', `${ref}^{commit}`) !== git('rev-parse', 'HEAD')) {
      throw new Error('The local tag points to another commit; refusing to move it.');
    }
  }
  run('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (!remoteTag.length) {
    if (!git('tag', '--list', tag)) git('tag', '--annotate', tag, '--message', `Release ${version}`);
    requireOfficialOrigin();
    git('-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
  }
  try {
    process.stdout.write(run('gh', ['release', 'create', tag, '--repo', 'WebCu/createratio', '--verify-tag', '--title', `Release ${version}`, '--generate-notes']) + '\n');
  } catch {
    throw new Error('Release creation failed; the tag is preserved. Inspect the GitHub release before retrying: if published, use Actions to retry only failed store jobs; if absent, rerun this command.');
  }
  process.stdout.write(`Published ${tag} with generated change notes. Review the packages and approve each store job in GitHub Actions; store availability is separate.\n`);
}

function main() {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (command === 'prepare' && argument && !extra.length) return prepare(argument);
  if (command === 'publish' && argument === undefined && !extra.length) return publish();
  throw new Error('Use pnpm release prepare <patch|minor|major> or pnpm release publish.');
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { releaseVersion, sourceVersion, compareVersions };
