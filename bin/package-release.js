const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { releaseVersion, sourceVersion } = require('./release.js');

function packageRelease() {
  if (process.argv.length !== 2) throw new Error('Use node bin/package-release.js without arguments.');
  process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
    throw new Error('Commit tracked source changes before packaging a release.');
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (process.env.GITHUB_SHA) {
    let selected;
    try {
      if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA)) throw new Error();
      selected = execFileSync('git', ['rev-parse', '--verify', `${process.env.GITHUB_SHA}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { throw new Error('Cannot resolve the selected release commit.'); }
    if (selected !== commit) throw new Error('Release commit does not match the checked-out source.');
  }
  const version = releaseVersion(process.env.GITHUB_REF_NAME, [sourceVersion()]);
  const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'LICENSE', '.node-version', 'docs/firefox-add-ons.md', 'extension'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const sourceFiles = tracked.filter(file => {
    if (['LICENSE', '.node-version', 'docs/firefox-add-ons.md', 'extension/build.js', 'extension/package.json'].includes(file)) return true;
    return /^extension\/(?:src|core|sites)\//.test(file) &&
      /\.(?:js|json|html|css|png|svg|md|txt)$/.test(file) &&
      file.split('/').every(part => !part.startsWith('.') && part !== 'node_modules');
  });
  for (const required of ['LICENSE', 'extension/build.js', 'extension/src/manifest.json', 'docs/firefox-add-ons.md']) {
    if (!sourceFiles.includes(required)) throw new Error('The committed reviewer source is incomplete.');
  }
  const dist = path.resolve('dist');
  fs.mkdirSync(dist, { recursive: true });
  const archives = ['createratio-chrome.zip', 'createratio-firefox.zip', 'createratio-source.zip'];
  for (const archive of archives) fs.rmSync(path.join(dist, archive), { force: true });
  execFileSync(process.execPath, ['extension/build.js', 'chrome', 'firefox'], { timeout: 60000 });
  for (const browser of ['chrome', 'firefox']) {
    const directory = path.join(dist, browser);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    releaseVersion(process.env.GITHUB_REF_NAME, [manifest.version]);
    execFileSync('zip', ['-q', '-X', '-r', path.join(dist, `createratio-${browser}.zip`), '.'], { cwd: directory, timeout: 60000 });
  }
  execFileSync('git', ['archive', '--format=zip', `--output=${path.join(dist, 'createratio-source.zip')}`, 'HEAD', ...sourceFiles], { timeout: 60000 });
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), archives.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex')}  ${file}\n`).join(''));
  fs.writeFileSync(path.join(dist, 'release.txt'), `Tag: v${version}\nCommit: ${commit}\n`);
  process.stdout.write(`Packaged Chrome, Firefox and reviewer source for v${version} at ${commit}.\n`);
}

try { packageRelease(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
