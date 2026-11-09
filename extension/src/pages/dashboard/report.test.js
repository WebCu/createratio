'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./report.js');

test('reports select local calendar dates and compute the period score from combined totals', () => {
  const now = new Date(2026, 2, 9, 12);
  const days = {
    '2026-03-02': { x: { createSec: 99999 } },
    '2026-03-03': { x: { createSec: 120, consumeSec: 60, posts: 1, quotes: 1 } },
    '2026-03-09': { x: { consumeSec: 180, replies: 1, likes: 4 }, retired: { createSec: 60, comments: 1, bookmarks: 2, reposts: 3 } },
    '2026-03-10': { x: { createSec: 99999 } },
    _intentions: [{ reason: 'Private intention text' }],
    _websiteTime: { '2026-03-09': { 'private.example': 99999 } }
  };
  const before = structuredClone(days);
  const week = create(days, 'week', now);
  assert.equal(week.filename, 'CreateRatio-report-2026-03-03-to-2026-03-09.html');
  assert.match(week.html, /Last 7 days/);
  assert.match(week.html, /<dt>Creating<\/dt><dd>3\.0m<\/dd>/);
  assert.match(week.html, /<dt>Consuming<\/dt><dd>4\.0m<\/dd>/);
  assert.match(week.html, /<dt>Period creation score<\/dt><dd>2\.25<\/dd>/);
  assert.match(week.html, /retired \(unavailable\)/);
  for (const [label, value] of [['Posts', 1], ['Replies', 1], ['Comments', 1], ['Likes', 4], ['Reposts', 3], ['Bookmarks', 2], ['Quotes \(included in posts\)', 1]]) {
    assert.ok(week.html.includes(`<dt>${label}</dt><dd>${value}</dd>`));
  }
  assert.match(week.html, /<th scope="row">2026-03-04<\/th><td>0\.0m<\/td><td>0\.0m<\/td><td>0\.00<\/td>/);
  assert.doesNotMatch(week.html, /2026-03-02|2026-03-10|99999|Private intention text|private\.example/);
  const today = create(days, 'today', now);
  assert.equal(today.filename, 'CreateRatio-report-2026-03-09.html');
  assert.match(today.html, /<dt>Period creation score<\/dt><dd>1\.67<\/dd>/);
  assert.match(today.html, /<dt>Creating<\/dt><dd>1\.0m<\/dd>/);
  assert.doesNotMatch(today.html, /2026-03-03/);
  assert.deepEqual(days, before);
});

test('empty reports show zero totals and no recorded activity; invalid ranges fail', () => {
  const report = create({}, 'today', new Date(2026, 0, 1, 12));
  assert.match(report.html, /No creation tracking recorded in this period/);
  assert.match(report.html, /<dt>Period creation score<\/dt><dd>0\.00<\/dd>/);
  assert.match(report.html, /2026-01-01/);
  assert.throws(() => create({}, 'month'), /Choose Today or Last 7 days/);
});

test('seven-day reports cross year boundaries using local calendar days', () => {
  const report = create({}, 'week', new Date(2026, 0, 1, 0, 15));
  assert.equal(report.filename, 'CreateRatio-report-2025-12-26-to-2026-01-01.html');
  for (const date of ['2025-12-26', '2025-12-31', '2026-01-01']) assert.ok(report.html.includes(`<th scope="row">${date}</th>`));
});

test('reports escape restored labels, normalize stats and include no executable or remote content', () => {
  const report = create({ '2026-01-01': { x: { createSec: '600', consumeSec: -1, posts: NaN }, '<img src=x onerror=alert(1)>': { posts: 99 } } }, 'today', new Date(2026, 0, 1));
  assert.match(report.html, /0\.0m/);
  assert.doesNotMatch(report.html, /<script|<img|<link|onerror|NaN|Infinity|https?:\/\//);
  assert.match(report.html, /Content-Security-Policy/);
});
