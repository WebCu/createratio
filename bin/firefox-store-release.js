const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const { setTimeout } = require('node:timers/promises');
const { releaseVersion, compareVersions } = require('./release.js');

const addonId = 'create-greater-consume@createratio';

function validateConfiguration(configuration) {
  if (configuration.addonId !== addonId) throw new Error('AMO_ADDON_ID must target the existing CreateRatio Firefox add-on.');
  for (const field of ['apiKey', 'apiSecret']) {
    const value = configuration[field];
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
      throw new Error('Set AMO_API_KEY and AMO_API_SECRET as Firefox environment secrets without surrounding whitespace.');
    }
  }
  releaseVersion(`v${configuration.version}`, [configuration.version]);
  if (![configuration.archive, configuration.sourceArchive].every(value => Buffer.isBuffer(value) && value.length)) {
    throw new Error('Both Firefox and reviewer-source archives are required.');
  }
}

async function submitFirefoxRelease(configuration, fetchRequest = fetch, wait = setTimeout) {
  validateConfiguration(configuration);
  const { apiKey, apiSecret, version, archive, sourceArchive } = configuration;
  const item = `/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
  async function request(endpoint, method = 'GET', body) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: apiKey, jti: randomUUID(), iat: now, exp: now + 60 })).toString('base64url');
    const signed = `${header}.${payload}`;
    const token = `${signed}.${createHmac('sha256', apiSecret).update(signed).digest('base64url')}`;
    let response;
    try {
      response = await fetchRequest(`https://addons.mozilla.org${endpoint}`, {
        method, body, headers: { Authorization: `JWT ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(60000)
      });
    } catch {
      throw new Error('Mozilla request failed or timed out; inspect AMO before retrying.');
    }
    if (!response.ok) throw new Error(`Mozilla ${method} request failed (HTTP ${response.status}); inspect AMO before retrying.`);
    try { return await response.json(); } catch { throw new Error('Mozilla returned an invalid response; inspect AMO before retrying.'); }
  }
  const addon = await request(item);
  if (!addon || addon.guid !== addonId || addon.status !== 'public' || addon.is_disabled || addon.is_disabled_by_developer || !addon.current_version?.version) {
    throw new Error('The existing Firefox listing is not available for an update; inspect AMO.');
  }
  if (compareVersions(version, addon.current_version.version) <= 0) throw new Error('Firefox release must be newer than the published version.');
  for (let page = 1; page <= 20; page++) {
    const history = await request(`${item}versions/?filter=all_with_unlisted&page_size=50&page=${page}`);
    if (!history || !Array.isArray(history.results) || !(history.next === null || (typeof history.next === 'string' && history.next))) {
      throw new Error('Mozilla version history is invalid; refusing upload.');
    }
    for (const previous of history.results) {
      if (!previous || !['listed', 'unlisted', 'enterprise'].includes(previous.channel) || typeof previous.file?.status !== 'string') {
        throw new Error('Mozilla version history has an unknown channel or state; refusing upload.');
      }
      if (compareVersions(version, previous.version) <= 0) throw new Error('Firefox release must be newer than every previously submitted version.');
      if (previous.channel === 'listed' && !['public', 'disabled', 'rejected', 'deleted'].includes(previous.file?.status)) {
        throw new Error('A Firefox submission is pending or incomplete; inspect AMO before releasing.');
      }
    }
    if (!history.next) break;
    if (page === 20) throw new Error('Mozilla version history exceeds the safety limit; inspect AMO before releasing.');
  }
  const uploadBody = new FormData();
  uploadBody.set('channel', 'listed');
  uploadBody.set('upload', new Blob([archive], { type: 'application/zip' }), 'createratio-firefox.zip');
  let upload = await request('/api/v5/addons/upload/', 'POST', uploadBody);
  const uuid = upload?.uuid;
  if (!/^[A-Za-z0-9-]+$/.test(uuid || '')) throw new Error('Mozilla did not return a valid upload identifier.');
  for (let attempt = 0; upload?.processed === false && attempt < 60; attempt++) {
    await wait(5000);
    upload = await request(`/api/v5/addons/upload/${uuid}/`);
  }
  if (upload?.processed === false) throw new Error('Mozilla upload validation timed out; inspect AMO before retrying.');
  if (!upload || upload.uuid !== uuid || upload.processed !== true || upload.valid !== true || upload.submitted || upload.version !== version || upload.channel !== 'listed') {
    throw new Error('Firefox upload did not pass validation for the expected listed version; refusing submission.');
  }
  const creation = new FormData();
  creation.set('upload', uuid);
  creation.set('license', 'MIT');
  creation.set('source', new Blob([sourceArchive], { type: 'application/zip' }), 'createratio-source.zip');
  const submitted = await request(`${item}versions/`, 'POST', creation);
  if (!submitted || !Number.isInteger(submitted.id) || submitted.id < 1 || submitted.version !== version || submitted.channel !== 'listed' ||
      !submitted.file?.status || ['disabled', 'rejected', 'deleted'].includes(submitted.file.status)) {
    throw new Error('Unexpected Firefox submission response; inspect AMO before retrying.');
  }
  return submitted.id;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'submit') throw new Error('Use node bin/firefox-store-release.js submit.');
  const file = 'dist/createratio-firefox.zip';
  const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8', timeout: 10000 }));
  const version = releaseVersion(process.env.GITHUB_REF_NAME, [manifest.version]);
  if (manifest.browser_specific_settings?.gecko?.id !== addonId) throw new Error('Firefox archive has the wrong add-on ID.');
  const id = await submitFirefoxRelease({
    addonId: process.env.AMO_ADDON_ID, apiKey: process.env.AMO_API_KEY, apiSecret: process.env.AMO_API_SECRET,
    version, archive: readFileSync(file), sourceArchive: readFileSync('dist/createratio-source.zip')
  });
  process.stdout.write(`Firefox ${version} submitted to AMO (version ID ${id}). Mozilla controls signing, review and publication.\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { submitFirefoxRelease };
