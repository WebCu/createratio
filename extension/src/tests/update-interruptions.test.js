'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Updates = require('../background/updates.js');
const { worker } = require('./background-harness.js');
const { tracker } = require('./content-harness.js');

const start = new Date(2026, 9, 11, 12).getTime(),
  date = '2026-10-11';
const never = () => new Promise(() => {});
async function settled(check) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(check(), 'bounded client operation completed');
}

async function scenario(adapter, order, checkpoint) {
  const data = { settings: { trackedSites: ['x'] }, _access: { x: { remainingMs: 300000, date } } };
  let w = worker(data, adapter, start),
    reached,
    flushes = 0,
    failAcknowledgement = false,
    failInjection = false;
  const interrupted = new Promise(resolve => {
    reached = resolve;
  });
  const clients = new Map(),
    alarms = new Set(),
    injections = [],
    reloads = [];
  const pause = async point => {
    if (point === checkpoint) {
      reached();
      await never();
    }
  };
  for (const id of order) {
    const client = { live: true, deliveries: [] };
    client.tracker = await tracker(adapter, {
      forward: async message => {
        if (message.type === 'ingest') client.deliveries.push(structuredClone(message));
        const reply = await w.send(message, {
          id: 'test-extension',
          tab: { id },
          frameId: 0,
          url: 'https://x.com/home'
        });
        if (message.type === 'ingest' && failAcknowledgement) throw new Error('Acknowledgement lost after saving');
        client.ready = reply.ok;
        return reply;
      }
    });
    await settled(() => client.ready);
    client.keyListeners = client.tracker.listenerCount('keydown');
    client.document = client.tracker.document;
    client.document.syntheticDraft = `unsent draft ${id}`;
    clients.set(id, client);
  }
  const api = {
    runtime: {
      getManifest: () => ({
        content_scripts: [{ matches: ['https://*.x.com/*'], js: ['lifecycle.js', 'content.js'] }]
      }),
      getContexts: async () => [{}],
      reload: () => reloads.push(true)
    },
    storage: {
      local: {
        get: async () => structuredClone(data),
        set: async values => {
          if (values._updateRecovery) await pause('before-marker');
          Object.assign(data, structuredClone(values));
          if (values._updateRecovery) await pause('after-marker');
        },
        remove: async key => {
          delete data[key];
        }
      }
    },
    alarms: {
      create: async name => {
        alarms.add(name);
      },
      clear: async name => {
        alarms.delete(name);
      }
    },
    tabs: {
      query: async () => [
        ...order.map(id => ({ id, url: 'https://x.com/home', status: 'complete' })),
        { id: 99, url: 'https://x.com/home', discarded: true }
      ],
      sendMessage: async (id, message) => {
        assert.notEqual(id, 99, 'discarded tab cannot participate');
        const client = clients.get(id);
        if (!client.live) throw new Error('Receiving end does not exist.');
        if (message.type === 'commit-update' && id === order[1] && checkpoint === 'partial-commit') {
          await settled(() => !clients.get(order[0]).live);
          await pause('partial-commit');
        }
        const reply = await client.tracker.command(message);
        if (message.type === 'commit-update' && reply.ready) client.live = false;
        return reply;
      }
    },
    scripting: {
      executeScript: async ({ target }) => {
        assert.notEqual(target.tabId, 99, 'discarded tab cannot be reinjected');
        if (failInjection) throw new Error('Synthetic reinjection failure');
        const client = clients.get(target.tabId);
        client.ready = false;
        await client.tracker.reinject();
        await settled(() => client.ready);
        client.live = true;
        injections.push(target.tabId);
      }
    }
  };
  const create = () =>
    Updates.create(
      api,
      task => task(),
      async () => {
        await w.send({ type: 'snapshot' });
        if (++flushes === 2) await pause('before-reload');
      }
    );
  return {
    data,
    clients,
    alarms,
    injections,
    reloads,
    interrupted,
    create,
    stopInterrupting() {
      checkpoint = null;
      w = worker(data, adapter, start + 2000);
    },
    failAcknowledgement(value) {
      failAcknowledgement = value;
    },
    failSaving(value) {
      w.failWrites = value;
    },
    failInjection(value) {
      failInjection = value;
    }
  };
}

for (const adapter of ['chrome', 'browser']) {
  for (const order of [
    [1, 2],
    [2, 1]
  ]) {
    for (const checkpoint of ['before-marker', 'after-marker', 'partial-commit', 'before-reload']) {
      test(`${adapter}: replace worker at ${checkpoint}, client order ${order.join(',')}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const h = await scenario(adapter, order, checkpoint);
        const first = h.create();
        await first.available({ version: '0.0.7' });
        for (const client of h.clients.values()) {
          client.tracker.input();
          client.tracker.setNow(2000);
        }
        void first.attempt(true);
        await h.interrupted;
        if (checkpoint === 'partial-commit')
          assert.deepEqual(
            [...h.clients.values()].map(client => client.live),
            [false, true]
          );
        h.stopInterrupting();
        const replacement = h.create();
        await replacement.start();
        assert.equal(h.data._updateRecovery, undefined);
        assert.equal(h.data._pendingUpdate, '0.0.7');
        assert.equal(h.reloads.length, 0, 'an open extension page still defers installation');
        assert.equal(h.data[date].x.consumeSec, 4, 'both clients saved exactly two seconds');
        for (const [id, client] of h.clients) {
          assert.equal(client.live, true);
          assert.equal(client.tracker.document, client.document, 'recovery cannot navigate a surviving document');
          assert.equal(client.document.syntheticDraft, `unsent draft ${id}`);
          assert.equal(
            client.tracker.listenerCount('keydown'),
            client.keyListeners,
            'recovery cannot duplicate input listeners'
          );
          const requests = client.tracker.messages.length;
          for (const time of [7000, 12000, 17000]) {
            client.tracker.setNow(time);
            await client.tracker.tick();
          }
          assert.equal(client.tracker.messages.length, requests, 'recovered inactive clients return to quiet idle');
        }
        const before = h.data[date].x.consumeSec;
        for (const client of h.clients.values()) {
          await client.tracker.command({ type: 'prepare-update', force: true });
          await client.tracker.command({ type: 'prepare-update', force: true });
          await client.tracker.command({ type: 'resume-update' });
          client.tracker.input();
          client.tracker.setNow(22000);
          await client.tracker.tick();
        }
        await settled(() => h.data[date].x.consumeSec === before + 10);
        assert.equal(h.data[date].x.consumeSec, before + 10, 'fresh input resumes without backfilling teardown');
      });
    }
  }
  test(`${adapter}: partial teardown retries failed reinjection and retained deliveries without duplicate credit`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const h = await scenario(adapter, [1, 2], 'partial-commit');
    const first = h.create();
    await first.available({ version: '0.0.7' });
    for (const client of h.clients.values()) {
      client.tracker.input();
      client.tracker.setNow(2000);
    }
    h.failSaving(true);
    assert.equal((await first.attempt(true)).applied, false);
    assert.equal(h.data._updateRecovery, undefined, 'failed deliveries cannot permit teardown');
    assert.equal(h.reloads.length, 0);
    h.failSaving(false);
    h.failAcknowledgement(true);
    assert.equal((await first.attempt(true)).applied, false);
    assert.equal(h.data[date].x.consumeSec, 4, 'saving succeeded before acknowledgements were lost');
    h.failAcknowledgement(false);
    void first.attempt(true);
    await h.interrupted;
    h.stopInterrupting();
    h.failInjection(true);
    const replacement = h.create();
    await replacement.start();
    assert.equal(h.data._updateRecovery, true, 'failed recovery keeps its durable marker');
    assert.equal(h.alarms.has('extension-update'), true);
    assert.equal(h.reloads.length, 0);
    h.failInjection(false);
    await replacement.attempt();
    assert.equal(h.data._updateRecovery, undefined);
    assert.equal(h.data[date].x.consumeSec, 4, 'retries cannot credit saved packets twice');
    for (const client of h.clients.values()) {
      assert.ok(client.deliveries.length >= 3);
      assert.deepEqual(client.deliveries[0], client.deliveries[1]);
      assert.deepEqual(client.deliveries[1], client.deliveries[2]);
      assert.equal(client.live, true);
    }
  });
}
