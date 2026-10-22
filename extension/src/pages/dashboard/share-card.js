(function (root, factory) {
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('../../../core/core.js') : root.C3, commonJS ? require('./report.js') : root.CreationReport);
  if (commonJS) module.exports = api;
  else root.SocialCard = api;
})(globalThis, function (C3, report) {
  'use strict';
  const URL = 'https://createratio.com/';
  function time(seconds) { return seconds > 0 && seconds < 60 ? `${Math.round(seconds)}s` : `${(seconds / 60).toFixed(1).replace(/\.0$/, '')}m`; }
  function create(days, range, now = new Date()) {
    const { first, last, total } = report.summarize(days, range, now);
    const contributions = total.posts + total.replies + total.comments;
    const headline = total.createSec > 0 || contributions > 0 ? ['Made room', 'for creating.']
      : C3.FIELDS.some(key => total[key] > 0) ? ['Make room', 'for creating.'] : ['A fresh start.', 'Room to create.'];
    const creating = time(total.createSec), consuming = time(total.consumeSec), score = C3.score(total).toFixed(2);
    const label = range === 'today' ? 'Today so far' : 'Last 7 days';
    const period = first === last ? last : `${first} – ${last}`;
    const caption = `${headline.join(' ')}\n\n${label}: ${creating} creating · ${consuming} consuming · ${contributions} detected post/reply/comment actions.\nCreation score: ${score} (approximate; includes action credits). Tracked sites only.\n\nCreate > Consume. Free and open source: ${URL}`;
    return { headline, creating, consuming, contributions, score, label, period, url: URL, caption,
      creatingShare: total.createSec / Math.max(1, total.createSec + total.consumeSec),
      consumingShare: total.consumeSec / Math.max(1, total.createSec + total.consumeSec),
      description: `${headline.join(' ')} ${label}, ${period}. ${creating} creating, ${consuming} consuming. ${contributions} detected post, reply and comment actions, not confirmed publications. Approximate creation score ${score}, including action credits. Tracked sites only. CreateRatio: ${URL}`,
      filename: `CreateRatio-share-${first}${first === last ? '' : '-to-' + last}.png` };
  }
  function draw(canvas, card) {
    canvas.width = 1200; canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to draw the share card. Try downloading the detailed report.');
    const ink = '#30263f', muted = '#62596f', violet = '#6043b5', line = '#88818f';
    const text = (value, x, y, size, color = ink, weight = 500, width = 1056, align = 'left') => {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.font = `${weight} ${size}px "Trebuchet MS", "DejaVu Sans", sans-serif`;
      while (ctx.measureText(String(value)).width > width && size > 20) { size--; ctx.font = `${weight} ${size}px "Trebuchet MS", "DejaVu Sans", sans-serif`; }
      ctx.fillText(String(value), x, y, width);
    };
    const box = (x, y, width, height, color, radius = 0) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
    };
    box(0, 0, 1200, 1200, '#f9f9fc');
    box(72, 64, 56, 56, violet, 16);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(89, 80); ctx.lineTo(111, 92); ctx.lineTo(89, 104); ctx.stroke();
    text('CreateRatio', 146, 110, 44, ink, 700, 430);
    text(card.label, 1128, 90, 36, muted, 600, 480, 'right');
    text(card.period, 1128, 140, 36, muted, 500, 560, 'right');
    text(card.headline[0], 72, 249, 88, ink, 700, 684);
    text(card.headline[1], 72, 349, 88, ink, 700, 684);
    box(808, 172, 320, 224, violet, 24);
    text(card.score, 968, 276, 112, '#ffffff', 700, 272, 'center');
    text('creation score', 968, 326, 36, '#ffffff', 500, 272, 'center');
    text('approximate', 968, 374, 36, '#ffffff', 500, 272, 'center');
    box(48, 408, 1104, 492, '#f0ecf9', 28);
    text(card.creating, 88, 522, 100, ink, 700, 452);
    text(card.consuming, 660, 522, 100, ink, 700, 452);
    text('creating', 92, 580, 40, muted, 500, 448);
    text('consuming', 664, 580, 40, muted, 500, 448);
    box(88, 738, 1024, 2, line);
    const largestShare = Math.max(card.creatingShare, card.consumingShare, Number.EPSILON);
    for (const [x, share, color] of [[88, card.creatingShare, violet], [660, card.consumingShare, '#8c7c9f']]) {
      const height = 140 * share / largestShare;
      if (height > 0) box(x, 740 - height, 452, height, color, Math.min(12, height / 2));
    }
    text(card.contributions, 88, 820, 60, ink, 700, 480);
    text('detected post / reply / comment actions', 90, 870, 40, muted, 500, 1022);
    text('Approximate score; +2m per detected submission.', 72, 962, 38, muted);
    text('Tracked sites only. Time is rounded. Today is partial.', 72, 1012, 38, muted);
    text('Create > Consume', 72, 1062, 40, violet, 700);
    text('createratio.com', 72, 1142, 48, violet, 700, 500);
    text('Free. Private. Open source.', 1128, 1142, 36, muted, 500, 540, 'right');
  }
  return { create, draw };
});
