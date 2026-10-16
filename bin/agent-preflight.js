const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function executable(name, env) {
  const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, name + extension.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function compatible(version, range) {
  const actual = /^v?(\d+)\.\d+\.\d+$/.exec(version);
  const required = /^(\d+)\.x$/.exec(range);
  return Boolean(actual && required && actual[1] === required[1]);
}

function highConflict(file) {
  return /^(?:\.github|\.githooks|\.pi|bin)\//.test(file)
    || /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.node-version|\.nvmrc|\.npmrc|\.tool-versions)$/.test(file)
    || /^(?:AGENTS|CLAUDE|CONTRIBUTING|CODING_STANDARDS|GLOSSARY)\.md$/.test(file)
    || /^docs\/(?:testing|dependencies)\.md$/.test(file)
    || /(?:^|\/)(?:[^/]*harness|test-support|test-helpers)\.[cm]?js$/.test(file)
    || /^(?:docker-compose.*\.ya?ml|Dockerfile.*)$/.test(file);
}

function upstreamReport(git, fetch, errors, warnings) {
  const revision = reference => {
    const result = git('rev-parse', '--verify', reference);
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const beforeFetch = revision('refs/remotes/origin/main');
  let refreshed = false;
  if (fetch) {
    const result = git('fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/main:refs/remotes/origin/main');
    refreshed = result.status === 0;
    if (!refreshed) errors.push('Requested fetch of origin/main failed. Check origin access and connectivity, then rerun --fetch.');
  }
  const current = revision('refs/remotes/origin/main');
  const head = revision('HEAD');
  const comparison = current && head ? git('merge-base', head, current) : null;
  const base = comparison?.status === 0 ? comparison.stdout.trim() : null;
  const report = { ref: 'origin/main', beforeFetch, refreshed, current, head, base, ahead: null, behind: null, localPaths: [], upstreamPaths: [], overlappingPaths: [] };
  const paths = (...args) => {
    const result = git(...args);
    if (result.status !== 0) {
      warnings.push('Cannot inspect changed paths. Check Git status manually before coordinating edits.');
      return [];
    }
    return result.stdout.split('\0').filter(file => file && highConflict(file));
  };
  report.localPaths = [...new Set([
    ...(base ? paths('diff', '--name-only', '--no-renames', '-z', base, head, '--') : []),
    ...(head ? paths('diff', '--name-only', '--no-renames', '-z', head, '--') : []),
    ...paths('ls-files', '--others', '--exclude-standard', '-z'),
  ])].sort();
  if (!current) warnings.push('origin/main is unavailable locally. Run with --fetch to refresh it before coordinating changes.');
  else if (!base) warnings.push('No common base with origin/main is available. Check for shallow or unrelated history before coordinating edits.');
  else {
    const counts = git('rev-list', '--left-right', '--count', `${head}...${current}`);
    if (counts.status === 0 && /^\d+\s+\d+\s*$/.test(counts.stdout)) {
      [report.ahead, report.behind] = counts.stdout.trim().split(/\s+/).map(Number);
      if (report.behind) warnings.push(`origin/main is ${report.behind} commit(s) ahead of HEAD. Review upstream changes and coordinate ownership before merging; no branch rewrite was performed.`);
    } else warnings.push('Cannot measure origin/main drift. Inspect Git history manually.');
    report.upstreamPaths = [...new Set(paths('diff', '--name-only', '--no-renames', '-z', base, current, '--'))].sort();
  }
  report.overlappingPaths = report.localPaths.filter(file => report.upstreamPaths.includes(file));
  if (report.localPaths.length) warnings.push(`Local high-conflict paths changed: ${report.localPaths.join(', ')}. Coordinate ownership before editing shared files.`);
  if (report.upstreamPaths.length) warnings.push(`Upstream high-conflict paths changed: ${report.upstreamPaths.join(', ')}. Review these before merging.`);
  if (report.overlappingPaths.length) warnings.push(`Local/upstream high-conflict overlap: ${report.overlappingPaths.join(', ')}. Coordinate ownership before editing or merging.`);
  if (!fetch) warnings.push('Upstream report uses cached origin/main; run with --fetch when a network refresh is appropriate.');
  return report;
}

function browserReport(cwd, env, execute, warnings) {
  const location = env.CHROMIUM_PATH || env.CHROMIUM;
  if (!location) return null;
  let ciVersion = null;
  try {
    const workflow = fs.readFileSync(path.join(cwd, '.github/workflows/ci.yml'), 'utf8');
    const versions = [...new Set([...workflow.matchAll(/https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/(\d+\.\d+\.\d+\.\d+)\//g)].map(match => match[1]))];
    if (versions.length === 1) ciVersion = versions[0];
  } catch {}
  if (!ciVersion) warnings.push('CI browser pin unavailable or ambiguous in .github/workflows/ci.yml; compare the configured browser manually.');
  const result = execute(location, ['--version']);
  const version = result.status === 0 && !result.error ? [result.stdout || '', result.stderr || ''].join('\n').match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1] || null : null;
  const matchesCI = version && ciVersion ? version === ciVersion : null;
  if (!version) warnings.push('Configured browser is unrunnable or its version is unavailable. Check CHROMIUM_PATH/CHROMIUM before browser verification.');
  if (matchesCI === false) warnings.push(`Configured browser ${version} differs from CI Chrome for Testing ${ciVersion}. Select the CI-pinned browser for matching verification.`);
  return { executable: location, version, ciVersion, matchesCI };
}

function preflight({ cwd = process.cwd(), env = process.env, run = spawnSync, setupHooks = false, fetch = false } = {}) {
  const report = { ok: false, platform: process.platform, architecture: process.arch, root: null, toolchain: {}, browser: null, hooks: null, upstream: null, errors: [], warnings: [] };
  const execute = (command, args, environment = env) => run(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) });
  const git = (...args) => execute('git', args);
  const checkout = git('rev-parse', '--show-toplevel');
  if (checkout.error || checkout.status !== 0) {
    report.errors.push('Git and a readable repository checkout are required. Run from inside the checkout.');
    return report;
  }
  cwd = path.resolve(checkout.stdout.trim());
  report.root = cwd;
  let engines;
  try {
    engines = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).engines;
    if (!engines?.node || !engines?.pnpm) throw new Error('Missing engines');
  } catch {
    report.errors.push('Cannot read Node/pnpm requirements from repository package.json engines.');
    return report;
  }
  const versionEnvironment = { ...env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_manage_package_manager_versions: 'false' };
  for (const [name, location] of [['node', process.execPath], ['pnpm', executable('pnpm', env)]]) {
    const result = location ? execute(location, ['--version'], versionEnvironment) : null;
    const version = result?.status === 0 ? result.stdout.trim().replace(/^v/, '') : null;
    const supported = Boolean(version && compatible(version, engines[name]));
    report.toolchain[name] = { executable: location, version, required: engines[name], compatible: supported };
    if (!supported) report.errors.push(`${name} requires stable ${engines[name]}; found ${version || 'no runnable executable'}. Select a compatible toolchain on PATH and rerun.`);
  }
  report.browser = browserReport(cwd, env, execute, report.warnings);
  const configuration = git('config', '--get', 'core.hooksPath');
  if (configuration.error || ![0, 1].includes(configuration.status)) {
    report.errors.push('Cannot read core.hooksPath. Check Git configuration before setting up hooks.');
    return report;
  }
  const configuredPath = configuration.status === 0 ? configuration.stdout.trim() : null;
  let setupMessage = null;
  if (setupHooks && configuredPath === null) {
    const setup = execute(process.execPath, [path.join(__dirname, 'setup-git-hooks.js')]);
    setupMessage = (setup.stdout || setup.stderr || '').trim();
    if (setup.error || setup.status !== 0) report.errors.push('Hook setup refused or failed; preserve custom hooks and integrate .githooks/pre-commit and .githooks/pre-rebase manually.');
  }
  const currentConfiguration = git('config', '--get', 'core.hooksPath');
  const hookDirectory = git('rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  const hookPath = hookDirectory.status === 0 ? path.resolve(hookDirectory.stdout.trim()) : null;
  if (currentConfiguration.error || ![0, 1].includes(currentConfiguration.status) || hookDirectory.status !== 0) report.errors.push('Cannot resolve actual Git hook configuration. Check Git configuration and rerun.');
  const files = ['pre-commit', 'pre-rebase'].map(name => {
    const location = hookPath ? path.join(hookPath, name) : null;
    let runnable = false;
    try {
      fs.accessSync(location, fs.constants.X_OK);
      runnable = fs.statSync(location).isFile();
    } catch {}
    return { name, executable: runnable };
  });
  let checkedInDirectory = false;
  try {
    checkedInDirectory = fs.realpathSync(hookPath) === fs.realpathSync(path.join(cwd, '.githooks'));
  } catch {}
  const active = checkedInDirectory && files.every(file => file.executable);
  report.hooks = { configuredPath: currentConfiguration.status === 0 ? currentConfiguration.stdout.trim() : null, path: hookPath, active, files, setupMessage };
  if (configuredPath !== null && configuredPath !== '.githooks') report.warnings.push(`Custom core.hooksPath ${JSON.stringify(configuredPath)} preserved; ${active ? 'resolves to checked-in hooks' : 'verify manual integration of both checked-in hooks'}.`);
  if (!active) {
    report.errors.push(report.hooks.configuredPath === null
      ? 'Checked-in Git hooks are inactive. Run node bin/agent-preflight.js --setup-hooks; custom hooks will not be replaced.'
      : 'Checked-in Git hooks are not active and executable. Preserve custom hooks and integrate .githooks/pre-commit and .githooks/pre-rebase, or restore the checked-in hooks.');
  }
  report.upstream = upstreamReport(git, fetch, report.errors, report.warnings);
  report.ok = report.errors.length === 0;
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const allowed = ['--json', '--report-only', '--fetch', '--setup-hooks', '--help'];
  if (args.some(argument => !allowed.includes(argument))) {
    process.stderr.write('Unknown option. Use --help.\n');
    process.exitCode = 2;
    return;
  }
  if (args.includes('--help')) {
    process.stdout.write('Usage: node bin/agent-preflight.js [--json] [--report-only] [--fetch] [--setup-hooks]\nOffline by default. --fetch refreshes origin/main; --setup-hooks enables hooks only in a safe unconfigured checkout. --report-only reports failures without a failing exit status.\n');
    return;
  }
  const report = preflight({ setupHooks: args.includes('--setup-hooks'), fetch: args.includes('--fetch') });
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`${report.platform}/${report.architecture}: ${report.root || 'no checkout'}\n`);
    for (const [name, tool] of Object.entries(report.toolchain)) process.stdout.write(`${name}: ${tool.version || 'unavailable'} (${tool.executable || 'not on PATH'}), requires ${tool.required}\n`);
    if (report.browser) process.stdout.write(`Browser: ${report.browser.version || 'unavailable'} (${report.browser.executable}); CI ${report.browser.ciVersion || 'unknown'}; matches CI: ${report.browser.matchesCI ?? 'unknown'}\n`);
    if (report.hooks) {
      process.stdout.write(`Hooks: ${report.hooks.active ? 'active' : 'inactive/unverified'} (${report.hooks.path})\n`);
      if (report.hooks.setupMessage) process.stdout.write(report.hooks.setupMessage + '\n');
    }
    if (report.upstream) process.stdout.write(`origin/main: ${report.upstream.current}; base ${report.upstream.base}; ahead ${report.upstream.ahead}, behind ${report.upstream.behind}\n`);
    for (const warning of report.warnings) process.stdout.write(`Warning: ${warning}\n`);
    for (const error of report.errors) process.stderr.write(`Error: ${error}\n`);
  }
  process.exitCode = report.ok || args.includes('--report-only') ? 0 : 1;
}

if (require.main === module) main();
module.exports = { preflight };
