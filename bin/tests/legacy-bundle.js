'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const PRE_RENAME_NAMES = { Core: 'C3', Sites: 'C3Sites', SITE_MODULES: 'C3_SITE_MODULES', PageQueries: 'C3_DOM' };

async function legacyBundle(bundle, destination) {
  await fs.cp(bundle, destination, { recursive: true });
  for (const file of (await fs.readdir(destination)).filter(name => name.endsWith('.js'))) {
    const source = await fs.readFile(path.join(destination, file), 'utf8');
    await fs.writeFile(path.join(destination, file), source.replace(/\b(Core|Sites|SITE_MODULES|PageQueries)\b/g, name => PRE_RENAME_NAMES[name]));
  }
  return destination;
}

module.exports = { legacyBundle };
