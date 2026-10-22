'use strict';
const extensionAPI = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(extensionAPI.runtime);
const $ = id => document.getElementById(id);
let refreshing = false;
const accessControls = new Map();
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function minutes(sec) { return (sec / 60).toFixed(1) + 'm'; }
function createAccessControl(site, state) {
  const row = document.createElement('div'); row.className = 'access-row';
  row.setAttribute('role', 'group'); row.setAttribute('aria-label', state.name + ' access');
  const label = document.createElement('span'), name = document.createElement('strong'), status = document.createElement('small');
  label.className = 'refill-target'; status.id = 'access-status-' + site;
  name.textContent = state.name; label.append(name, status);
  const button = document.createElement('button');
  button.setAttribute('aria-describedby', status.id);
  const control = { label, status, button, state, busy: false };
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
    const { status, button } = control;
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
    error();
  } catch (e) { error(e.message); } finally { refreshing = false; }
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
