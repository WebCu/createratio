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
    const text = (value, x, y, size, color = ink, weight = 500, width = 1056) => {
      ctx.fillStyle = color;
      ctx.font = `${weight} ${size}px system-ui, sans-serif`;
      while (ctx.measureText(String(value)).width > width && size > 20) { size--; ctx.font = `${weight} ${size}px system-ui, sans-serif`; }
      ctx.fillText(String(value), x, y, width);
    };
    const box = (x, y, width, height, color, radius = 0) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
    };
    box(0, 0, 1200, 1200, '#f9f9fc');
    box(72, 64, 64, 64, violet, 16); text('>', 87, 113, 54, '#ffffff', 700, 44);
    text('CreateRatio', 154, 110, 40, ink, 750, 450);
    text(card.label, 72, 200, 30, muted, 600);
    text(card.period, 72, 244, 28, muted);
    text(card.headline[0], 72, 365, 86, ink, 800);
    text(card.headline[1], 72, 465, 86, violet, 800);
    text(card.creating, 72, 625, 104, green, 750, 480);
    text(card.consuming, 660, 625, 104, ink, 750, 468);
    text('creating', 76, 678, 38, green, 600, 480);
    text('consuming', 664, 678, 38, muted, 600, 464);
    box(72, 718, 1056, 22, line, 11);
    if (card.creatingShare > 0) box(72, 718, 1056 * card.creatingShare, 22, green, Math.min(11, 528 * card.creatingShare));
    text(`${card.contributions} posts, replies & comments`, 72, 817, 36, ink, 600, 730);
    text(card.score, 840, 817, 36, violet, 700, 288);
    text('creation score', 840, 871, 27, muted, 500, 288);
    text('Score includes +2m per post, reply or comment.', 72, 871, 27, muted, 500, 730);
    text('Tracked sites only. Time is rounded. Today is partial.', 72, 916, 27, muted);
    box(0, 974, 1200, 226, violet);
    text('Create more. Consume intentionally.', 72, 1046, 43, '#ffffff', 700);
    text('Free. Private. Try it for yourself.', 72, 1113, 32, '#ffffff', 500, 650);
    text('createratio.com', 72, 1170, 40, '#ffffff', 750, 1056);
  }
  return { create, draw };
});
