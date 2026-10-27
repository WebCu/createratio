'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const screenshotIds = ['01-websites', '02-intention', '03-creation-score'];
const announcementPattern = /<aside\b[^>]*\bdata-release-announcement[\s\S]*?<\/aside>/g;
const linkPattern = /(<a\b[^>]*\bdata-release-link[^>]*>)[\s\S]*?(<\/a>)/g;

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function readRelease(filename = path.join(root, 'marketing/release.json')) {
  const release = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const fields = ['headline', 'summary', 'activation', 'shortDescription', 'socialPost'];
  if (fields.some(field => typeof release[field] !== 'string' || !release[field].trim())) throw new Error('Release copy requires a headline, summary, activation, shortDescription and socialPost.');
  if (release.shortDescription.length > 132) throw new Error('The Chrome short description must be at most 132 characters.');
  if (!Array.isArray(release.description) || !release.description.length || release.description.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Release description must contain nonempty paragraphs.');
  if (!Array.isArray(release.screenshots) || release.screenshots.length !== screenshotIds.length || release.screenshots.some((shot, index) => shot.id !== screenshotIds[index] || typeof shot.caption !== 'string' || !shot.caption.trim())) throw new Error('Release screenshots must describe websites, intention and creation-score captures in order.');
  return release;
}

function renderAnnouncement(release) {
  return `<aside class="release-note" id="latest" aria-labelledby="release-title" data-release-announcement>
        <h2 id="release-title">${escapeHTML(release.headline)}</h2>
        <div><p>${escapeHTML(release.summary)}</p><p>${escapeHTML(release.activation)}</p><a href="#install">Get CreateRatio</a></div>
      </aside>`;
}

function syncWebsite(html, release) {
  if ([...html.matchAll(announcementPattern)].length !== 1 || [...html.matchAll(linkPattern)].length !== 1) throw new Error('The website must contain exactly one release announcement and opening link.');
  return html.replace(announcementPattern, () => renderAnnouncement(release))
    .replace(linkPattern, (_, start, end) => start + escapeHTML(release.headline) + end);
}

function assertWebsiteCurrent(html, release = readRelease()) {
  if (syncWebsite(html, release) !== html) throw new Error('Website announcement is out of date. Run pnpm marketing:copy, then rebuild.');
}

function writeKit(output, release) {
  fs.mkdirSync(output, { recursive: true });
  fs.rmSync(path.join(output, 'screenshots'), { recursive: true, force: true });
  const files = {
    'store-short-description.txt': release.shortDescription + '\n',
    'store-description.txt': release.description.join('\n\n') + '\n',
    'social-post.txt': release.socialPost + '\n',
    'release-notes.txt': [release.headline, release.summary, release.activation].join('\n\n') + '\n',
    'screenshots.json': JSON.stringify(release.screenshots, null, 2) + '\n',
    'README.md': '# CreateRatio listing kit\n\nGenerated copy is a draft for review, not a publication.\n\n- Paste `store-short-description.txt` and `store-description.txt` into each listing.\n- Use `release-notes.txt` for what changed and `social-post.txt` for an announcement.\n- Run `pnpm marketing:assets` for fresh 1280 × 800 PNGs of the actual Chrome build.\n- Review every image and caption in `screenshots.json`; all activity is synthetic.\n- Chrome and Firefox listing edits are separate, manual, approved actions. Chrome captures do not establish Firefox compatibility.\n- See `docs/marketing.md` for regeneration and publication checks.\n'
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(output, name), content);
  return files;
}

function releaseFingerprint(release) {
  return createHash('sha256').update(JSON.stringify(release)).digest('hex');
}

function prepareKit() {
  const release = readRelease();
  const filename = path.join(root, 'site/index.html');
  const html = fs.readFileSync(filename, 'utf8');
  const updated = syncWebsite(html, release);
  if (updated !== html) fs.writeFileSync(filename, updated);
  const output = path.join(root, 'dist/marketing');
  writeKit(output, release);
  console.log(`Website announcement synchronized. Listing copy: ${output}`);
}

if (require.main === module) prepareKit();
module.exports = { readRelease, escapeHTML, renderAnnouncement, syncWebsite, assertWebsiteCurrent, writeKit, releaseFingerprint };
