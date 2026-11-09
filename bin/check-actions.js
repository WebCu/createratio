'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function fetchManifest(reference, request = fetch) {
  const [action, sha] = reference.split('@');
  const [owner, repository, ...subpath] = action.split('/');
  const base = `https://raw.githubusercontent.com/${owner}/${repository}/${sha}/${subpath.length ? `${subpath.join('/')}/` : ''}`;
  for (const filename of ['action.yml', 'action.yaml']) {
    const response = await request(`${base}${filename}`, { signal: AbortSignal.timeout(15000) });
    if (response.ok) return response.text();
    if (response.status !== 404) throw new Error(`HTTP ${response.status} fetching ${reference}`);
  }
  throw new Error(`Action manifest not found for ${reference}`);
}

async function auditActions(workflows, loadManifest = fetchManifest) {
  const problems = [];
  const actions = new Set();
  for (const { name, source } of workflows) {
    if (/^\s*runs-on:\s*['"]?ubuntu-latest['"]?\s*$/m.test(source)) {
      problems.push(`${name}: pin ubuntu-latest to an explicit Ubuntu release`);
    }
    for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\r\n]+)/gm)) {
      const reference = match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
      if (reference.startsWith('./')) continue;
      if (!/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[a-f\d]{40}$/i.test(reference)) {
        problems.push(`${name}: pin ${reference} to a full commit SHA`);
      } else {
        actions.add(reference);
      }
    }
  }
  for (const reference of actions) {
    try {
      const source = await loadManifest(reference);
      const runtime = source.match(/^\s+using:\s*['"]?(node\d+|composite|docker)['"]?\s*$/m)?.[1];
      if (!runtime) {
        problems.push(`${reference}: could not identify the action runtime`);
      } else if (!runtime.startsWith('node')) {
        problems.push(`${reference}: ${runtime} actions need a separate runtime audit`);
      } else if (Number(runtime.slice(4)) < 24) {
        problems.push(`${reference}: Node ${runtime.slice(4)} is below the supported action runtime minimum of 24`);
      }
    } catch (error) {
      problems.push(`${reference}: could not verify runtime: ${error.message}`);
    }
  }
  return problems;
}

if (require.main === module) {
  const directory = path.resolve(__dirname, '../.github/workflows');
  const workflows = fs.readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()
    .map(name => ({ name, source: fs.readFileSync(path.join(directory, name), 'utf8') }));
  auditActions(workflows).then(problems => {
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Action runtime audit passed for ${workflows.length} workflows.`);
    }
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { auditActions, fetchManifest };
