'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(extensionAPI.runtime);
const $ = id => document.getElementById(id);
let intentions = [], intentionHistoryEnabled = false, activeView = 'ratio', refreshing = false, refreshPending = false, websiteTimeEnabled = false;
let reportURL = null, reportTimer = null, shareURL = null, shareCard = null, shareVersion = 0, reportVersion = 0;
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function minutes(sec) { return (sec / 60).toFixed(1) + 'm'; }
function svgElement(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text; return node;
}
function chart(days) {
  const dates = C3.recentDates();
  const totals = dates.map(date => C3.aggregate(days[date]));
  const max = Math.max(1, ...totals.flatMap(s => [s.consumeSec / 60, s.createSec / 60]));
  const top = Math.ceil(max / 5) * 5;
  const svg = $('chart');
  while (svg.children.length > 2) svg.lastChild.remove();
  $('chart-desc').textContent = dates.map((date, i) => `${date}: ${minutes(totals[i].createSec)} creating, ${minutes(totals[i].consumeSec)} consuming`).join('; ');
  for (let i = 0; i <= 2; i++) {
    const y = 112 - i * 46;
    svg.append(svgElement('line', { x1: 28, x2: 350, y1: y, y2: y, stroke: 'var(--line)' }));
    svg.append(svgElement('text', { x: 23, y: y + 3, 'text-anchor': 'end' }, String(Math.round(top * i / 2))));
  }
  const tbody = $('chart-table').querySelector('tbody'); tbody.replaceChildren();
  dates.forEach((date, i) => {
    const x = 34 + i * 45;
    for (const [j, key, color] of [[0, 'createSec', 'var(--green)'], [1, 'consumeSec', 'var(--consume)']]) {
      const height = totals[i][key] / 60 / top * 92;
      const bar = svgElement('rect', { x: x + j * 13, y: 112 - height, width: 10, height, rx: 2, fill: color });
      bar.append(svgElement('title', {}, `${date}: ${minutes(totals[i][key])} ${j === 0 ? 'creating' : 'consuming'}`)); svg.append(bar);
    }
    const d = new Date(date + 'T12:00:00');
    svg.append(svgElement('text', { x: x + 11, y: 132, 'text-anchor': 'middle', 'font-weight': i === 6 ? 700 : 400 }, i === 6 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })));
    const row = document.createElement('tr');
    for (const value of [date, (totals[i].createSec / 60).toFixed(2), (totals[i].consumeSec / 60).toFixed(2)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    tbody.append(row);
  });
}
function renderWebsites(days) {
  const rows = WebTime.summarize(days);
  const total = rows.reduce((sum, [, sec]) => sum + sec, 0);
  $('website-total').textContent = WebTime.duration(total);
  $('website-count').textContent = `${rows.length} website${rows.length === 1 ? '' : 's'}`;
  $('website-status').textContent = websiteTimeEnabled ? 'Website time is on. Updates every few seconds.' : 'Website time is off. Previously recorded browsing time is kept.';
  $('website-empty').hidden = rows.length > 0;
  $('website-empty').textContent = websiteTimeEnabled ? 'No time in this period yet. Use a website to start.' : 'Enable Website time in Settings to record browsing time across all sites.';
  $('website-sites').replaceChildren();
  for (const [domain, sec] of rows) {
    const row = document.createElement('tr'), name = document.createElement('td'), time = document.createElement('td'), share = document.createElement('td');
    name.textContent = domain;
    const bar = document.createElement('span'); bar.style.width = `${sec / total * 100}%`; bar.setAttribute('aria-hidden', 'true'); name.append(bar);
    time.textContent = WebTime.duration(sec); share.textContent = `${Math.round(sec / total * 100)}%`;
    row.append(name, time, share); $('website-sites').append(row);
  }
  $('website-export').disabled = false;
}
function renderIntentions() {
  const entries = intentions;
  $('intention-status').textContent = intentionHistoryEnabled ? 'Saving is on. Intentions stay on this device.' : 'Saving is off. Existing intentions are kept.';
  $('intention-empty').hidden = entries.length > 0;
  $('intention-clear').disabled = entries.length === 0;
  $('intention-list').replaceChildren();
  const names = new Map(C3.SITES.map(site => [site.id, site.name]));
  for (const entry of [...entries].reverse()) {
    const item = document.createElement('li'), meta = document.createElement('div'), reason = document.createElement('p');
    meta.textContent = `${names.get(entry.site) || entry.site} · ${new Date(entry.requestedAt).toLocaleString()}`;
    reason.textContent = entry.reason;
    item.append(meta, reason); $('intention-list').append(item);
  }
}
function renderRatio(days) {
  const today = C3.localDate(), day = days[today] || {}, total = C3.aggregate(day), score = C3.score(total);
  const hasActivity = ['createSec', 'consumeSec', 'posts', 'replies', 'comments'].some(key => total[key] > 0);
  $('date').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); $('date').dateTime = today;
  $('score').textContent = score.toFixed(2); $('score').style.color = hasActivity ? C3.scoreColor(score) : '';
  $('score-status').textContent = !hasActivity ? 'A fresh start. Make something today.' : score >= 1 ? 'You’re making more than you’re taking in.' : score >= 0.5 ? 'A little more creating gets you to 1.0.' : 'One thoughtful reply is a great start.';
  $('create-min').textContent = minutes(total.createSec); $('consume-min').textContent = minutes(total.consumeSec);
  for (const key of ['posts', 'replies', 'comments', 'likes', 'quotes', 'reposts', 'bookmarks']) $(key).textContent = total[key];
  $('sites').replaceChildren();
  const names = new Map(C3.SITES.map(site => [site.id, site.name]));
  for (const site of new Set([...names.keys(), ...C3.recordedSites(day)])) {
    const name = names.get(site) || site + ' (unavailable)';
    const s = { ...C3.emptyStats(), ...day[site] }, row = document.createElement('tr');
    for (const value of [name, minutes(s.createSec), minutes(s.consumeSec), C3.score(s).toFixed(2)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    $('sites').append(row);
  }
  $('export').disabled = false; chart(days);
}
async function refresh(requested = false) {
  if (refreshing) { if (requested) refreshPending = true; return; } refreshing = true;
  try {
    const snapshot = await messages.send({ type: 'snapshot' }, 'Unable to load your data.');
    websiteTimeEnabled = snapshot.websiteTimeEnabled;
    intentionHistoryEnabled = snapshot.settings.intentionHistoryEnabled === true;
    const view = activeView;
    const result = await messages.send(view === 'intentions' ? { type: 'access-history-list' } : { type: 'history', kind: view === 'ratio' ? 'ratio' : 'websites', range: view === 'ratio' ? 'week' : $('website-range').value }, 'Unable to load history.');
    if (view === activeView) {
      if (view === 'ratio') { intentions = []; renderRatio(result.days); }
      else if (view === 'websites') { intentions = []; renderWebsites(result.days); }
      else { intentions = result.intentions; renderIntentions(); }
    }
    error();
  } catch (e) { error(e.message); } finally { refreshing = false; if (refreshPending) { refreshPending = false; void refresh(); } }
}
for (const view of ['ratio', 'websites', 'intentions']) $(view + '-view').addEventListener('click', () => {
  for (const panel of ['ratio', 'websites', 'intentions']) {
    $(panel + '-panel').hidden = panel !== view;
    $(panel + '-view').setAttribute('aria-pressed', String(panel === view));
  }
  $('export').hidden = view !== 'ratio'; activeView = view; void refresh(true);
});
$('intention-clear').addEventListener('click', async () => {
  if (!confirm('Delete all saved intentions? This cannot be undone.')) return;
  $('intention-clear').disabled = true;
  try {
    await messages.send({ type: 'access-history-clear' }, 'Unable to clear intention history.');
    await refresh(true);
  } catch (e) { error(e.message); }
  finally { $('intention-clear').disabled = !intentions.length; }
});
$('website-range').addEventListener('change', () => { void refresh(true); });
async function exportHistory(kind) {
  const websites = kind === 'websites';
  const failure = websites ? 'Unable to export website time.' : 'Unable to export history.';
  try {
    if (websites) {
      await messages.send({ type: 'snapshot' }, failure);
    }
    const data = await messages.send({ type: 'history', kind, range: 'month' }, failure);
    const csv = websites ? WebTime.csv(data.days) : C3.csv(data.days);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `CreateRatio${websites ? '-websites' : ''}-${C3.localDate()}.csv`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); error();
  } catch (e) { error(e.message); }
}
function clearShareCard() {
  shareVersion++;
  if (shareURL) URL.revokeObjectURL(shareURL);
  shareURL = null; shareCard = null;
  $('share-preview').width = 0; $('share-preview').height = 0;
  $('share-preview').removeAttribute('aria-label');
  $('share-result').hidden = true; $('share-caption').value = '';
  $('share-download').disabled = true; $('share-copy').disabled = true;
  $('share-status').textContent = '';
}
$('report-range').addEventListener('change', clearShareCard);
$('share-create').addEventListener('click', async () => {
  const button = $('share-create');
  if (button.disabled) return;
  clearShareCard();
  const version = shareVersion, range = $('report-range').value;
  button.disabled = true;
  try {
    const now = new Date(), date = C3.localDate(now);
    const data = await messages.send({ type: 'history', kind: 'ratio', range }, 'Unable to create share card.');
    if (version !== shareVersion) return;
    if (C3.localDate() !== date) throw new Error('The local date changed while loading history. Please try again.');
    const card = SocialCard.create(data.days, range, now), canvas = $('share-preview');
    SocialCard.draw(canvas, card);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to create the PNG. Try the detailed report.')), 'image/png'));
    if (version !== shareVersion) return;
    shareURL = URL.createObjectURL(blob); shareCard = card;
    canvas.setAttribute('aria-label', card.description);
    $('share-caption').value = card.caption; $('share-result').hidden = false;
    $('share-download').disabled = false; $('share-copy').disabled = false;
    error(); $('share-status').textContent = 'Your card is ready. Review it before sharing.';
  } catch (e) { if (version === shareVersion) { clearShareCard(); error(e.message); } }
  finally { button.disabled = false; }
});
$('share-download').addEventListener('click', () => {
  if (!shareCard || !shareURL) return;
  const link = document.createElement('a'); link.href = shareURL;
  link.download = shareCard.filename; document.body.append(link); link.click(); link.remove();
  $('share-status').textContent = 'PNG download started. Attach it to your post and include the caption link.';
});
$('share-copy').addEventListener('click', async () => {
  if (!shareCard) return;
  const caption = $('share-caption').value, version = shareVersion;
  try {
    await navigator.clipboard.writeText(caption);
    if (version === shareVersion) $('share-status').textContent = 'Caption copied. Paste it alongside your image.';
  } catch (_) {
    if (version !== shareVersion) return;
    $('share-caption').focus(); $('share-caption').select();
    $('share-status').textContent = 'Clipboard unavailable. The caption is selected; copy it manually.';
  }
});
$('report-export').addEventListener('click', async () => {
  const button = $('report-export');
  if (button.disabled) return;
  const range = $('report-range').value, version = reportVersion;
  button.disabled = true; $('report-status').textContent = '';
  try {
    const now = new Date(), date = C3.localDate(now);
    const data = await messages.send({ type: 'history', kind: 'ratio', range }, 'Unable to export report.');
    if (version !== reportVersion) throw new Error('History changed while loading. Please try again.');
    if (C3.localDate() !== date) throw new Error('The local date changed while loading history. Please try again.');
    const report = CreationReport.create(data.days, range, now);
    clearTimeout(reportTimer);
    if (reportURL) URL.revokeObjectURL(reportURL);
    reportURL = URL.createObjectURL(new Blob([report.html], { type: 'text/html;charset=utf-8' }));
    reportTimer = setTimeout(() => { URL.revokeObjectURL(reportURL); reportURL = null; reportTimer = null; }, 10000);
    const link = document.createElement('a'); link.href = reportURL;
    link.download = report.filename; document.body.append(link); link.click(); link.remove();
    error(); $('report-status').textContent = 'Report download started. Open the HTML file to review, print, or save as PDF.';
  } catch (e) { error(e.message); }
  finally { button.disabled = false; }
});
$('website-export').addEventListener('click', () => exportHistory('websites'));
$('export').addEventListener('click', () => exportHistory('ratio'));
extensionAPI.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, '_historyReset')) { reportVersion++; clearShareCard(); }
  if (RuntimeMessages.shouldRefresh(changes, area)) void refresh();
});
setInterval(refresh, 5000);
void refresh();
