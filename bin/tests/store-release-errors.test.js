const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { submitRelease } = require('../chrome-store-release.js');
const { submitFirefoxRelease } = require('../firefox-store-release.js');

const version = '0.0.2';
const chrome = {
  publisherId: 'publisher-123', itemId: 'kopbjmlmjpnkekffalpbjfhmbhgbgamk',
  token: 'synthetic-access-token', version, archive: Buffer.from('synthetic ZIP')
};
const firefox = {
  addonId: 'create-greater-consume@createratio', apiKey: 'user:123:45', apiSecret: 'synthetic-secret',
  version, archive: Buffer.from('synthetic ZIP'), sourceArchive: Buffer.from('synthetic source ZIP')
};
const chromeUploaded = { uploadState: 'SUCCEEDED', crxVersion: version };
const addon = { guid: firefox.addonId, status: 'public', current_version: { version: '0.0.1' } };
const history = { results: [], next: null };
const validated = { uuid: 'upload-123', processed: true, valid: true, submitted: false, version, channel: 'listed' };

function store(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.ok(responses.length, 'Unexpected store request');
      const response = responses.shift();
      return typeof response === 'function' ? response(options) : response instanceof Response ? response : Response.json(response);
    }
  };
}

test('Chrome HTTP failures identify the operation and expose Google validation details without retrying', async () => {
  for (const [prefix, operation] of [
    [[], 'status check'], [[{}], 'upload'],
    [[{}, { uploadState: 'IN_PROGRESS' }], 'upload processing status'],
    [[{}, chromeUploaded], 'submission']
  ]) {
    const api = store([...prefix, Response.json({ error: {
      code: 400, status: 'INVALID_ARGUMENT', message: 'Complete the permission justification.',
      details: [{ fieldViolations: [{ field: 'scripting', description: 'Justification is required.' }] }]
    } }, { status: 400 })]);
    await assert.rejects(submitRelease(chrome, api.fetch, async () => {}), error => {
      assert.ok(error.message.includes(operation), error.message);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /INVALID_ARGUMENT/);
      assert.match(error.message, /Complete the permission justification/);
      assert.match(error.message, /scripting/);
      assert.match(error.message, /Justification is required/);
      assert.match(error.message, /before retrying/);
      return true;
    });
    assert.equal(api.calls.length, prefix.length + 1);
  }
});

test('Mozilla HTTP failures identify the operation and show nested field errors without retrying', async () => {
  for (const [prefix, operation] of [
    [[], 'listing check'], [[addon], 'version history'], [[addon, history], 'upload'],
    [[addon, history, { uuid: 'upload-123', processed: false }], 'upload validation'],
    [[addon, history, validated], 'version creation']
  ]) {
    const api = store([...prefix, Response.json({
      detail: 'Submission is incomplete.', source: ['Reviewer source is required.'],
      non_field_errors: ['Complete the listing.']
    }, { status: 400 })]);
    await assert.rejects(submitFirefoxRelease(firefox, api.fetch, async () => {}), error => {
      assert.ok(error.message.includes(operation), error.message);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /Submission is incomplete/);
      assert.match(error.message, /Reviewer source is required/);
      assert.match(error.message, /Complete the listing/);
      return true;
    });
    assert.equal(api.calls.length, prefix.length + 1);
  }
});

test('Chrome HTTP-success failure states retain the last upload or submission diagnostics', async () => {
  for (const [responses, operation] of [
    [[{}, { uploadState: 'FAILED', itemError: [{ error_detail: 'Invalid extension package.' }] }], 'upload processing'],
    [[{}, { uploadState: 'IN_PROGRESS' }, { lastAsyncUploadState: 'FAILED', error: { message: 'Invalid extension package.' } }], 'upload processing'],
    [[{}, chromeUploaded, { state: 'REJECTED', error: { message: 'Invalid extension package.' } }], 'submission']
  ]) {
    const count = responses.length;
    const api = store(responses);
    await assert.rejects(submitRelease(chrome, api.fetch, async () => {}), error => {
      assert.ok(error.message.includes(operation), error.message);
      assert.match(error.message, /Invalid extension package/);
      return true;
    });
    assert.equal(api.calls.length, count);
  }
});

test('Mozilla HTTP-success validation failures include validator messages, not source context', async () => {
  const api = store([addon, history, { ...validated, valid: false, validation: {
    errors: 1, messages: [{ type: 'error', message: 'Unsupported manifest entry.',
      description: ['Remove the unsupported setting.'], context: ['PRIVATE SOURCE CONTENT'] }]
  } }]);
  await assert.rejects(submitFirefoxRelease(firefox, api.fetch), error => {
    assert.match(error.message, /upload validation/);
    assert.match(error.message, /Unsupported manifest entry/);
    assert.match(error.message, /Remove the unsupported setting/);
    assert.doesNotMatch(error.message, /PRIVATE SOURCE CONTENT/);
    return true;
  });
  assert.equal(api.calls.length, 3);
});

test('store error messages redact credentials and cannot inject multiline workflow commands', async () => {
  for (const [submit, configuration, scheme] of [[submitRelease, chrome, 'Bearer'], [submitFirefoxRelease, firefox, 'JWT']]) {
    const api = store([options => Response.json({ error: { message:
      `${configuration.token || configuration.apiKey} ${configuration.apiSecret || ''} ${encodeURIComponent(configuration.apiKey || '')} ${options.headers.Authorization}\n::warning::injected`,
      credentials: { token: 'PRIVATE UNKNOWN FIELD' }
    } }, { status: 403 })]);
    await assert.rejects(submit(configuration, api.fetch), error => {
      for (const secret of [configuration.token, configuration.apiKey, configuration.apiSecret, api.calls[0].headers.Authorization.split(' ')[1]].filter(Boolean)) {
        assert.ok(!error.message.includes(secret), error.message);
        assert.ok(!error.message.includes(encodeURIComponent(secret)), error.message);
      }
      assert.doesNotMatch(error.message, /PRIVATE UNKNOWN FIELD|\n|\r/);
      assert.ok(!error.message.includes(`${scheme} ` + api.calls[0].headers.Authorization.split(' ')[1]));
      assert.match(error.message, /REDACTED/);
      return true;
    });
    assert.equal(api.calls.length, 1);
  }
});

test('Mozilla validator diagnostics redact standalone JWTs from HTTP-success responses', async () => {
  let token;
  const api = store([addon, history, options => {
    token = options.headers.Authorization.slice(4);
    return Response.json({ ...validated, valid: false, validation: { messages: [{ message: `Rejected token ${token}` }] } });
  }]);
  await assert.rejects(submitFirefoxRelease(firefox, api.fetch), error => {
    assert.match(error.message, /Rejected token <REDACTED>/);
    assert.ok(!error.message.includes(token));
    return true;
  });
});

test('non-JSON, unreadable and oversized error bodies retain operation and HTTP status safely', async () => {
  for (const response of [
    new Response('<html>PRIVATE PROXY RESPONSE</html>', { status: 502 }),
    Response.json({ error: { message: 'x'.repeat(40000) } }, { status: 400 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new Error(chrome.token)); } }), { status: 500 })
  ]) {
    const api = store([response]);
    await assert.rejects(submitRelease(chrome, api.fetch), error => {
      assert.match(error.message, /status check/);
      assert.match(error.message, /HTTP (400|500|502)/);
      assert.doesNotMatch(error.message, /PRIVATE PROXY RESPONSE|synthetic-access-token/);
      assert.ok(error.message.length < 5000);
      return true;
    });
  }
});

test('large structured diagnostics are bounded after redaction', async () => {
  const api = store([Response.json({ error: { details: Array.from({ length: 30 }, () => ({
    message: `${chrome.token} ${'x'.repeat(750)}`
  })) } }, { status: 400 })]);
  await assert.rejects(submitRelease(chrome, api.fetch), error => {
    assert.match(error.message, /REDACTED/);
    assert.doesNotMatch(error.message, /synthetic-access-token/);
    assert.ok(error.message.length < 4000);
    return true;
  });
});

test('network and invalid JSON failures retain the failed operation without exposing transport errors', async () => {
  for (const [submit, configuration, operation] of [
    [submitRelease, chrome, 'status check'], [submitFirefoxRelease, firefox, 'listing check']
  ]) {
    for (const response of [() => { throw new Error('PRIVATE TRANSPORT ERROR'); }, new Response('invalid JSON')]) {
      const api = store([response]);
      await assert.rejects(submit(configuration, api.fetch), error => {
        assert.ok(error.message.includes(operation), error.message);
        assert.doesNotMatch(error.message, /PRIVATE TRANSPORT ERROR/);
        return true;
      });
      assert.equal(api.calls.length, 1);
    }
  }
});

test('real store CLIs exit nonzero with readable details and an escaped Actions error annotation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-store-errors-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'dist'));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    version, browser_specific_settings: { gecko: { id: firefox.addonId } }
  }));
  for (const browser of ['chrome', 'firefox']) {
    const archive = spawnSync('zip', ['-q', `dist/createratio-${browser}.zip`, 'manifest.json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
  }
  fs.writeFileSync(path.join(directory, 'dist/createratio-source.zip'), 'synthetic source ZIP');
  const preload = path.join(directory, 'store-boundary.cjs');
  fs.writeFileSync(preload, `global.fetch = async () => Response.json({error: {message: 'Missing justification: 100% required.\\n::warning::not a command'}}, {status: 400});\n`);
  for (const browser of ['chrome', 'firefox']) {
    const result = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, `../${browser}-store-release.js`), 'submit'], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: `v${version}`,
        CWS_PUBLISHER_ID: chrome.publisherId, CWS_EXTENSION_ID: chrome.itemId, CWS_ACCESS_TOKEN: chrome.token,
        AMO_ADDON_ID: firefox.addonId, AMO_API_KEY: firefox.apiKey, AMO_API_SECRET: firefox.apiSecret }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Missing justification: 100% required/);
    assert.match(result.stdout, /::error title=.*::.*Missing justification: 100%25 required/);
    assert.doesNotMatch(result.stdout + result.stderr, /^::warning::/m);
    assert.equal(result.stdout.trim().split('\n').length, 1);
  }
});
