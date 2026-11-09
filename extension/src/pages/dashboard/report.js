(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../../core/core.js') : root.C3);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CreationReport = api;
})(globalThis, function (C3) {
  'use strict';
  function escape(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function minutes(seconds) { return (seconds / 60).toFixed(1) + 'm'; }
  function row(label, stats) { return `<tr><th scope="row">${escape(label)}</th><td>${minutes(stats.createSec)}</td><td>${minutes(stats.consumeSec)}</td><td>${C3.score(stats).toFixed(2)}</td></tr>`; }
  function table(caption, heading, rows) { return `<table><caption>${caption}</caption><thead><tr><th scope="col">${heading}</th><th scope="col">Creating</th><th scope="col">Consuming</th><th scope="col">Score</th></tr></thead><tbody>${rows}</tbody></table>`; }
  function summarize(days, range, now = new Date()) {
    if (!['today', 'week'].includes(range)) throw new Error('Choose Today or Last 7 days.');
    const dates = C3.recentDates(range === 'today' ? 1 : 7, now), first = dates[0], last = dates.at(-1);
    const bySite = Object.create(null);
    for (const date of dates) for (const site of C3.recordedSites(days[date])) {
      const stats = C3.statsSnapshot(days[date][site]);
      bySite[site] ||= C3.emptyStats();
      for (const key of C3.FIELDS) bySite[site][key] += stats[key];
    }
    return { dates, first, last, bySite, total: C3.aggregate(bySite) };
  }
  function create(days, range, now = new Date()) {
    const { dates, first, last, bySite, total } = summarize(days, range, now);
    const names = new Map(C3.SITES.map(site => [site.id, site.name]));
    const hasActivity = C3.FIELDS.some(key => total[key] > 0);
    const title = range === 'today' ? 'Today' : 'Last 7 days';
    const period = first === last ? last : `${first} to ${last}`;
    const actions = [['Posts', 'posts'], ['Replies', 'replies'], ['Comments', 'comments'], ['Likes', 'likes'], ['Reposts', 'reposts'], ['Bookmarks', 'bookmarks'], ['Quotes (included in posts)', 'quotes']];
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>CreateRatio report — ${escape(period)}</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{max-width:800px;margin:0 auto;padding:40px 28px;background:#fff;color:#30263f;font:15px/1.6 system-ui,sans-serif}header{border-bottom:2px solid #6043b5;padding-bottom:24px}header strong{color:#6043b5}h1{font-size:32px;line-height:1.2;margin:20px 0 10px}h2{font-size:18px;margin:28px 0 12px}p{margin:8px 0;color:#62596f}dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:24px 0}dt{font-size:13px;color:#62596f}dd{margin:4px 0 0;font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}.summary{padding:20px;background:#e7f1e4;border-radius:10px}.summary dd{color:#16804a}.actions dd{font-size:22px}table{border-collapse:collapse;width:100%;margin:28px 0;font-size:14px;font-variant-numeric:tabular-nums;table-layout:fixed}caption{text-align:left;font-size:18px;font-weight:700;margin-bottom:12px}th,td{text-align:right;padding:10px 6px;border-bottom:1px solid #d9d5e4;overflow-wrap:anywhere}th:first-child{text-align:left;width:34%}thead th{font-size:12px;color:#62596f}tbody th{font-weight:500}.notes{border-top:1px solid #d9d5e4;margin-top:28px;padding-top:16px;font-size:12px}.print-note{font-size:12px}@media(max-width:480px){body{padding:24px 16px}h1{font-size:28px}dl{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.summary{padding:16px}dd{font-size:24px}table{font-size:12px}th,td{padding:10px 4px}}@media print{body{max-width:none;padding:0;font-size:11pt}.print-note{display:none}tr,dl{break-inside:avoid}thead{display:table-header-group}caption{break-after:avoid}}
</style></head><body>
<header><strong>CreateRatio</strong><h1>Creation report</h1><p>${title} · ${escape(period)}</p><p class="print-note">Open this file in your browser. Use Print to print or save as PDF.</p></header>
<main><dl class="summary"><div><dt>Creating</dt><dd>${minutes(total.createSec)}</dd></div><div><dt>Consuming</dt><dd>${minutes(total.consumeSec)}</dd></div><div><dt>Period creation score</dt><dd>${C3.score(total).toFixed(2)}</dd></div></dl>
${hasActivity ? '' : '<p>No creation tracking recorded in this period.</p>'}
<h2>Actions</h2><dl class="actions">${actions.map(([label, key]) => `<div><dt>${label}</dt><dd>${total[key]}</dd></div>`).join('')}</dl>
${table('By site', 'Site', Object.keys(bySite).sort().map(site => row(names.get(site) || `${site} (unavailable)`, bySite[site])).join(''))}
${table('Daily breakdown', 'Local date', dates.map(date => row(date, C3.aggregate(days[date]))).join(''))}
</main><footer class="notes"><p>Score = (creating seconds + 120 seconds per post, reply or comment) ÷ consuming seconds (minimum 1 second). The period score uses combined totals, not an average of daily scores. Quotes are included in posts; other light actions add no score credit.</p><p>Dates use your device’s local calendar. Today is partial. Missing days show zero; cleared or expired history cannot be recovered. Times are rounded to one decimal minute; scores use unrounded seconds.</p><p>Creation tracking covers enabled vetted sites only. Website time is separate and is not included. Saved intentions are never included.</p><p>Generated locally on ${escape(now.toLocaleString())}. No data was uploaded.</p></footer>
</body></html>`;
    return { html, filename: `CreateRatio-report-${first}${first === last ? '' : '-to-' + last}.html` };
  }
  return { create, summarize };
});
