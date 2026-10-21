'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./share-card.js');

test('social cards use the selected period and offer an honest hook and a public referral link', () => {
  const now = new Date(2026, 2, 9, 12);
  const days = {
    '2026-03-02': { older: { createSec: 99999 } },
    '2026-03-03': { retired: { createSec: 120, consumeSec: 60, posts: 1, quotes: 1 } },
    '2026-03-09': { x: { createSec: 60, consumeSec: 180, replies: 1, likes: 9 } },
    _intentions: [{ reason: 'Private intention text' }],
    _websiteTime: { '2026-03-09': { 'private.example': 99999 } }
  };
  const before = structuredClone(days), weekly = create(days, 'week', now), daily = create(days, 'today', now);
  assert.equal(weekly.filename, 'CreateRatio-share-2026-03-03-to-2026-03-09.png');
  assert.equal(weekly.creating, '3m'); assert.equal(weekly.consuming, '4m');
  assert.equal(weekly.score, '1.75'); assert.equal(weekly.contributions, 2);
  assert.equal(daily.creating, '1m'); assert.equal(daily.contributions, 1);
  assert.deepEqual(weekly.headline, ['A little creating', 'counts, too.']);
  assert.match(weekly.caption, /last 7 days/i);
  assert.match(daily.caption, /today so far/i);
  assert.match(weekly.caption, /https:\/\/createratio\.com\//);
  assert.equal(new URL(weekly.url).hostname, 'createratio.com');
  assert.match(weekly.caption, /Tracked sites only/);
  assert.doesNotMatch(JSON.stringify(weekly), /Private intention text|private\.example|retired|99999|2026-03-02/);
  assert.deepEqual(days, before);
});

test('headlines never claim more creating based on score credits or invent a trend', () => {
  const now = new Date(2026, 0, 1);
  const card = stats => create({ '2026-01-01': { x: stats } }, 'today', now);
  assert.deepEqual(card({ createSec: 180, consumeSec: 60 }).headline, ['More making.', 'Less scrolling.']);
  assert.deepEqual(card({ createSec: 60, consumeSec: 180, posts: 20 }).headline, ['A little creating', 'counts, too.']);
  assert.deepEqual(card({ posts: 1 }).headline, ['Small actions.', 'Real contributions.']);
  assert.deepEqual(card({ consumeSec: 300 }).headline, ['Make room', 'for making.']);
  assert.deepEqual(card({ likes: 3 }).headline, ['Make room', 'for making.']);
  assert.deepEqual(card({}).headline, ['A fresh start.', 'Room to create.']);
  assert.equal(card({}).score, '0.00');
  assert.equal(card({ createSec: 30 }).creating, '30s');
  assert.equal(card({ quotes: 1 }).contributions, 0);
  assert.throws(() => create({}, 'month', now), /Choose Today or Last 7 days/);
});
