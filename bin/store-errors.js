const diagnosticFields = new Set([
  'error', 'errors', 'code', 'status', 'message', 'messages', 'detail', 'details',
  'reason', 'description', 'fieldViolations', 'field', 'non_field_errors',
  'source', 'upload', 'version', 'license', 'channel', 'validation', 'type',
  'uploadState', 'lastAsyncUploadState', 'state', 'itemError', 'error_code', 'error_detail',
  'warningInfo', 'warnings'
]);

function sanitize(value, secrets = []) {
  let text = String(value);
  const variants = secrets.filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret)]).sort((a, b) => b.length - a.length);
  for (const secret of variants) text = text.split(secret).join('<REDACTED>');
  return text.replace(/\b(Bearer|JWT)\s+[^\s<>"']+/gi, '$1 <REDACTED>')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED>')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

function diagnosticDetails(value, secrets) {
  const parts = [];
  let remaining = 100;
  function visit(current, label, depth) {
    if (depth > 6 || --remaining < 0) return;
    if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
      const text = sanitize(current, secrets).slice(0, 700);
      if (text) parts.push(`${label}: ${text}`);
    } else if (Array.isArray(current)) {
      for (const child of current.slice(0, 20)) visit(child, label, depth + 1);
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (diagnosticFields.has(key)) visit(child, label ? `${label}.${key}` : key, depth + 1);
      }
    }
  }
  if (value && typeof value === 'object') visit(value, '', 0);
  return parts.join('; ').slice(0, 3500);
}

async function responseDetails(response) {
  let reader;
  try {
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    reader?.releaseLock();
  }
}

function storeError(store, operation, failure, details, secrets = []) {
  const guidance = store === 'Chrome Web Store' ? 'the Developer Dashboard' : 'AMO';
  const diagnostic = diagnosticDetails(details, secrets);
  return new Error(`${store} ${operation} failed (${failure}); inspect ${guidance} before retrying. ${diagnostic || 'No safe structured store details available.'}`);
}

async function storeHttpError(store, operation, response, secrets) {
  return storeError(store, operation, `HTTP ${response.status}`, await responseDetails(response), secrets);
}

function reportStoreFailure(error, title) {
  const message = sanitize(error.message);
  process.stderr.write(`${message}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    process.stdout.write(`::error title=${title}::${escaped}\n`);
  }
  process.exitCode = 1;
}

module.exports = { storeError, storeHttpError, reportStoreFailure };
