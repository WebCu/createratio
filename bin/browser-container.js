'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const usage = 'Usage: pnpm browser:container <command> [arguments...]';

function sourceFiles(directory = root) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: directory, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  return [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(file => {
    const stat = fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false });
    return stat && (stat.isFile() || stat.isSymbolicLink());
  });
}

function containerUser(uid = process.getuid(), gid = process.getgid()) {
  return uid === 0 ? [] : ['--user', `${uid}:${gid}`];
}

function prepareOutput(directory = path.join(root, 'dist/container')) {
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    throw new Error(`${directory} is not writable, so the container cannot export browser evidence. Fix its owner or remove it.`);
  }
  return directory;
}

function run(command) {
  if (!command.length) {
    console.error(usage);
    return Promise.resolve(2);
  }
  prepareOutput();
  const archive = spawn('tar', ['--null', '-T', '-', '--no-xattrs', '--no-acls', '-cf', '-'], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const container = spawn('docker', ['compose', 'run', '--rm', '-T', ...containerUser(), 'browser-tests', ...command], {
    cwd: root,
    stdio: [archive.stdout, 'inherit', 'inherit']
  });
  archive.stdin.end(sourceFiles().join('\0'));
  const exited = child => new Promise(resolve => {
    child.on('error', error => {
      console.error(error.message);
      resolve(1);
    });
    child.on('exit', code => resolve(code ?? 1));
  });
  return Promise.all([exited(archive), exited(container)]).then(([archiveCode, containerCode]) => {
    if (archiveCode !== 0) {
      console.error(`tar exited with status ${archiveCode}; the container did not receive the full checkout.`);
      return containerCode || archiveCode;
    }
    return containerCode;
  });
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { sourceFiles, containerUser, prepareOutput };
