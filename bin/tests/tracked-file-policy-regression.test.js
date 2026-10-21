'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const guard = path.resolve(__dirname, 'tracked-file-policy.test.js');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'createratio-private-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', directory]);
  writeFileSync(path.join(directory, '.gitignore'), '.pi/\n.agents/skills/\n.claude/skills/\nignored-target/\n');
  return directory;
}

function write(directory, file) {
  const destination = path.join(directory, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, 'Sanitized fixture.\n');
}

function runGuard(directory) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', guard], {
    cwd: directory, env, encoding: 'utf8', timeout: 10000
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('the file policy rejects individually force-added private files across harnesses', t => {
  for (const file of ['.pi/settings.json', '.agents/skills/local-only/SKILL.md', '.claude/skills/local-only/SKILL.md']) {
    const directory = fixture(t);
    write(directory, file);
    execFileSync('git', ['add', '--force', '--', file], { cwd: directory });
    const result = runGuard(directory);
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(file), result.output);
  }
});

test('the file policy rejects tracked skill-directory symlinks without following their targets', t => {
  for (const file of ['.claude/skills/local-only', '.claude/skills', '.agents/skills']) {
    const directory = fixture(t);
    write(directory, 'ignored-target/SKILL.md');
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.relative(path.dirname(destination), path.join(directory, 'ignored-target')), destination, 'dir');
    execFileSync('git', ['add', '--force', '--', file], { cwd: directory });
    const result = runGuard(directory);
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(file), result.output);
  }
});

test('the file policy allows ignored and untracked private files alongside ordinary tracked files', t => {
  const directory = fixture(t);
  writeFileSync(path.join(directory, '.gitignore'), '.pi/\n');
  for (const file of ['.pi/settings.json', '.agents/skills/local-only/SKILL.md', '.claude/skills/local-only/SKILL.md']) {
    write(directory, file);
  }
  symlinkSync('../../.agents/skills/local-only', path.join(directory, '.claude/skills/linked-only'), 'dir');
  for (const file of ['AGENTS.md', '.agents/skills-public/example.md', '.claude/skills-notes.md', 'fixtures/.agents/skills/example/SKILL.md']) {
    write(directory, file);
    execFileSync('git', ['add', '--', file], { cwd: directory });
  }
  const result = runGuard(directory);
  assert.equal(result.status, 0, result.output);
});
