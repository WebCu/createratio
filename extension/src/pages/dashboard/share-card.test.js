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
  assert.deepEqual(weekly.headline, ['Made room', 'for creating.']);
  assert.match(weekly.caption, /last 7 days/i);
  assert.match(daily.caption, /today so far/i);
  assert.match(weekly.caption, /https:\/\/createratio\.com\//);
  assert.equal(new URL(weekly.url).hostname, 'createratio.com');
  assert.match(weekly.caption, /Tracked sites only/);
  assert.match(weekly.caption, /approximate/);
  assert.match(weekly.caption, /2 detected post\/reply\/comment actions/);
  assert.match(weekly.description, /not confirmed publications/);
  assert.match(weekly.caption, /Create > Consume/);
  assert.doesNotMatch(JSON.stringify(weekly), /Private intention text|private\.example|retired|99999|2026-03-02/);
  assert.deepEqual(days, before);
});

test('prominent scores retain the existing action-credit formula, including the zero-consuming floor', () => {
  const now = new Date(2026, 0, 1);
  const card = stats => create({ '2026-01-01': { x: stats } }, 'today', now);
  assert.equal(card({ createSec: 60, consumeSec: 120, posts: 1 }).score, '1.50');
  assert.equal(card({ posts: 1, quotes: 1 }).score, '120.00');
  assert.equal(card({ consumeSec: 120, replies: 1, comments: 1, likes: 50, reposts: 50, bookmarks: 50 }).score, '2.00');
});

test('headlines encourage creating without claiming creative quality, less browsing or a trend', () => {
  const now = new Date(2026, 0, 1);
  const card = stats => create({ '2026-01-01': { x: stats } }, 'today', now);
  assert.deepEqual(card({ createSec: 180, consumeSec: 60 }).headline, ['Made room', 'for creating.']);
  assert.deepEqual(card({ createSec: 60, consumeSec: 180, posts: 20 }).headline, ['Made room', 'for creating.']);
  assert.deepEqual(card({ posts: 1 }).headline, ['Made room', 'for creating.']);
  assert.deepEqual(card({ consumeSec: 300 }).headline, ['Make room', 'for creating.']);
  assert.deepEqual(card({ likes: 3 }).headline, ['Make room', 'for creating.']);
  assert.deepEqual(card({}).headline, ['A fresh start.', 'Room to create.']);
  assert.equal(card({}).score, '0.00');
  assert.equal(card({}).creatingShare, 0); assert.equal(card({}).consumingShare, 0);
  assert.equal(card({ consumeSec: 300 }).consumingShare, 1);
  assert.equal(card({ createSec: 120, consumeSec: 60 }).consumingShare, 1 / 3);
  assert.equal(card({ createSec: 30 }).creating, '30s');
  assert.equal(card({ quotes: 1 }).contributions, 0);
  assert.throws(() => create({}, 'month', now), /Choose Today or Last 7 days/);
});
