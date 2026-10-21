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
    const headline = total.createSec > total.consumeSec ? ['More making.', 'Less scrolling.']
      : total.createSec > 0 ? ['A little creating', 'counts, too.']
      : contributions > 0 ? ['Small actions.', 'Real contributions.']
      : C3.FIELDS.some(key => total[key] > 0) ? ['Make room', 'for making.'] : ['A fresh start.', 'Room to create.'];
    const creating = time(total.createSec), consuming = time(total.consumeSec), score = C3.score(total).toFixed(2);
    const label = range === 'today' ? 'Today so far' : 'Last 7 days';
    const period = first === last ? last : `${first} – ${last}`;
    const caption = `${headline.join(' ')}\n\n${label}: ${creating} creating · ${consuming} consuming · ${contributions} posts/replies/comments.\nCreation score: ${score} (includes action credits). Tracked sites only.\n\nCreate more, consume intentionally: ${URL}`;
    return { headline, creating, consuming, contributions, score, label, period, url: URL, caption,
      creatingShare: total.createSec / Math.max(1, total.createSec + total.consumeSec),
      description: `${headline.join(' ')} ${label}, ${period}. ${creating} creating, ${consuming} consuming. ${contributions} posts, replies and comments. Creation score ${score}, including action credits. Tracked sites only. CreateRatio: ${URL}`,
      filename: `CreateRatio-share-${first}${first === last ? '' : '-to-' + last}.png` };
  }
  function draw(canvas, card) {
    canvas.width = 1200; canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to draw the share card. Try downloading the detailed report.');
    const ink = '#30263f', muted = '#62596f', violet = '#6043b5', green = '#16804a', line = '#d9d5e4';
    const text = (value, x, y, size, color = ink, weight = 500, width = 1056, align = 'left') => {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.font = `${weight} ${size}px system-ui, sans-serif`;
      while (ctx.measureText(String(value)).width > width && size > 20) { size--; ctx.font = `${weight} ${size}px system-ui, sans-serif`; }
      ctx.fillText(String(value), x, y, width);
    };
    const box = (x, y, width, height, color, radius = 0) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
    };
    box(0, 0, 1200, 1200, violet);
    box(72, 64, 56, 56, '#ffffff', 14);
    ctx.strokeStyle = violet; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(89, 80); ctx.lineTo(111, 92); ctx.lineTo(89, 104); ctx.stroke();
    text('CreateRatio', 146, 106, 36, '#ffffff', 750, 430);
    text(card.label, 1128, 85, 28, '#ffffff', 600, 480, 'right');
    text(card.period, 1128, 124, 24, '#ffffff', 500, 480, 'right');
    text(card.headline[0], 72, 269, 96, '#ffffff', 800);
    text(card.headline[1], 72, 379, 96, '#ffffff', 800);
    box(48, 438, 1104, 540, '#ffffff', 28);
    text(card.creating, 88, 575, 108, green, 750, 480);
    text(card.consuming, 660, 575, 108, ink, 750, 452);
    text('creating', 92, 626, 34, green, 600, 480);
    text('consuming', 664, 626, 34, muted, 600, 448);
    box(88, 661, 1024, 16, line, 8);
    if (card.creatingShare > 0) box(88, 661, 1024 * card.creatingShare, 16, green, Math.min(8, 512 * card.creatingShare));
    text(card.contributions, 88, 760, 58, ink, 700, 480);
    text('posts, replies & comments', 90, 805, 30, muted, 500, 478);
    text(card.score, 660, 760, 58, violet, 700, 452);
    text('creation score', 664, 805, 30, muted, 500, 448);
    text('Score includes +2m per post, reply or comment.', 88, 881, 27, muted, 500, 1024);
    text('Tracked sites only. Time is rounded. Today is partial.', 88, 925, 27, muted, 500, 1024);
    text('Create more. Consume intentionally.', 72, 1045, 34, '#ffffff', 600);
    text('createratio.com', 72, 1128, 46, '#ffffff', 750, 500);
    text('Free. Private. Try it for yourself.', 1128, 1128, 30, '#ffffff', 500, 540, 'right');
  }
  return { create, draw };
});
