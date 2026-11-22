'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pins = require('./browser-pins.json');

const officialDownloads = 'https://storage.googleapis.com/chrome-for-testing-public';
const verifiedMarker = '.verified-sha256';
const setupAdvice = 'Run `pnpm setup:chromium` to install the Chrome for Testing build that CI uses.';

function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  return null;
}

function defaultCacheRoot(env = process.env, platform = process.platform) {
  if (env.CREATERATIO_CACHE_DIR) return path.resolve(env.CREATERATIO_CACHE_DIR);
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'createratio');
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'createratio');
}

function pinnedChromium({ key = platformKey(), cacheRoot = defaultCacheRoot(), downloads = officialDownloads } = {}) {
  const { version, archives } = pins.chromeForTesting;
  if (!archives[key]) return null;
  const directory = path.join(cacheRoot, 'chrome-for-testing', version, key);
  return {
    version,
    key,
    sha256: archives[key].sha256,
    url: `${downloads}/${version}/${key}/chrome-${key}.zip`,
    directory,
    executable: path.join(directory, archives[key].executable)
  };
}

function isInstalled(pin) {
  try {
    return fs.readFileSync(path.join(pin.directory, verifiedMarker), 'utf8') === pin.sha256
      && fs.statSync(pin.executable).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function downloadWithDigest(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} downloading ${url}`);
  const digest = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) {
      digest.update(chunk);
      yield chunk;
    }
  }, fs.createWriteStream(file));
  return digest.digest('hex');
}

function unpack(archive, destination, platform = process.platform) {
  const [command, args] = platform === 'darwin'
    ? ['ditto', ['-x', '-k', archive, destination]]
    : ['unzip', ['-q', archive, '-d', destination]];
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}: ${result.stderr}`);
}

function moveIntoCache(unpacked, pin) {
  if (fs.existsSync(pin.directory) && !isInstalled(pin)) fs.rmSync(pin.directory, { recursive: true, force: true });
  try {
    fs.renameSync(unpacked, pin.directory);
  } catch (error) {
    const replacedConcurrently = ['ENOTEMPTY', 'EEXIST'].includes(error.code) && isInstalled(pin);
    if (!replacedConcurrently) throw error;
  }
}

async function installChromium(pin = pinnedChromium()) {
  if (!pin) throw new Error(`Chrome for Testing has no pinned archive for ${process.platform}-${process.arch}.`);
  if (isInstalled(pin)) return { executable: pin.executable, downloaded: false };
  const parent = path.dirname(pin.directory);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.${pin.key}-staging-`));
  try {
    const archive = path.join(staging, 'archive.zip');
    const actual = await downloadWithDigest(pin.url, archive);
    if (actual !== pin.sha256) {
      throw new Error(`Checksum mismatch for ${pin.url}: expected ${pin.sha256}, received ${actual}. The archive was not unpacked.`);
    }
    const unpacked = path.join(staging, 'unpacked');
    unpack(archive, unpacked);
    fs.writeFileSync(path.join(unpacked, verifiedMarker), pin.sha256);
    moveIntoCache(unpacked, pin);
    return { executable: pin.executable, downloaded: true };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function reportedVersion(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (result.error?.code === 'ENOENT') return { problem: 'not found' };
  if (result.error) return { problem: result.error.message };
  if (result.status !== 0) return { problem: `--version exited with code ${result.status}` };
  return { version: result.stdout.trim() };
}

function resolveBrowser(env = process.env, pin = pinnedChromium({ cacheRoot: defaultCacheRoot(env) })) {
  const executable = env.CHROMIUM_PATH || env.CHROMIUM || (pin && isInstalled(pin) ? pin.executable : '/usr/bin/chromium');
  const { version, problem } = reportedVersion(executable);
  if (problem) return { problem: `Browser ${executable}: ${problem}. ${setupAdvice}` };
  if (/^Google Chrome (?!for Testing)/.test(version)) {
    return { problem: `${version} at ${executable} is branded Chrome, which ignores --load-extension. ${setupAdvice}` };
  }
  const pinnedVersion = pins.chromeForTesting.version;
  const warning = version.includes(pinnedVersion) ? null : `${version} differs from the CI browser, Chrome for Testing ${pinnedVersion}. ${setupAdvice}`;
  return { executable, version, warning };
}

async function main(argv) {
  if (argv[0] === '--resolve') {
    const resolved = resolveBrowser();
    if (resolved.problem) {
      console.error(resolved.problem);
      return 1;
    }
    if (resolved.warning) console.error(`Warning: ${resolved.warning}`);
    console.log(resolved.executable);
    return 0;
  }
  if (argv.length) {
    console.error('Usage: node bin/setup-chromium.js [--resolve]');
    return 2;
  }
  const pin = pinnedChromium();
  const { executable, downloaded } = await installChromium(pin);
  console.log(`${downloaded ? 'Installed' : 'Already installed:'} Chrome for Testing ${pins.chromeForTesting.version} (${pin.key})`);
  console.log('pnpm check:browser and pnpm smoke:browser use it when CHROMIUM_PATH and CHROMIUM are unset.');
  console.log(`CHROMIUM_PATH=${JSON.stringify(executable)}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { platformKey, defaultCacheRoot, pinnedChromium, installChromium, isInstalled, resolveBrowser };
