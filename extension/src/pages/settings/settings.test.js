'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { page, C3 } = require('../../tests/ui-harness.js');
const settingsPage = (data, enabled) => page('settings', data, enabled);
function controls(p, site = '') {
  const suffix = site ? 'site-' + site : 'default';
  return { access: p.nodes['accessMinutes-' + suffix], source: p.nodes['accessMinutes-source-' + suffix]?.textContent, tracking: p.nodes['track-' + site], reset: p.nodes['access-reset-' + site] };
}
function value(p, site = '') { const c = controls(p, site); return [c.access.value, c.source]; }

test('malformed saves restore persisted controls without claiming success or notifying trackers', async () => {
  const p = settingsPage(); await p.ready();
  p.state.replies.set('tracking', { ok: true, settings: null });
  p.toggle('x', false); await p.ready();
  assert.equal(controls(p, 'x').tracking.checked, true);
  assert.equal(p.nodes.error.textContent, 'Unable to save settings.');
  assert.equal(p.nodes['save-status'].textContent, ''); assert.deepEqual(p.notifications, []);
  p.state.replies.set('access-duration', { ok: true });
  controls(p).access.value = '12'; await controls(p).access.fire('change');
  assert.equal(controls(p).access.value, 5); assert.equal(p.nodes.error.textContent, 'Unable to save settings.');
  p.state.replies.set('website-time-setting', { ok: true, enabled: 'true' });
  p.nodes['website-time-enabled'].checked = true; await p.nodes['website-time-enabled'].fire('change'); await p.ready();
  assert.equal(p.nodes['website-time-enabled'].checked, false); assert.equal(p.nodes['website-time-enabled'].disabled, false);
  assert.equal(p.nodes.error.textContent, 'Unable to change website time.'); assert.equal(p.nodes['save-status'].textContent, '');
});
test('slow scrolling defaults on, saves independently and restores failed or malformed changes', async () => {
  const p = settingsPage(); await p.ready();
  const input = p.nodes['scroll-friction-enabled'];
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  assert.equal(p.nodes['scroll-friction-strength'].value, 50); assert.equal(p.nodes['scroll-friction-strength'].disabled, false);
  input.checked = false; const saving = input.fire('change'); assert.equal(input.disabled, false);
  await input.fire('change'); await saving;
  assert.equal(p.messages.filter(message => message.type === 'scroll-friction-setting').length, 1);
  assert.equal(input.checked, false); assert.equal(input.disabled, false);
  assert.equal(p.state.requested, 0);
  assert.deepEqual(p.notifications, [{ id: 1, type: 'refresh' }, { id: 2, type: 'refresh' }]);
  assert.deepEqual(p.settings.trackedSites, ['x', 'linkedin']);
  assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
  p.fail = true; input.checked = true; await input.fire('change');
  assert.equal(input.checked, false); assert.equal(input.disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.');
  p.fail = false;
  p.state.replies.set('scroll-friction-setting', { ok: true });
  input.checked = true; await input.fire('change');
  assert.equal(input.checked, false); assert.equal(p.nodes['save-status'].textContent, '');
  assert.equal(p.nodes.error.textContent, 'Unable to save slow scrolling.');
  p.state.replies.delete('scroll-friction-setting'); input.checked = true; await input.fire('change');
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  p.setSettings({ ...C3.DEFAULT_SETTINGS, scrollFrictionEnabled: false }); p.change(); await p.ready();
  assert.equal(input.checked, false);
});
test('saved zero resistance shows Off and enabling starts with a positive strength', async () => {
  const p = settingsPage({ settings: { scrollFrictionEnabled: true, scrollFrictionStrength: 0 } }); await p.ready();
  const input = p.nodes['scroll-friction-enabled'], slider = p.nodes['scroll-friction-strength'];
  assert.equal(input.checked, false); assert.equal(slider.disabled, true); assert.equal(slider.value, 50);
  input.checked = true; await input.fire('change');
  assert.equal(input.checked, true); assert.equal(slider.disabled, false);
  assert.deepEqual(p.messages.filter(message => message.type === 'scroll-friction-setting'), [{ type: 'scroll-friction-setting', enabled: true, strength: 50 }]);
});
test('resistance previews locally during a drag and commits once without losing the draft to refresh', async () => {
  const p = settingsPage({ settings: { scrollFrictionEnabled: true } }); await p.ready();
  const slider = p.nodes['scroll-friction-strength'];
  assert.equal(slider.value, 50); assert.equal(slider.disabled, false);
  assert.equal(slider.min, 50); assert.equal(slider.max, 95); assert.equal(slider.step, 5);
  slider.focus(); const before = p.messages.length;
  for (let i = 0; i < 100; i++) { slider.value = String(50 + i % 10 * 5); await slider.fire('input'); }
  slider.value = '80'; await slider.fire('input');
  assert.equal(p.messages.length, before, 'input previews do not send messages');
  assert.equal(p.nodes['scroll-friction-value'].textContent, '80%');
  assert.match(slider.attributes['aria-valuetext'], /80% resistance, 20%/);
  assert.match(p.nodes['scroll-friction-effect'].textContent, /20%/);
  p.setSettings({ ...C3.DEFAULT_SETTINGS, scrollFrictionEnabled: true, scrollFrictionStrength: 60 }); p.change(); await p.ready();
  assert.equal(slider.value, '80'); assert.equal(p.document.activeElement, slider);
  await slider.fire('change');
  assert.deepEqual(p.messages.filter(message => message.type === 'scroll-friction-setting'), [{ type: 'scroll-friction-setting', enabled: true, strength: 80 }]);
  assert.equal(slider.value, 80); assert.equal(p.settings.scrollFrictionStrength, 80);
  assert.equal(p.document.activeElement, slider);
  p.nodes['scroll-friction-enabled'].checked = false; await p.nodes['scroll-friction-enabled'].fire('change');
  assert.equal(slider.disabled, true); assert.equal(slider.value, 80);
  p.nodes['scroll-friction-enabled'].checked = true; await p.nodes['scroll-friction-enabled'].fire('change');
  assert.equal(slider.disabled, false); assert.equal(slider.value, 80);
});
test('resistance keeps at most one in-flight save and one latest choice while controls stay responsive', async () => {
  const p = settingsPage({ settings: { scrollFrictionEnabled: true } }); await p.ready();
  const slider = p.nodes['scroll-friction-strength']; slider.focus();
  const release = p.holdMessage('scroll-friction-setting');
  slider.value = '75'; await slider.fire('input'); const first = slider.fire('change');
  assert.equal(slider.disabled, false); assert.equal(p.document.activeElement, slider);
  for (let i = 0; i < 100; i++) { slider.value = String(50 + i % 10 * 5); await slider.fire('input'); await slider.fire('change'); }
  slider.value = '95'; await slider.fire('input'); await slider.fire('change');
  assert.equal(slider.style['--scroll-fill'], '100%');
  assert.equal(p.messages.filter(message => message.type === 'scroll-friction-setting').length, 1);
  assert.equal(p.nodes['scroll-friction-value'].textContent, '95%');
  release(); await first;
  assert.deepEqual(p.messages.filter(message => message.type === 'scroll-friction-setting').map(message => message.strength), [75, 95]);
  assert.equal(p.settings.scrollFrictionStrength, 95); assert.equal(slider.value, 95);
  assert.equal(p.document.activeElement, slider);
  assert.deepEqual(p.notifications, [{ id: 1, type: 'refresh' }, { id: 2, type: 'refresh' }]);
});
test('failed resistance saves roll back to the confirmed value and malformed successes do not claim a save', async () => {
  const p = settingsPage({ settings: { scrollFrictionEnabled: true, scrollFrictionStrength: 75 } }); await p.ready();
  const slider = p.nodes['scroll-friction-strength']; slider.focus();
  p.fail = true; slider.value = '90'; await slider.fire('input'); await slider.fire('change');
  assert.equal(slider.value, 75); assert.match(p.nodes['scroll-friction-effect'].textContent, /25%/);
  assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.equal(slider.disabled, false);
  assert.equal(p.document.activeElement, slider);
  p.fail = false;
  const original = p.messages.length;
  for (const value of ['0', '5', '25', '45', '77', '99']) {
    slider.value = value; await slider.fire('change');
    assert.equal(p.messages.length, original); assert.equal(slider.value, 75);
  }
  p.state.replies.set('scroll-friction-setting', { ok: true });
  slider.value = '60'; await slider.fire('input'); await slider.fire('change');
  assert.equal(slider.value, 75); assert.equal(p.nodes['save-status'].textContent, '');
  assert.equal(p.nodes.error.textContent, 'Unable to save slow scrolling.');
  p.state.replies.delete('scroll-friction-setting');
  slider.value = '50'; await slider.fire('input'); await slider.fire('change');
  assert.equal(p.settings.scrollFrictionStrength, 50); assert.match(p.nodes['scroll-friction-effect'].textContent, /50%/);
  assert.equal(slider.style['--scroll-fill'], '0%');
});
test('Settings slow-scrolling choice reaches the real worker, survives restart and changes live tracker behavior', async () => {
  const { activeWorker, worker } = require('../../tests/background-harness.js');
  const { tracker } = require('../../tests/content-harness.js');
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
  async function until(check) {
    for (let n = 0; n < 200 && !check(); n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(check(), 'browser messages finish before assertions');
  }
  const w = activeWorker();
  const p = page('settings', w.data, false, { forward: message => w.send(message, sender) });
  await until(() => !!p.nodes['track-x']);
  let replies = 0;
  const t = await tracker('chrome', { async forward(message) { const result = await w.send(message); replies++; return result; } });
  await until(() => replies > 0 && t.listenerCount('wheel') === 2);
  assert.equal(p.nodes['scroll-friction-enabled'].checked, true);
  assert.equal(t.wheel(200).defaultPrevented, true);
  assert.equal(t.document.scrollingElement.scrollTop, 1100);
  p.nodes['scroll-friction-strength'].value = '75';
  const beforeRefresh = replies;
  await p.nodes['scroll-friction-strength'].fire('change'); await t.tick();
  await until(() => replies > beforeRefresh);
  assert.equal(w.data.settings.scrollFrictionStrength, 75);
  assert.equal(t.wheel(200).defaultPrevented, true);
  assert.equal(t.document.scrollingElement.scrollTop, 1150);
  p.nodes['scroll-friction-enabled'].checked = false;
  await p.nodes['scroll-friction-enabled'].fire('change'); await t.tick();
  await until(() => t.listenerCount('wheel') === 1);
  assert.equal(t.wheel(200).defaultPrevented, false);
  const restarted = worker(w.data, 'chrome', w.now);
  const restored = (await restarted.send({ type: 'snapshot' })).settings;
  assert.equal(restored.scrollFrictionEnabled, false); assert.equal(restored.scrollFrictionStrength, 75);
});
test('intention history defaults off, toggles independently, and recovers failed saves', async () => {
  const p = settingsPage({ _intentions: [{ site: 'x', reason: 'A saved intention', requestedAt: 1 }] }); await p.ready();
  const input = p.nodes['intention-history-enabled'];
  assert.equal(input.checked, false); assert.equal(input.disabled, false);
  input.checked = true; const pending = input.fire('change'); assert.equal(input.disabled, true); await pending; await p.ready();
  assert.deepEqual(p.messages.find(m => m.type === 'access-history-setting'), { type: 'access-history-setting', enabled: true });
  assert.equal(input.checked, true); assert.equal(p.data._intentions.length, 1);
  p.fail = true; input.checked = false; await input.fire('change'); await p.ready();
  assert.equal(input.checked, true); assert.equal(input.disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.');
  p.fail = false; input.checked = false; await input.fire('change'); await p.ready();
  assert.equal(input.checked, false); assert.equal(p.data._intentions.length, 1);
});
test('goal-based access defaults off, saves both ways and restores failed changes', async () => {
  const p = settingsPage(); await p.ready(); const input = p.nodes['allow-above-goal'];
  assert.equal(input.checked, false); assert.equal(input.disabled, false);
  input.checked = true; const saving = input.fire('change'); assert.equal(input.disabled, true);
  await saving; await p.ready();
  assert.deepEqual(p.messages.find(m => m.type === 'access-goal-setting'), { type: 'access-goal-setting', enabled: true });
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  assert.equal(p.state.requested, 0);
  p.fail = true; input.checked = false; await input.fire('change'); await p.ready();
  assert.equal(input.checked, true); assert.equal(input.disabled, false);
  assert.equal(p.nodes.error.textContent, 'Could not save.');
  p.fail = false; input.checked = false; await input.fire('change'); await p.ready();
  assert.equal(input.checked, false);
  p.setSettings({ ...C3.DEFAULT_SETTINGS, allowAboveGoal: true }); p.change(); await p.ready();
  assert.equal(input.checked, true);
});
test('one row per site combines creation tracking and access limits without selectors or nudges', async () => {
  const p = settingsPage(); await p.ready(); const rows = p.nodes['site-settings'].children;
  assert.deepEqual(rows.map(row => row.children[0].children[0].textContent), ['Default', ...C3.SITES.map(site => site.name)]);
  assert.deepEqual(value(p), [5, 'Default']);
  for (const { id } of C3.SITES) {
    assert.deepEqual(value(p, id), [5, 'From Default']); const c = controls(p, id), row = rows.find(row => row.attributes['data-site'] === id);
    assert.equal(c.tracking.checked, true); assert.equal(c.tracking.parent.parent.parent, row); assert.equal(c.access.parent.parent.parent, row);
    assert.equal(c.tracking.attributes['aria-label'], 'Limit & track on ' + C3.SITES.find(site => site.id === id).name);
    assert.equal(p.nodes['nudgeEnabled-site-' + id], undefined); assert.equal(p.nodes['nudgeMinutes-site-' + id], undefined);
  }
  for (const id of ['settings-overview', 'tracking-sites', 'access-site', 'nudge-site', 'nudgeEnabled-default', 'nudgeMinutes-default']) assert.equal(p.nodes[id], undefined);
  assert.equal(controls(p).tracking, undefined); assert.equal(controls(p).reset, undefined); assert.ok(p.messages.every(message => message.type === 'snapshot'));
});
test('session times show inheritance and are inactive when Limit & track is Off', async () => {
  const p = settingsPage(); await p.ready();
  p.setSettings({ ...C3.DEFAULT_SETTINGS, trackedSites: ['linkedin'], siteOverrides: { x: { accessMinutes: 2 } } }); p.change(); await p.ready();
  assert.deepEqual(value(p), [5, 'Default']); assert.deepEqual(value(p, 'x'), [2, 'Custom']); assert.deepEqual(value(p, 'linkedin'), [5, 'From Default']);
  assert.equal(controls(p, 'x').tracking.checked, false); assert.equal(controls(p, 'linkedin').tracking.checked, true);
  assert.equal(controls(p, 'x').reset.hidden, false); assert.equal(controls(p, 'x').reset.disabled, true); assert.equal(controls(p, 'x').access.disabled, true);
  assert.equal(controls(p, 'linkedin').access.disabled, false); assert.equal(controls(p, 'linkedin').reset.hidden, true);
});
test('inline access fields stay stable and keep keyboard focus across refresh', async () => {
  const p = settingsPage(); await p.ready(); const input = controls(p, 'x').access;
  input.focus(); p.refresh(); await p.ready();
  assert.equal(controls(p, 'x').access, input); assert.equal(p.document.activeElement, input);
  assert.equal(input.attributes['aria-label'], 'Session time for X'); assert.equal(input.attributes['aria-describedby'], 'accessMinutes-source-site-x');
});
test('saved session times and Default changes update all rows; resets keep Limit & track On', async () => {
  const p = settingsPage(); await p.ready(); const x = controls(p, 'x'), defaults = controls(p);
  x.access.value = '2'; await x.access.fire('change'); await p.ready(); assert.deepEqual(value(p, 'x'), [2, 'Custom']);
  defaults.access.value = '12'; await defaults.access.fire('change'); await p.ready();
  assert.deepEqual(value(p), [12, 'Default']); assert.deepEqual(value(p, 'linkedin'), [12, 'From Default']); assert.deepEqual(value(p, 'x'), [2, 'Custom']);
  await x.reset.fire('click'); await p.ready();
  assert.deepEqual(value(p, 'x'), [12, 'From Default']); assert.equal(x.reset.hidden, true); assert.equal(x.tracking.checked, true);
});
test('failed access saves restore persisted fields and disable only that preference group', async () => {
  const p = settingsPage(); await p.ready(); const x = controls(p, 'x'), linkedin = controls(p, 'linkedin');
  p.fail = true; x.access.focus(); x.access.value = '7'; const saving = x.access.fire('change');
  assert.equal(x.access.disabled, true); assert.equal(x.tracking.disabled, false); assert.equal(linkedin.access.disabled, false);
  const count = p.messages.length; await x.access.fire('change'); assert.equal(p.messages.length, count);
  await saving; await p.ready();
  assert.deepEqual(value(p, 'x'), [5, 'From Default']); assert.equal(x.access.disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.');
});
test('Limit & track switches turn timing and measurements off together and keep saved values/history', async () => {
  const p = settingsPage(); await p.ready(); const x = controls(p, 'x');
  const input = p.toggle('x', false); assert.equal(input.disabled, true); assert.equal(x.access.disabled, true); await p.ready();
  assert.deepEqual(p.messages.find(message => message.type === 'tracking'), { type: 'tracking', site: 'x', enabled: false });
  assert.equal(input.checked, false); assert.equal(input.disabled, false); assert.equal(controls(p, 'linkedin').tracking.checked, true);
  assert.equal(p.nodes['tracking-status-x'].textContent, 'Off'); assert.match(p.nodes['save-status'].textContent, /X: Limit & track is off/); assert.equal(x.access.disabled, true);
  assert.equal(x.access.value, 5); assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
  assert.deepEqual(p.notifications, [{ id: 1, type: 'refresh' }, { id: 2, type: 'refresh' }]);
  p.refresh(); await p.ready(); assert.equal(controls(p, 'x').tracking, input);
  p.toggle('x', true); await p.ready(); assert.equal(input.checked, true); assert.equal(x.access.disabled, false);
});
test('failed creation tracking saves restore the switch and show an error', async () => {
  const p = settingsPage(); await p.ready(); p.fail = true;
  const input = p.toggle('linkedin', false); await p.ready();
  assert.equal(input.checked, true); assert.equal(input.disabled, false); assert.equal(controls(p, 'linkedin').access.disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.deepEqual(p.notifications, []);
});
test('external preferences update existing site rows, including all creation tracking off', async () => {
  const p = settingsPage(); await p.ready(); p.setSettings({ ...C3.DEFAULT_SETTINGS, trackedSites: [] }); p.change(); await p.ready();
  for (const { id } of C3.SITES) { assert.equal(controls(p, id).tracking.checked, false); assert.equal(controls(p, id).access.value, 5); assert.equal(controls(p, id).access.disabled, true); }
  assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
});
test('Settings derives gate controls from capabilities rather than a list of known site IDs', async () => {
  const length = C3.SITES.length;
  C3.SITES.push({ id: 'example', name: 'Example', gated: true }, { id: 'reading', name: 'Reading', gated: false });
  try {
    const p = settingsPage({ settings: { trackedSites: ['example', 'reading'] } }); await p.ready();
    assert.equal(controls(p, 'example').access.value, 5);
    assert.equal(controls(p, 'example').tracking.attributes['aria-label'], 'Limit & track on Example');
    assert.equal(controls(p, 'reading').access, undefined);
    assert.equal(controls(p, 'reading').tracking.attributes['aria-label'], 'Track creating & consuming on Reading');
    p.toggle('example', false); await p.ready();
    assert.equal(controls(p, 'example').access.disabled, true);
    assert.match(p.nodes['save-status'].textContent, /Example: Limit & track is off/);
    assert.equal(controls(p, 'reading').tracking.checked, true);
  } finally { C3.SITES.splice(length); }
});

test('removed integrations have no editable row and keep recorded history', async () => {
  const p = settingsPage({ [C3.localDate()]: { retired: { consumeSec: 120 } } }); await p.ready();
  assert.equal(p.nodes['site-settings'].children.length, C3.SITES.length + 1); assert.equal(p.nodes['track-retired'], undefined); assert.equal(p.data[C3.localDate()].retired.consumeSec, 120);
});
test('Default access limits validate whole minutes and recover failed saves', async () => {
  const p = settingsPage(); await p.ready(); const input = controls(p).access;
  assert.equal(input.value, 5); assert.equal(input.disabled, false);
  input.value = '12'; await input.fire('change'); await p.ready();
  assert.deepEqual(p.messages.find(message => message.type === 'access-duration'), { type: 'access-duration', minutes: 12 }); assert.equal(input.value, 12);
  for (const minutes of ['0', '241', '1.5', '']) {
    const count = p.messages.length; input.value = minutes; await input.fire('change'); assert.equal(p.messages.length, count); assert.match(p.nodes.error.textContent, /whole number/);
  }
  input.focus(); p.fail = true; input.value = '7'; await input.fire('change'); await p.ready();
  assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.equal(input.value, 12); assert.equal(input.disabled, false);
});
test('declining permission resets Website time without sending an opt-in message', async () => {
  const p = settingsPage(); await p.ready(); p.state.permission = false;
  p.nodes['website-time-enabled'].checked = true; await p.nodes['website-time-enabled'].fire('change'); await p.ready();
  assert.equal(p.state.requested, 1); assert.equal(p.nodes['website-time-enabled'].checked, false);
  assert.match(p.nodes.error.textContent, /Permission declined/); assert.equal(p.messages.some(message => message.type === 'website-time-setting'), false);
});
test('Website time enable requests permission; disable revokes it and preserves totals', async () => {
  const p = settingsPage({ _websiteTime: { [C3.localDate()]: { 'example.com': 120 } } }); await p.ready();
  p.nodes['website-time-enabled'].checked = true; await p.nodes['website-time-enabled'].fire('change'); await p.ready();
  assert.equal(p.nodes['website-time-enabled'].checked, true); assert.equal(p.state.requested, 1);
  p.nodes['website-time-enabled'].checked = false; await p.nodes['website-time-enabled'].fire('change'); await p.ready();
  assert.equal(p.state.removed, 1); assert.equal(p.nodes['website-time-enabled'].checked, false); assert.equal(p.data._websiteTime[C3.localDate()]['example.com'], 120);
});
test('creation tracking and Website time remain independent in both directions', async () => {
  const p = settingsPage({}, true); await p.ready(); p.toggle('x', false); p.toggle('linkedin', false); await p.ready();
  assert.equal(p.nodes['website-time-enabled'].checked, true); assert.equal(p.state.removed, 0); assert.match(p.nodes['website-status'].textContent, /Website time is on/);
  p.nodes['website-time-enabled'].checked = false; await p.nodes['website-time-enabled'].fire('change'); await p.ready();
  assert.equal(controls(p, 'x').tracking.checked, false); assert.equal(controls(p, 'linkedin').tracking.checked, false);
  p.toggle('x', true); await p.ready(); assert.equal(p.nodes['website-time-enabled'].checked, false); assert.equal(p.state.requested, 0);
});
test('Settings gives site boundaries and the optional goal exception separate labelled sections', () => {
  const html = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');
  const sections = new Map([...html.matchAll(/<section class="preference" aria-labelledby="([^"]+)">([\s\S]*?)<\/section>/g)].map(([, id, content]) => [id, content]));
  assert.match(sections.get('site-settings-title'), /id="site-settings"/);
  assert.doesNotMatch(sections.get('site-settings-title'), /id="allow-above-goal"/);
  assert.match(sections.get('goal-access-title'), /id="allow-above-goal"/);
  assert.match(sections.get('goal-access-title'), /id="goal-access-note"/);
  assert.match(sections.get('intentions-title'), /id="intention-history-enabled"/);
  assert.match(sections.get('websites-title'), /id="website-time-enabled"/);
  assert.match(sections.get('data-title'), /id="clear-history"/);
  assert.match(html, /<h1>Settings<\/h1>/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
});
test('site access resets preserve saved legacy preferences without exposing or activating nudges', async () => {
  const p = settingsPage(); await p.ready();
  p.setSettings({ ...C3.DEFAULT_SETTINGS, nudgeEnabled: true, nudgeMinutes: 1, siteOverrides: { x: { nudgeEnabled: true, nudgeMinutes: 3 } } }); p.change(); await p.ready();
  const x = controls(p, 'x'); assert.equal(x.access.value, 5); assert.equal(x.reset.hidden, true);
  x.access.value = '2'; await x.access.fire('change'); await p.ready();
  assert.deepEqual(p.messages.find(message => message.type === 'access-duration'), { type: 'access-duration', site: 'x', minutes: 2 });
  assert.equal(x.access.value, 2); assert.equal(x.reset.hidden, false); assert.equal(controls(p, 'linkedin').access.value, 5);
  controls(p).access.value = '12'; await controls(p).access.fire('change'); await p.ready(); assert.equal(x.access.value, 2);
  await x.reset.fire('click'); await p.ready(); assert.equal(x.access.value, 12); assert.equal(x.reset.hidden, true);
  assert.deepEqual(p.messages.filter(message => message.type === 'access-duration').at(-1), { type: 'access-duration', site: 'x', minutes: null });
  assert.deepEqual(p.settings.siteOverrides.x, { nudgeEnabled: true, nudgeMinutes: 3 }); assert.equal(p.settings.nudgeEnabled, true);
  assert.equal(p.nodes['nudgeEnabled-site-x'], undefined); assert.ok(p.messages.every(message => message.type !== 'settings'));
});
test('failed session-time resets retain custom limits and do not change enabled sites', async () => {
  const p = settingsPage(); await p.ready(); p.setSettings({ ...C3.DEFAULT_SETTINGS, accessMinutes: 12, trackedSites: ['x'], siteOverrides: { x: { accessMinutes: 2 } } }); p.change(); await p.ready();
  const x = controls(p, 'x'); p.fail = true; const saving = x.reset.fire('click');
  assert.equal(x.reset.disabled, true); assert.equal(x.access.disabled, true); assert.equal(x.tracking.disabled, false);
  await saving; await p.ready(); assert.deepEqual(value(p, 'x'), [2, 'Custom']); assert.equal(x.reset.hidden, false); assert.equal(x.reset.disabled, false);
  assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.equal(x.tracking.checked, true); assert.equal(controls(p, 'linkedin').tracking.checked, false);
  p.fail = false; await x.reset.fire('click'); await p.ready(); assert.deepEqual(value(p, 'x'), [12, 'From Default']); assert.equal(x.tracking.checked, true);
});
test('Off disables session edits/reset; failed activation stays Off and reactivation restores saved time', async () => {
  const p = settingsPage(); await p.ready(); const x = controls(p, 'x');
  x.access.value = '2'; await x.access.fire('change'); await p.ready();
  p.toggle('x', false); await p.ready(); assert.equal(x.access.disabled, true); assert.equal(x.reset.disabled, true);
  const count = p.messages.length; await x.access.fire('change'); await x.reset.fire('click'); assert.equal(p.messages.length, count);
  p.fail = true; p.toggle('x', true); await p.ready(); assert.equal(x.tracking.checked, false); assert.equal(x.access.disabled, true);
  controls(p).access.value = '12'; p.fail = false; await controls(p).access.fire('change'); await p.ready();
  p.toggle('x', true); await p.ready(); assert.deepEqual(value(p, 'x'), [2, 'Custom']); assert.equal(x.access.disabled, false); assert.equal(x.reset.disabled, false);
});
test('refresh does not overwrite in-progress site access edits', async () => {
  const p = settingsPage(); await p.ready(); const input = controls(p, 'x').access;
  input.focus(); input.value = '15'; p.change(); await p.ready(); assert.equal(input.value, '15');
});
test('saving creation tracking does not overwrite an unsaved access edit in another row', async () => {
  const p = settingsPage(); await p.ready(); const linkedin = controls(p, 'linkedin');
  linkedin.access.focus(); linkedin.access.value = '18'; p.toggle('x', false); await p.ready();
  assert.equal(linkedin.access.value, '18'); assert.equal(p.document.activeElement, linkedin.access); assert.equal(controls(p, 'x').tracking.checked, false);
});
test('a failed reload after saving reports an error and a later refresh recovers the persisted limit', async () => {
  const p = settingsPage(); await p.ready(); const input = controls(p, 'x').access;
  p.state.failSnapshot = true; input.value = '2'; await input.fire('change'); await p.ready();
  assert.equal(input.disabled, false); assert.equal(p.nodes.error.textContent, 'Could not save.'); assert.equal(p.nodes['save-status'].textContent, '');
  p.state.failSnapshot = false; p.refresh(); await p.ready(); assert.deepEqual(value(p, 'x'), [2, 'Custom']);
});
test('concurrent inline saves preserve site limits, Default values and creation tracking independently', async () => {
  const p = settingsPage(); await p.ready(); const defaults = controls(p), x = controls(p, 'x'), linkedin = controls(p, 'linkedin');
  defaults.access.value = '12'; x.access.value = '2'; linkedin.access.value = '3'; x.tracking.checked = false;
  await Promise.all([defaults.access.fire('change'), x.access.fire('change'), linkedin.access.fire('change'), x.tracking.fire('change')]); await p.ready();
  assert.deepEqual(value(p), [12, 'Default']); assert.deepEqual(value(p, 'x'), [2, 'Custom']); assert.deepEqual(value(p, 'linkedin'), [3, 'Custom']);
  assert.equal(x.tracking.checked, false); assert.equal(linkedin.tracking.checked, true); assert.equal(p.data[C3.localDate()].x.consumeSec, 60);
});
test('a tracking save can finish while its session-duration save remains pending', async () => {
  const p = settingsPage(); await p.ready(); const x = controls(p, 'x');
  const release = p.holdMessage('access-duration');
  x.access.value = '2'; const savingDuration = x.access.fire('change');
  x.tracking.checked = false; await x.tracking.fire('change');
  assert.equal(x.tracking.disabled, false); assert.equal(x.tracking.checked, false);
  assert.equal(x.access.value, '2'); assert.equal(x.access.disabled, true);
  const before = p.messages.length;
  await x.access.fire('change'); assert.equal(p.messages.length, before);
  release(); await savingDuration;
  assert.deepEqual(value(p, 'x'), [2, 'Custom']);
  assert.equal(x.tracking.checked, false); assert.equal(x.access.disabled, true);
  assert.equal(x.reset.disabled, true); assert.equal(x.reset.hidden, false);
  assert.deepEqual(p.notifications, [{ id: 1, type: 'refresh' }, { id: 2, type: 'refresh' }]);
});
