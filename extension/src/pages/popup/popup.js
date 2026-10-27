'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(extensionAPI.runtime);
const $ = id => document.getElementById(id);
let refreshing = false, refreshFailed = false;
const accessControls = new Map();
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; refreshFailed = false; if (message) $('access-save-status').textContent = ''; }
function minutes(sec) { return (sec / 60).toFixed(1) + 'm'; }
function createAccessControl(site, state) {
  const row = document.createElement('div'); row.className = 'access-row';
  row.setAttribute('role', 'group'); row.setAttribute('aria-label', state.name + ' access');
  const label = document.createElement('span'), name = document.createElement('strong'), status = document.createElement('small');
  label.className = 'refill-target'; status.id = 'access-status-' + site;
  name.textContent = state.name; label.append(name, status);
  const durationLabel = document.createElement('label'); durationLabel.className = 'access-duration';
  const duration = document.createElement('input'); duration.type = 'number'; duration.id = 'session-time-' + site;
  duration.min = String(C3.ACCESS_LIMITS.minMinutes); duration.max = String(C3.ACCESS_LIMITS.maxMinutes); duration.step = '1';
  duration.setAttribute('aria-label', 'Session time for ' + state.name);
  duration.setAttribute('aria-describedby', 'access-time-note');
  const unit = document.createElement('span'); unit.textContent = 'min';
  durationLabel.append(duration, unit); label.append(durationLabel);
  const button = document.createElement('button');
  button.setAttribute('aria-describedby', status.id);
  const control = { row, label, status, button, duration, state, busy: false, durationBusy: false };
  duration.addEventListener('change', async () => {
    if (control.durationBusy || duration.disabled) return;
    const minutes = Number(duration.value);
    if (!duration.reportValidity() || !C3.validAccessMinutes(minutes)) {
      error(`Choose a whole number from ${C3.ACCESS_LIMITS.minMinutes} to ${C3.ACCESS_LIMITS.maxMinutes} minutes.`);
      duration.value = control.state.sessionMinutes; return;
    }
    control.durationBusy = true; duration.disabled = true; $('access-save-status').textContent = '';
    try {
      const result = await messages.send({ type: 'access-duration', site, minutes }, 'Unable to save session time.');
      renderAccess(result.access);
      $('access-save-status').textContent = `${control.state.name}: ${minutes} min saved for new sessions and daily refills.`;
      error();
    } catch (e) { error(e.message); }
    finally {
      control.durationBusy = false; duration.value = control.state.sessionMinutes;
      duration.disabled = control.state.enabled === false;
    }
  });
  button.addEventListener('click', async () => {
    control.busy = true; button.disabled = true;
    try {
      if (control.state.enabled === false || control.state.goalAllowed) await extensionAPI.tabs.create({ url: control.state.home });
      else if (control.state.remainingMs > 0) {
        const result = await messages.send({ type: 'access-end', site }, 'Unable to end session.');
        renderAccess(result.access);
      } else await extensionAPI.tabs.create({ url: extensionAPI.runtime.getURL('blocked.html') + '?site=' + site });
      error();
    } catch (e) { error(e.message); }
    finally { control.busy = false; button.disabled = false; }
  });
  row.append(label, button); $('access-sites').append(row);
  return control;
}
function renderAccess(access) {
  if (!accessControls.size && Object.keys(access).length) $('access-sites').replaceChildren();
  for (const [site, state] of Object.entries(access)) {
    let control = accessControls.get(site);
    if (!control) { control = createAccessControl(site, state); accessControls.set(site, control); }
    control.state = state;
    const { status, button, duration } = control;
    control.row.setAttribute('data-state', state.enabled === false ? 'off' : state.goalAllowed || state.remainingMs > 0 ? 'open' : 'blocked');
    if (!control.durationBusy && document.activeElement !== duration) duration.value = state.sessionMinutes;
    duration.disabled = control.durationBusy || state.enabled === false;
    const open = state.remainingMs > 0;
    const left = state.expiresAt ? Math.max(0, state.expiresAt - Date.now()) : state.remainingMs;
    const seconds = Math.ceil(left / 1000);
    status.textContent = state.enabled === false ? 'Limit & track off' : state.goalAllowed ? 'Open · above daily goal' : open ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left${state.expiresAt ? '' : ' · paused'}` : state.readyAt ? 'Access requested' : 'Blocked';
    button.textContent = state.enabled === false || state.goalAllowed ? 'Open site' : open ? 'End session' : 'Request access';
    button.setAttribute('aria-label', state.enabled === false || state.goalAllowed ? 'Open site: ' + state.name : open ? 'End session for ' + state.name : 'Request access to ' + state.name);
    button.disabled = control.busy;
    RefillAnimation.render(control.label, state.goalAllowed ? { ...state, remainingMs: 0 } : state);
  }
}
function render(snapshot) {
  const total = C3.aggregate(snapshot.day), score = C3.score(total);
  const hasActivity = ['createSec', 'consumeSec', 'posts', 'replies', 'comments'].some(key => total[key] > 0);
  $('date').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); $('date').dateTime = snapshot.date;
  $('score').textContent = score.toFixed(2); $('score').style.color = hasActivity ? C3.scoreColor(score) : '';
  $('score-status').textContent = !hasActivity ? 'A fresh start. Make something today.' : score >= 1 ? 'You’re making more than you’re taking in.' : 'A little more creating gets you to 1.0.';
  $('create-min').textContent = minutes(total.createSec); $('consume-min').textContent = minutes(total.consumeSec);
  renderAccess(snapshot.access);
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const snapshot = await messages.send({ type: 'snapshot' }, 'Unable to load your data.');
    render(snapshot);
    if (refreshFailed) error();
  } catch (e) { error(e.message); refreshFailed = true; } finally { refreshing = false; }
}
$('settings').disabled = false;
$('settings').addEventListener('click', async () => {
  try { await extensionAPI.runtime.openOptionsPage(); }
  catch (e) { error(e.message); }
});
const sharing = SocialSharing.mount({ messages, range: () => 'today', error(message = '') { $('share-error').textContent = message; $('share-error').hidden = !message; } });
extensionAPI.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, '_historyReset')) sharing.clear();
  if (RuntimeMessages.shouldRefresh(changes, area)) void refresh();
});
setInterval(refresh, 1000);
void refresh();
