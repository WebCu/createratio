import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function identity(root, pid, read = readFile) {
  const value = await read(join(root, String(pid), 'stat'), 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert.ok(fields.length >= 20 && /^\d+$/.test(fields[19]), 'Invalid process identity');
  return { pid, parent: Number(fields[1]), startTicks: fields[19], live: !['Z', 'X', 'x'].includes(fields[0]) };
}

export async function ownedBrowserRoot(browser, procRoot = '/proc', ownerPid = process.pid) {
  const { processInfo } = await browser.cdp.send('SystemInfo.getProcessInfo');
  const roots = processInfo.filter(entry => entry.type === 'browser');
  assert.equal(roots.length, 1, 'Expected one owned browser process');
  const pid = roots[0].id;
  const root = await identity(procRoot, pid);
  assert.ok(root.live, 'Owned browser is not live');
  const args = (await readFile(join(procRoot, String(pid), 'cmdline'), 'utf8')).split('\0');
  assert.ok(args.includes(`--user-data-dir=${join(browser.directory, 'profile')}`), 'Browser profile ownership mismatch');
  let parent = root.parent;
  const visited = new Set([pid]);
  while (parent !== ownerPid) {
    assert.ok(parent > 1 && !visited.has(parent), 'Browser is not a descendant of this profiler');
    visited.add(parent);
    parent = (await identity(procRoot, parent)).parent;
  }
  return root;
}

function kilobytes(source, name) {
  const match = source.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
  assert.ok(match, `Missing ${name} in smaps_rollup`);
  return Number(match[1]) * 1024;
}

async function descendants(root, procRoot, files) {
  const table = new Map();
  for (const name of await files.readdir(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const entry = await identity(procRoot, Number(name), files.readFile);
      table.set(entry.pid, entry);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  const owned = new Set([root.pid]);
  let size;
  do {
    size = owned.size;
    for (const entry of table.values()) if (owned.has(entry.parent)) owned.add(entry.pid);
  } while (size !== owned.size);
  return [...owned].sort((a, b) => a - b).map(pid => {
    assert.ok(table.has(pid), 'Owned process disappeared before sampling');
    return table.get(pid);
  }).filter(entry => entry.live);
}

export async function sampleOwnedMemory(root, procRoot = '/proc', files = { readFile, readdir }) {
  const started = performance.now();
  assert.deepEqual(await identity(procRoot, root.pid, files.readFile), root, 'Owned browser identity changed');
  const entries = await descendants(root, procRoot, files);
  const processes = [];
  for (const expected of entries) {
    const { pid } = expected;
    const source = await files.readFile(join(procRoot, String(pid), 'smaps_rollup'), 'utf8');
    assert.deepEqual(await identity(procRoot, pid, files.readFile), expected, 'Process identity changed during sampling');
    processes.push({ ...expected, pssBytes: kilobytes(source, 'Pss'), rssBytes: kilobytes(source, 'Rss'), privateBytes: kilobytes(source, 'Private_Clean') + kilobytes(source, 'Private_Dirty') });
  }
  assert.deepEqual(await identity(procRoot, root.pid, files.readFile), root, 'Owned browser exited during sampling');
  assert.deepEqual(await descendants(root, procRoot, files), entries, 'Owned process tree changed during sampling');
  return {
    sampledAt: new Date().toISOString(), elapsedMs: performance.now() - started,
    pssBytes: processes.reduce((sum, entry) => sum + entry.pssBytes, 0),
    rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
    privateBytes: processes.reduce((sum, entry) => sum + entry.privateBytes, 0), processes
  };
}
