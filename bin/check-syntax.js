'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');

function packageType(file) {
  let directory = path.dirname(realpathSync(file));
  while (path.basename(directory) !== 'node_modules') {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).type;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function codeComments(file) {
  const source = readFileSync(file, 'utf8');
  const extension = path.extname(file);
  const type = extension === '.js' ? packageType(file) : undefined;
  const sourceTypes = extension === '.mjs' || type === 'module' ? ['module'] :
    extension === '.cjs' || type === 'commonjs' ? ['commonjs'] : ['commonjs', 'module'];
  let failure;
  for (const sourceType of sourceTypes) {
    const comments = [];
    try {
      parse(source, { ecmaVersion: 'latest', sourceType, locations: true, onComment: comments });
      return comments.filter(comment => !(comment.start === 0 && source.startsWith('#!')));
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`Comment parse failed: ${file}\n${failure.message}`);
}

function checkSyntax(files) {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Syntax check failed: ${file}\n${result.stderr || result.stdout}`);
    const comments = codeComments(file);
    if (comments.length) {
      const locations = comments.map(comment => `${file}:${comment.loc.start.line}:${comment.loc.start.column + 1}`);
      throw new Error(`Code comments are not allowed:\n${locations.join('\n')}`);
    }
  }
  return files.length;
}

if (require.main === module) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const inventory = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' });
    const files = [...new Set(inventory.split('\0').filter(Boolean))].sort().map(file => path.join(root, file)).filter(file => existsSync(file));
    console.log(`${checkSyntax(files)} JavaScript syntax checks passed; no code comments.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkSyntax };
