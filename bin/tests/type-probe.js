const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function typeCheck(t, sources) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'createratio-type-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = Object.entries(sources).map(([name, source]) => {
    fs.writeFileSync(path.join(directory, name), source);
    return name;
  });
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    files: ['globals.d.ts', 'messages.d.ts'].map(name => path.join(root, 'extension', 'types', name)).concat(files),
    include: []
  }));
  return spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: directory, encoding: 'utf8' });
}

module.exports = { typeCheck };
