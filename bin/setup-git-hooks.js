const { execFileSync, spawnSync } = require('node:child_process');
const { accessSync, constants, existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const automatic = process.argv.includes('--if-unconfigured');
const checkout = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (checkout.error || checkout.status !== 0) {
  const message = 'Git guard requires Git and a repository checkout.';
  if (!automatic) throw new Error(message);
  process.stderr.write(message + '\n');
  process.exit(0);
}

const options = { cwd: checkout.stdout.trim(), encoding: 'utf8' };
const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], options);
if (result.error || (result.status !== 0 && result.status !== 1)) {
  throw result.error || new Error(result.stderr);
}
const existing = result.status === 0 ? result.stdout.trim() : null;
let message = existing !== null && existing !== '.githooks' ? `Existing hooksPath ${existing || '(empty)'}; integrate .githooks/pre-commit and .githooks/pre-rebase without replacing it.` : '';
if (existing === null) {
  const directory = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], options).trim();
  const custom = existsSync(directory) ? readdirSync(directory).filter(name => !name.endsWith('.sample')) : [];
  if (custom.length) message = `Existing Git hook files in ${directory}; integrate .githooks/pre-commit and .githooks/pre-rebase without disabling them.`;
}
if (!message) {
  for (const name of ['pre-commit', 'pre-rebase']) {
    const hook = path.join(options.cwd, '.githooks', name);
    try {
      accessSync(hook, constants.X_OK);
      if (!statSync(hook).isFile()) throw new Error('Not a file');
    } catch {
      message = `Missing or nonexecutable checked-in Git hook ${hook}; restore it before enabling hooks.`;
      break;
    }
  }
}
if (message) {
  process.stderr.write(message + '\n');
  process.exit(automatic ? 0 : 1);
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], options);
process.stdout.write('Repository Git hooks enabled.\n');
