const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { setTimeout } = require('node:timers/promises');
const { releaseVersion, sourceVersion, compareVersions } = require('./release.js');

const extensionId = 'kopbjmlmjpnkekffalpbjfhmbhgbgamk';

function validateConfiguration({ publisherId, itemId, token }) {
  if (!/^[A-Za-z0-9-]+$/.test(publisherId || '') || publisherId.startsWith('SET')) {
    throw new Error('Set CWS_PUBLISHER_ID to the publisher ID from the Developer Dashboard.');
  }
  if (itemId !== extensionId) throw new Error('CWS_EXTENSION_ID must target the existing CreateRatio extension.');
  if (!token) throw new Error('A Chrome Web Store access token is required.');
}

async function submitRelease(configuration, fetchRequest = fetch, wait = setTimeout) {
  validateConfiguration(configuration);
  const { publisherId, itemId, token, version, archive } = configuration;
  const item = `publishers/${publisherId}/items/${itemId}`;
  const base = 'https://chromewebstore.googleapis.com';
  async function request(url, method = 'GET', body, contentType = 'application/json') {
    const response = await fetchRequest(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(60000),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Chrome Web Store request failed (HTTP ${response.status}); inspect the Developer Dashboard before retrying.`);
    return response.json();
  }
  const status = await request(`${base}/v2/${item}:fetchStatus`);
  if (status.takenDown || status.warned) throw new Error('Resolve the store policy warning or takedown before releasing.');
  if (['PENDING_REVIEW', 'STAGED'].includes(status.submittedItemRevisionStatus?.state)) {
    throw new Error('A submission is already pending or staged; inspect the Developer Dashboard.');
  }
  for (const channel of status.publishedItemRevisionStatus?.distributionChannels || []) {
    if (channel.crxVersion && compareVersions(version, channel.crxVersion) <= 0) {
      throw new Error('Release version must be newer than the published version.');
    }
  }
  const upload = await request(`${base}/upload/v2/${item}:upload`, 'POST', archive, 'application/zip');
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error('Uploaded version does not match the release tag.');
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < 30; attempt++) {
    await wait(5000);
    state = (await request(`${base}/v2/${item}:fetchStatus`)).lastAsyncUploadState;
  }
  if (state === 'IN_PROGRESS') throw new Error('Store upload processing timed out; inspect the Developer Dashboard before retrying.');
  if (state !== 'SUCCEEDED') throw new Error('Store upload did not succeed; refusing submission.');
  const published = await request(`${base}/v2/${item}:publish`, 'POST', JSON.stringify({
    publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true
  }));
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(published.state)) throw new Error('Unexpected store submission state; inspect the Developer Dashboard.');
  return published.state;
}

async function main() {
  const command = process.argv[2];
  const tag = process.env.GITHUB_REF_NAME;
  if (command === 'validate') {
    process.stdout.write(`Validated release ${releaseVersion(tag, [sourceVersion()])}.\n`);
    return;
  }
  const configuration = {
    publisherId: process.env.CWS_PUBLISHER_ID,
    itemId: process.env.CWS_EXTENSION_ID,
    token: process.env.CWS_ACCESS_TOKEN
  };
  if (command === 'check-config') {
    validateConfiguration({ ...configuration, token: 'configuration-check' });
    if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/createratio-release\/providers\/github$/.test(process.env.CWS_WORKLOAD_IDENTITY_PROVIDER || '')) {
      throw new Error('Set CWS_WORKLOAD_IDENTITY_PROVIDER from the infra output before releasing.');
    }
    if (process.env.CWS_SERVICE_ACCOUNT !== 'createratio-prod-store@sunsetatomic-createratio.iam.gserviceaccount.com') {
      throw new Error('Set CWS_SERVICE_ACCOUNT to the CreateRatio store service account.');
    }
    return;
  }
  if (command !== 'submit') throw new Error('Use validate, check-config, or submit.');
  validateConfiguration(configuration);
  const file = 'dist/createratio-chrome.zip';
  const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8', timeout: 10000 }));
  const version = releaseVersion(tag, [manifest.version]);
  const state = await submitRelease({ ...configuration, version, archive: readFileSync(file) });
  process.stdout.write(state === 'PUBLISHED'
    ? `Chrome Web Store reports ${version} published.\n`
    : `Version ${version} submitted for review; it will publish after Google approves.\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { releaseVersion, validateConfiguration, submitRelease };
