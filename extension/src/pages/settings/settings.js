'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(extensionAPI.runtime);
const $ = id => document.getElementById(id);
const accessSites = new Set(C3.SITES.filter(site => site.gated).map(site => site.id)), siteControls = new Map();
let currentSettings = C3.DEFAULT_SETTINGS, refreshing = false, websiteSettingBusy = false, goalSettingBusy = false, intentionSettingBusy = false, scrollSettingBusy = false, websiteTimeEnabled = false;
let scrollEditing = false, scrollPending = null, scrollSaving = null;
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; if (message) $('save-status').textContent = ''; }
function saved(message) { error(); $('save-status').textContent = message; }
const durationPresets = [5, 10, 15, 30, 45, 60];
function createAccessField(site) {
  const suffix = site.id ? 'site-' + site.id : 'default';
  const node = document.createElement('div'); node.className = 'site-preference-field';
  const heading = document.createElement('label'); heading.textContent = 'Session time'; heading.className = 'sr-only';
  const line = document.createElement('div'); line.className = 'site-field-value';
  const source = document.createElement('small'); source.id = 'accessMinutes-source-' + suffix; source.className = 'sr-only';
  const input = document.createElement('select'); input.id = 'accessMinutes-' + suffix; heading.htmlFor = input.id;
  input.setAttribute('aria-label', 'Session time for ' + site.name); input.setAttribute('aria-describedby', source.id + ' site-time-note');
  function option(value, text) {
    const item = document.createElement('option'); item.value = String(value); item.textContent = text; input.append(item); return item;
  }
  const defaultOption = site.id ? option('default', 'Default') : null;
  for (const minutes of durationPresets) option(minutes, minutes + ' min');
  const savedOption = option('', ''); savedOption.hidden = true;
  option('custom', 'Custom…');
  input.addEventListener('change', () => saveAccessDuration(site.id)); line.append(input);
  let reset = null;
  if (site.id) {
    reset = document.createElement('button'); reset.type = 'button'; reset.className = 'duration-reset'; reset.id = 'access-reset-' + site.id;
    reset.setAttribute('aria-label', 'Use Default session time for ' + site.name); reset.title = 'Use Default';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 8a6 6 0 1 1 0 6M4 3v5h5'); icon.append(path); reset.append(icon);
    reset.addEventListener('click', () => saveAccessDuration(site.id, true)); line.append(reset);
  }
  const editor = document.createElement('form'); editor.className = 'custom-duration'; editor.id = 'custom-duration-' + suffix; editor.hidden = true;
  const customLabel = document.createElement('label'); customLabel.textContent = 'Custom time'; customLabel.htmlFor = 'customMinutes-' + suffix;
  const custom = document.createElement('input'); custom.type = 'number'; custom.id = customLabel.htmlFor; custom.required = true;
  custom.min = String(C3.ACCESS_LIMITS.minMinutes); custom.max = String(C3.ACCESS_LIMITS.maxMinutes); custom.step = '1';
  custom.setAttribute('aria-label', 'Custom session time for ' + site.name); custom.setAttribute('aria-describedby', 'site-time-note');
  const unit = document.createElement('span'); unit.textContent = 'min';
  const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = 'Save'; apply.id = 'custom-save-' + suffix;
  apply.setAttribute('aria-label', 'Save custom session time for ' + site.name);
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.id = 'custom-cancel-' + suffix;
  cancel.setAttribute('aria-label', 'Cancel custom session time for ' + site.name);
  editor.addEventListener('submit', event => { event.preventDefault(); return saveAccessDuration(site.id, false, true); });
  cancel.addEventListener('click', () => { const control = siteControls.get(site.id); control.access.editing = false; renderSite(control, currentSettings, site.id + ':access'); input.focus(); });
  editor.append(customLabel, custom, unit, apply, cancel); node.append(heading, line, source, editor);
  return { node, input, source, reset, defaultOption, savedOption, editor, custom, apply, cancel, editing: false };
}
function createSite(site) {
  const trackingOnly = !!site.id && !accessSites.has(site.id);
  const row = document.createElement('li'); row.className = 'site-preferences' + (trackingOnly ? ' tracking-only-site' : ''); row.setAttribute('data-site', site.id);
  const header = document.createElement('div'); header.className = 'site-preference-heading';
  const name = document.createElement('h3'); name.textContent = site.id ? site.name : 'Default session'; header.append(name);
  let tracking = null, trackingStatus = null;
  if (site.id) {
    const group = document.createElement('div'); group.className = 'site-tracking';
    const label = document.createElement('label'); label.htmlFor = 'track-' + site.id; label.textContent = trackingOnly ? 'Track' : 'Limit & track';
    if (!trackingOnly) label.className = 'sr-only';
    tracking = document.createElement('input'); tracking.id = label.htmlFor; tracking.type = 'checkbox';
    tracking.setAttribute('role', 'switch'); tracking.setAttribute('aria-label', (trackingOnly ? 'Track creating & consuming' : 'Limit & track') + ' on ' + site.name);
    trackingStatus = document.createElement('small'); trackingStatus.id = 'tracking-status-' + site.id;
    tracking.setAttribute('aria-describedby', (trackingOnly ? 'tracking-only-note ' : '') + trackingStatus.id);
    tracking.addEventListener('change', () => saveTracking(site.id));
    group.append(label, tracking, trackingStatus); header.append(group);
  } else {
    const note = document.createElement('small'); note.textContent = 'Used unless a site has its own time.'; header.append(note);
  }
  const access = trackingOnly ? null : createAccessField(site);
  row.append(header);
  if (access) row.append(access.node);
  $(trackingOnly ? 'tracking-only-settings' : site.id ? 'site-settings' : 'default-settings').append(row);
  return { site, row, access, tracking, trackingStatus, busy: new Set() };
}
function renderSite(control, settings, force) {
  const { site, access } = control;
  const effective = C3.siteSettings(site.id, settings), overridden = Object.hasOwn(settings.siteOverrides?.[site.id] || {}, 'accessMinutes');
  const enabled = !site.id || C3.trackingEnabled(site.id, settings);
  const inactive = !!site.id && !enabled, switching = control.busy.has('tracking');
  control.row.setAttribute('aria-busy', String(control.busy.size > 0));
  control.row.setAttribute('data-enabled', String(enabled));
  if (access) {
    if (access.defaultOption) access.defaultOption.textContent = 'Default · ' + C3.siteSettings('', settings).accessMinutes + ' min';
    access.savedOption.value = String(effective.accessMinutes); access.savedOption.textContent = effective.accessMinutes + ' min';
    access.savedOption.hidden = durationPresets.includes(effective.accessMinutes);
    if (inactive) access.editing = false;
    if (!control.busy.has('access') && (force === site.id + ':access' || document.activeElement !== access.input)) access.input.value = access.editing ? 'custom' : site.id && !overridden ? 'default' : effective.accessMinutes;
    access.input.disabled = control.busy.has('access') || switching || inactive;
    access.source.textContent = !site.id ? 'Default' : overridden ? 'Custom' : 'From Default';
    access.editor.hidden = !access.editing;
    access.custom.disabled = access.apply.disabled = access.cancel.disabled = access.input.disabled;
    if (access.reset) { access.reset.hidden = !overridden; access.reset.disabled = access.input.disabled; }
  }
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
  const { minStrength, maxStrength } = C3.SCROLL_FRICTION_LIMITS;
  slider.style.setProperty('--scroll-fill', `${(strength - minStrength) / (maxStrength - minStrength) * 100}%`);
  slider.setAttribute('aria-valuetext', `${strength}% resistance, ${distance}% of normal scroll distance`);
  $('scroll-resistance').setAttribute('data-enabled', String(toggle.checked));
  $('scroll-friction-value').textContent = `${strength}%`;
  $('scroll-friction-effect').textContent = `Page moves ${distance}% as far${toggle.checked ? '' : ' when enabled'}.`;
}
function render(settings, force = '') {
  currentSettings = settings;
  if (!siteControls.size) {
    $('default-settings').replaceChildren(); $('site-settings').replaceChildren(); $('tracking-only-settings').replaceChildren();
    $('tracking-only-section').hidden = !C3.SITES.some(site => !site.gated);
  }
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
  $('website-status').textContent = websiteTimeEnabled ? 'Website time is on. See domain totals in the dashboard.' : '';
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
async function saveAccessDuration(site, reset = false, custom = false) {
  const control = siteControls.get(site), access = control.access, input = access.input;
  if (control.busy.has('access') || input.disabled) return;
  if (!reset && !custom && input.value === 'custom') {
    access.editing = true; access.custom.value = C3.siteSettings(site, currentSettings).accessMinutes;
    $('save-status').textContent = ''; error(); renderSite(control, currentSettings); access.custom.focus(); return;
  }
  const field = custom ? access.custom : input;
  const minutes = reset || !custom && site && input.value === 'default' ? null : Number(field.value);
  if (minutes !== null && (!field.reportValidity() || !C3.validAccessMinutes(minutes))) { error(`Choose a whole number from ${C3.ACCESS_LIMITS.minMinutes} to ${C3.ACCESS_LIMITS.maxMinutes} minutes.`); return; }
  if (await saveSitePreference(control, 'access', { type: 'access-duration', minutes, ...(site ? { site } : {}) })) {
    if (access.editing) { access.editing = false; renderSite(control, currentSettings, site + ':access'); input.focus(); }
  }
}
async function saveTracking(site) {
  const control = siteControls.get(site);
  if (control.busy.has('tracking')) return;
  await saveSitePreference(control, 'tracking', { type: 'tracking', site, enabled: control.tracking.checked });
}
async function saveSitePreference(control, group, message) {
  const site = control.site.id, input = control.access?.input;
  control.busy.add(group); control.row.setAttribute('aria-busy', 'true');
  if (group === 'tracking') {
    control.tracking.disabled = true; control.trackingStatus.textContent = control.tracking.checked ? 'On' : 'Off';
  }
  if (input) {
    input.disabled = true;
    control.access.custom.disabled = control.access.apply.disabled = control.access.cancel.disabled = true;
  }
  if (control.access?.reset) control.access.reset.disabled = true;
  let success = false;
  try {
    const result = await messages.send(message, 'Unable to save settings.');
    const snapshot = message.type === 'tracking' ? result : await messages.send({ type: 'snapshot' }, 'Unable to load your saved settings.');
    render(snapshot.settings);
    if (group === 'tracking') {
      const description = accessSites.has(site)
        ? message.enabled ? 'Limit & track is on.' : 'Limit & track is off.'
        : message.enabled ? 'Creating/consuming and action measurements are on.' : 'Creation-score tracking is off.';
      saved(`${control.site.name}: ${description} Your history is kept.`);
    } else saved(`${control.site.name} session time saved for new sessions and midnight refills.`);
    if (group === 'tracking') await notifyTrackers();
    success = true;
  } catch (e) { error(e.message); }
  finally { control.busy.delete(group); render(currentSettings, site + ':' + group); }
  return success;
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
