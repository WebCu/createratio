'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const usage = 'Usage: pnpm browser:container <command> [arguments...]';
const imageUser = 1000;

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

function prepareOutput(directory = path.join(root, 'dist/container'), { uid = process.getuid(), chown = fs.chownSync } = {}) {
  const created = !fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true });
  if (uid === 0) {
    if (created) chown(directory, imageUser, imageUser);
    return directory;
  }
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    throw new Error(`${directory} is not writable, so the container cannot export browser evidence. Fix its owner or remove it.`);
  }
  return directory;
}

function stream(files, [program, ...args], { cwd = root } = {}) {
  const archive = spawn('tar', ['--null', '-T', '-', '--no-xattrs', '--no-acls', '-cf', '-'], {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const consumer = spawn(program, args, { cwd, stdio: [archive.stdout, 'inherit', 'inherit'] });
  archive.stdout.destroy();
  archive.stdin.on('error', error => {
    if (error.code !== 'EPIPE') console.error(`Could not send the file list to tar: ${error.message}`);
  });
  archive.stdin.end(files.join('\0'));
  const exited = child => new Promise(resolve => {
    child.on('error', error => {
      console.error(error.message);
      resolve(1);
    });
    child.on('exit', code => resolve(code ?? 1));
  });
  return Promise.all([exited(archive), exited(consumer)]).then(([archiveCode, consumerCode]) => {
    if (consumerCode !== 0) return consumerCode;
    if (archiveCode !== 0) {
      console.error(`tar exited with status ${archiveCode}; the container did not receive the full checkout.`);
      return archiveCode;
    }
    return 0;
  });
}

function run(command) {
  if (!command.length) {
    console.error(usage);
    return Promise.resolve(2);
  }
  prepareOutput();
  return stream(sourceFiles(), ['docker', 'compose', 'run', '--rm', '-T', ...containerUser(), 'browser-tests', ...command]);
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { sourceFiles, containerUser, prepareOutput, stream };
