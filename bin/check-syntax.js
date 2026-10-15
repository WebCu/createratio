'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

function checkSyntax(files) {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Syntax check failed: ${file}\n${result.stderr || result.stdout}`);
  }
  return files.length;
}

if (require.main === module) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const inventory = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' });
    const files = [...new Set(inventory.split('\0').filter(Boolean))].sort().map(file => path.join(root, file)).filter(file => existsSync(file));
    console.log(`${checkSyntax(files)} JavaScript syntax checks passed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkSyntax };
