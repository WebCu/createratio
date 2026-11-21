'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, workerData } = require('node:worker_threads');
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

const TYPE_TAG_NAMES = { type: /^$/, satisfies: /^$/, returns: /^$/, param: /^\[?[A-Za-z_$][\w$.]*\]?$/, typedef: /^[A-Za-z_$][\w$]*$/ };

function typeTagLine(line) {
  const template = /^@template [A-Za-z_$][\w$]*$/.test(line);
  const tag = /^@(\w+) \{/.exec(line);
  if (template || !tag || !Object.hasOwn(TYPE_TAG_NAMES, tag[1])) return template;
  let depth = 0, quote = '';
  for (let index = tag[0].length - 1; index < line.length; index++) {
    if (quote) {
      if (line[index] === '\\') index++;
      else if (line[index] === quote) quote = '';
    } else if (`'"\``.includes(line[index])) quote = line[index];
    else if (line[index] === '{') depth++;
    else if (line[index] === '}' && --depth === 0) return TYPE_TAG_NAMES[tag[1]].test(line.slice(index + 1).trim());
  }
  return false;
}

function typeCheckedFile(file) {
  const real = realpathSync(file);
  for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
    const config = path.join(directory, 'tsconfig.json');
    if (existsSync(config)) {
      const { include = [], exclude = [] } = JSON.parse(readFileSync(config, 'utf8'));
      const relative = path.relative(directory, real).split(path.sep).join('/');
      return include.some(pattern => path.matchesGlob(relative, pattern)) && !exclude.some(pattern => path.matchesGlob(relative, pattern));
    }
    if (path.dirname(directory) === directory) return false;
  }
}

function typeAnnotation(comment) {
  if (comment.type !== 'Block' || !comment.value.startsWith('*')) return false;
  const lines = comment.value.slice(1).split(/\r?\n/).map(line => line.replace(/^\s*\*?\s*/, '').trim()).filter(Boolean);
  return lines.length > 0 && lines.every(typeTagLine);
}

function codeComments(file) {
  const source = readFileSync(file, 'utf8');
  const extension = path.extname(file);
  const type = extension === '.js' ? packageType(file) : undefined;
  let sourceType = extension === '.mjs' || type === 'module' ? 'module' : 'commonjs';
  if (extension === '.js' && !['module', 'commonjs'].includes(type)) {
    const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], { input: source, encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    if (![0, 1].includes(result.status)) throw new Error(`Module detection failed: ${file}\n${result.stderr}`);
    sourceType = result.status === 0 ? 'commonjs' : 'module';
  }
  const comments = [];
  try {
    parse(source, { ecmaVersion: 'latest', sourceType, locations: true, onComment: comments });
  } catch (error) {
    throw new Error(`Comment parse failed: ${file}\n${error.message}`);
  }
  const typed = typeCheckedFile(file);
  return comments.filter(comment => !(comment.start === 0 && source.startsWith('#!')) && !(typed && typeAnnotation(comment)));
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

async function checkSyntaxParallel(files) {
  if (files.length < 2) return checkSyntax(files);
  const groups = Array.from({ length: Math.min(4, files.length) }, () => []);
  files.forEach((file, index) => groups[index % groups.length].push(file));
  const workers = groups.map(group => new Worker(__filename, { workerData: group }));
  try {
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Syntax worker exited ${code}`)));
    })));
    return files.length;
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

async function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const inventory = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' });
  const files = [...new Set(inventory.split('\0').filter(Boolean))].sort().map(file => path.join(root, file)).filter(file => existsSync(file));
  console.log(`${await checkSyntaxParallel(files)} JavaScript syntax checks passed; no code comments outside JSDoc type annotations.`);
}

if (require.main === module) {
  if (!isMainThread) checkSyntax(workerData);
  else main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkSyntax, checkSyntaxParallel };
