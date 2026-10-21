'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(extensionAPI.runtime);
const $ = id => document.getElementById(id);
const accessSites = new Set(C3.SITES.filter(site => site.gated).map(site => site.id)), siteControls = new Map();
let currentSettings = C3.DEFAULT_SETTINGS, refreshing = false, websiteSettingBusy = false, goalSettingBusy = false, intentionSettingBusy = false, scrollSettingBusy = false, websiteTimeEnabled = false;
let scrollEditing = false, scrollPending = null, scrollSaving = null;
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; if (message) $('save-status').textContent = ''; }
function saved(message) { error(); $('save-status').textContent = message; }
function createAccessField(site) {
  const node = document.createElement('div'); node.className = 'site-preference-field';
  const heading = document.createElement('label'); heading.textContent = 'Session time';
  const line = document.createElement('div'); line.className = 'site-field-value';
  const unit = document.createElement('span'), sourceLine = document.createElement('div'), source = document.createElement('small');
  sourceLine.className = 'site-field-source'; source.id = 'accessMinutes-source-' + (site.id ? 'site-' + site.id : 'default'); sourceLine.append(source);
  let input = null, reset = null;
  if (site.id && !accessSites.has(site.id)) unit.textContent = 'Not gated';
  else {
    input = document.createElement('input'); input.type = 'number';
    input.id = 'accessMinutes-' + (site.id ? 'site-' + site.id : 'default'); heading.htmlFor = input.id;
    input.setAttribute('aria-label', 'Session time for ' + site.name); input.setAttribute('aria-describedby', source.id);
    input.min = String(C3.ACCESS_LIMITS.minMinutes); input.max = String(C3.ACCESS_LIMITS.maxMinutes); input.step = '1'; unit.textContent = 'active min';
    input.addEventListener('change', () => saveAccessDuration(site.id)); line.append(input);
    if (site.id) {
      reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Use Default'; reset.id = 'access-reset-' + site.id;
      reset.setAttribute('aria-label', 'Use Default session time for ' + site.name);
      reset.addEventListener('click', () => saveAccessDuration(site.id, true)); sourceLine.append(reset);
    }
  }
  line.append(unit); node.append(heading, line, sourceLine);
  return { node, input, source, reset };
}
function createSite(site) {
  const row = document.createElement('li'); row.className = 'site-preferences'; row.setAttribute('data-site', site.id);
  const header = document.createElement('div'); header.className = 'site-preference-heading';
  const name = document.createElement('h3'); name.textContent = site.name; header.append(name);
  let tracking = null, trackingStatus = null;
  if (site.id) {
    const group = document.createElement('div'); group.className = 'site-tracking';
    const label = document.createElement('label'); label.htmlFor = 'track-' + site.id; label.textContent = accessSites.has(site.id) ? 'Limit & track' : 'Track creating & consuming';
    tracking = document.createElement('input'); tracking.id = label.htmlFor; tracking.type = 'checkbox';
    tracking.setAttribute('role', 'switch'); tracking.setAttribute('aria-label', label.textContent + ' on ' + site.name);
    trackingStatus = document.createElement('small'); trackingStatus.id = 'tracking-status-' + site.id;
    tracking.addEventListener('change', () => saveTracking(site.id));
    group.append(label, tracking, trackingStatus); header.append(group);
  } else {
    const note = document.createElement('small'); note.textContent = 'Fallback for gated sites'; header.append(note);
  }
  const access = createAccessField(site), note = document.createElement('p'); note.className = 'site-mode-note';
  note.textContent = accessSites.has(site.id) ? 'Off: browse freely. No wait, time limit, or creation-score tracking.' : 'Off: no creation-score tracking.';
  row.append(header, access.node, note); $('site-settings').append(row);
  return { site, access, tracking, trackingStatus, note, busy: new Set() };
}
function renderSite(control, settings, force) {
  const { site, access } = control;
  const effective = C3.siteSettings(site.id, settings), overridden = Object.hasOwn(settings.siteOverrides?.[site.id] || {}, 'accessMinutes');
  const enabled = !site.id || C3.trackingEnabled(site.id, settings);
  const inactive = !!site.id && !enabled, switching = control.busy.has('tracking');
  control.note.hidden = !inactive;
  if (access.input) {
    if (!control.busy.has('access') && (force === site.id + ':access' || document.activeElement !== access.input)) access.input.value = effective.accessMinutes;
    access.input.disabled = control.busy.has('access') || switching || inactive;
  }
  access.source.textContent = !access.input ? 'No access gate' : !site.id ? 'Default' : overridden ? 'Custom' : 'From Default';
  access.source.className = overridden ? 'settings-source-custom' : '';
  if (access.reset) { access.reset.hidden = !overridden; access.reset.disabled = control.busy.has('access') || switching || inactive; }
  if (control.tracking) {
    if (!switching) control.tracking.checked = C3.trackingEnabled(site.id, settings);
    control.tracking.disabled = switching; control.trackingStatus.textContent = control.tracking.checked ? 'On' : 'Off';
  }
}
function renderScroll(settings) {
  const toggle = $('scroll-friction-enabled'), slider = $('scroll-friction-strength');
  if (!scrollSettingBusy && !scrollEditing) {
    toggle.checked = settings.scrollFrictionEnabled;
    slider.value = settings.scrollFrictionStrength ?? C3.DEFAULT_SETTINGS.scrollFrictionStrength;
  }
  toggle.disabled = false; slider.disabled = !toggle.checked;
  const strength = Number(slider.value), distance = 100 - strength;
  slider.style.setProperty('--scroll-fill', `${strength / C3.SCROLL_FRICTION_LIMITS.maxStrength * 100}%`);
  slider.setAttribute('aria-valuetext', `${strength}% resistance, ${distance}% of normal scroll distance`);
  $('scroll-resistance').setAttribute('data-enabled', String(toggle.checked));
  $('scroll-friction-value').textContent = `${strength}%`;
  $('scroll-friction-effect').textContent = `Page moves ${distance}% as far${toggle.checked ? '' : ' when enabled'}.`;
}
function render(settings, force = '') {
  currentSettings = settings;
  if (!siteControls.size) $('site-settings').replaceChildren();
  for (const site of [{ id: '', name: 'Default' }, ...C3.SITES]) {
    let control = siteControls.get(site.id);
    if (!control) { control = createSite(site); siteControls.set(site.id, control); }
    renderSite(control, settings, force);
  }
  renderScroll(settings);
  if (!goalSettingBusy) $('allow-above-goal').checked = settings.allowAboveGoal;
  $('allow-above-goal').disabled = goalSettingBusy;
  if (!intentionSettingBusy) $('intention-history-enabled').checked = settings.intentionHistoryEnabled;
  $('intention-history-enabled').disabled = intentionSettingBusy;
  if (!websiteSettingBusy) $('website-time-enabled').checked = websiteTimeEnabled;
  $('website-time-enabled').disabled = websiteSettingBusy;
  $('website-status').textContent = websiteTimeEnabled ? 'Website time is on. See domain totals in the dashboard.' : 'Website time is off. Previously recorded browsing time is kept.';
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const snapshot = await messages.send({ type: 'snapshot' }, 'Unable to load your settings.');
    websiteTimeEnabled = snapshot.websiteTimeEnabled; render(snapshot.settings);
  } catch (e) { error(e.message); } finally { refreshing = false; }
}
async function notifyTrackers() {
  const tabs = await extensionAPI.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map(tab => extensionAPI.tabs.sendMessage(tab.id, { type: 'refresh' }).catch(() => {})));
}
async function saveAccessDuration(site, reset = false) {
  const control = siteControls.get(site), input = control.access.input;
  if (control.busy.has('access') || input.disabled) return;
  const minutes = reset ? null : Number(input.value);
  if (!reset && (!input.reportValidity() || !C3.validAccessMinutes(minutes))) { error(`Choose a whole number from ${C3.ACCESS_LIMITS.minMinutes} to ${C3.ACCESS_LIMITS.maxMinutes} minutes.`); return; }
  await saveSitePreference(control, 'access', { type: 'access-duration', minutes, ...(site ? { site } : {}) });
}
async function saveTracking(site) {
  const control = siteControls.get(site);
  if (control.busy.has('tracking')) return;
  await saveSitePreference(control, 'tracking', { type: 'tracking', site, enabled: control.tracking.checked });
}
async function saveSitePreference(control, group, message) {
  const site = control.site.id, input = control.access.input;
  control.busy.add(group);
  if (group === 'tracking') {
    control.tracking.disabled = true; control.trackingStatus.textContent = control.tracking.checked ? 'On' : 'Off';
  }
  if (input) input.disabled = true;
  if (control.access.reset) control.access.reset.disabled = true;
  try {
    const result = await messages.send(message, 'Unable to save settings.');
    const snapshot = message.type === 'tracking' ? result : await messages.send({ type: 'snapshot' }, 'Unable to load your saved settings.');
    render(snapshot.settings);
    if (group === 'tracking') {
      const description = accessSites.has(site)
        ? message.enabled ? 'Limit & track is on. Start an access session to record creating and consuming.' : 'Limit & track is off. Free access; no creation-score tracking.'
        : message.enabled ? 'Creating/consuming and action measurements are on.' : 'Creation-score tracking is off.';
      saved(`${control.site.name}: ${description} Your history is kept.`);
    } else saved(`${control.site.name} session time saved for new sessions and midnight refills.`);
    if (group === 'tracking') await notifyTrackers();
  } catch (e) { error(e.message); }
  finally { control.busy.delete(group); render(currentSettings, site + ':' + group); }
}
async function saveScrollSettings() {
  const choice = { enabled: $('scroll-friction-enabled').checked, strength: Number($('scroll-friction-strength').value) };
  scrollEditing = false;
  $('save-status').textContent = '';
  if (!C3.validScrollFrictionStrength(choice.strength)) { error('Choose a valid scroll resistance.'); renderScroll(currentSettings); return; }
  scrollPending = scrollSaving?.enabled === choice.enabled && scrollSaving?.strength === choice.strength ? null : choice;
  if (scrollSettingBusy) { renderScroll(currentSettings); return; }
  scrollSettingBusy = true; renderScroll(currentSettings);
  try {
    while (scrollPending) {
      scrollSaving = scrollPending; scrollPending = null;
      try {
        const result = await messages.send({ type: 'scroll-friction-setting', ...scrollSaving }, 'Unable to save slow scrolling.');
        render(result.settings);
        if (!scrollPending) {
          await notifyTrackers();
          if (!scrollPending) saved(scrollSaving.enabled ? `Scroll resistance saved at ${scrollSaving.strength}%.` : 'Slow scrolling disabled. Your resistance setting is kept.');
        }
      } catch (e) { error(e.message); }
    }
  } finally { scrollSettingBusy = false; scrollSaving = null; renderScroll(currentSettings); }
}
const scrollSlider = $('scroll-friction-strength');
scrollSlider.min = C3.SCROLL_FRICTION_LIMITS.minStrength;
scrollSlider.max = C3.SCROLL_FRICTION_LIMITS.maxStrength;
scrollSlider.step = C3.SCROLL_FRICTION_LIMITS.step;
scrollSlider.addEventListener('input', () => { scrollEditing = true; renderScroll(currentSettings); });
scrollSlider.addEventListener('change', saveScrollSettings);
scrollSlider.addEventListener('blur', () => { scrollEditing = false; renderScroll(currentSettings); });
$('scroll-friction-enabled').addEventListener('change', saveScrollSettings);
$('website-time-enabled').addEventListener('change', async () => {
  const enabled = $('website-time-enabled').checked;
  websiteSettingBusy = true; $('website-time-enabled').disabled = true;
  try {
    if (enabled && !await extensionAPI.permissions.request(WebTime.PERMISSIONS)) throw new Error('Permission declined. Website time remains off.');
    const result = await messages.send({ type: 'website-time-setting', enabled }, 'Unable to change website time.');
    websiteTimeEnabled = result.enabled;
    if (!enabled) await extensionAPI.permissions.remove(WebTime.PERMISSIONS);
    saved(`Website time ${enabled ? 'enabled' : 'disabled'}. Separate from your creation score.`);
  } catch (e) { error(e.message); }
  finally { websiteSettingBusy = false; $('website-time-enabled').checked = websiteTimeEnabled; $('website-time-enabled').disabled = false; void refresh(); }
});
$('allow-above-goal').addEventListener('change', async () => {
  const enabled = $('allow-above-goal').checked;
  goalSettingBusy = true; $('allow-above-goal').disabled = true;
  try {
    await messages.send({ type: 'access-goal-setting', enabled }, 'Unable to save goal-based access.');
    saved(`Goal-based access ${enabled ? 'enabled' : 'disabled'}.`);
    await notifyTrackers();
  } catch (e) { error(e.message); }
  finally { goalSettingBusy = false; $('allow-above-goal').disabled = false; void refresh(); }
});
$('intention-history-enabled').addEventListener('change', async () => {
  intentionSettingBusy = true; $('intention-history-enabled').disabled = true;
  try {
    const enabled = $('intention-history-enabled').checked;
    await messages.send({ type: 'access-history-setting', enabled }, 'Unable to save intention preferences.');
    saved(enabled ? 'New intentions will be saved on this device.' : 'New intentions will not be saved. Existing history is kept.');
  } catch (e) { error(e.message); }
  finally { intentionSettingBusy = false; void refresh(); }
});
async function exportHistory(kind, button) {
  button.disabled = true;
  try {
    const result = await messages.send({ type: 'history', kind, range: 'month' }, 'Unable to export history.');
    const csv = kind === 'ratio' ? C3.csv(result.days) : WebTime.csv(result.days);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `CreateRatio${kind === 'websites' ? '-websites' : ''}-${C3.localDate()}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); saved('History exported.');
  } catch (e) { error(e.message); } finally { button.disabled = false; }
}
$('export-ratio').addEventListener('click', () => exportHistory('ratio', $('export-ratio')));
$('export-websites').addEventListener('click', () => exportHistory('websites', $('export-websites')));
$('clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all recorded activity and website time? This cannot be undone. Export CSV files first if you want a backup.')) return;
  $('clear-history').disabled = true;
  try {
    await messages.send({ type: 'clear-history' }, 'Unable to clear history.');
    saved('History cleared. Your settings and site access boundaries are unchanged.');
  } catch (e) { error(e.message); } finally { $('clear-history').disabled = false; }
});
extensionAPI.storage.onChanged.addListener((changes, area) => { if (RuntimeMessages.shouldRefresh(changes, area)) void refresh(); });
setInterval(refresh, 5000);
void refresh();
