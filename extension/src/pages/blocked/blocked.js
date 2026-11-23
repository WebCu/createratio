'use strict';
const api = globalThis.browser || globalThis.chrome;
const messages = RuntimeMessages.create(api.runtime);
/** @type {(id: string) => HTMLInputElement} */
const $ = id => /** @type {HTMLInputElement} */ (document.getElementById(id));
const site = new URLSearchParams(location.search).get('site');
$('reason').minLength = Core.INTENTION_LIMITS.minLength;
$('reason').maxLength = Core.INTENTION_LIMITS.maxLength;
/** @type {ReplyAccess | undefined} */
let access;
let busy = false,
  refreshing = false;
let accessError = '',
  intentionError = '';
const blockedLines = [
  'The feed can wait. You’ve got this.',
  'Your next idea called. It wants {wait}.',
  'Give your scrolling thumb a breather.',
  'The feed will survive without you.',
  'Plot twist: go make something.',
  'A little less feed. A little more you.',
  'Big ideas start with a little space.',
  'Go give the real world a like.'
];
function nextBlockedLine() {
  let previous = -1;
  const key = 'c3-blocked-line-' + site;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && /^\d+$/.test(saved)) previous = Number(saved);
  } catch (_) {}
  const choices = blockedLines.map((_, index) => index).filter(index => index !== previous);
  const selected = choices[Math.floor(Math.random() * choices.length)];
  try {
    localStorage.setItem(key, String(selected));
  } catch (_) {}
  return blockedLines[selected];
}
const blockedLine = nextBlockedLine();
$('heading').textContent = blockedLine.replace('{wait}', 'a deliberate pause');
function renderError() {
  const message = (!$('request').hidden && intentionError) || accessError;
  const notice = $('error');
  if (notice.textContent !== message) notice.textContent = message;
  notice.hidden = !message;
}
function error(message = '') {
  accessError = message;
  renderError();
}
function clearIntentionError() {
  if (!intentionError) return;
  intentionError = '';
  renderError();
}
/** @param {Milliseconds} milliseconds */
function remaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(Core.secondsFromMilliseconds(milliseconds)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function render() {
  if (!access) return;
  const now = Date.now(),
    active = access.goalAllowed || access.remainingMs > 0;
  const waiting = !active && access.readyAt > 0;
  const waitSeconds =
    typeof access.waitSeconds === 'number' && Number.isFinite(access.waitSeconds) && access.waitSeconds > 0
      ? Core.asSeconds(access.waitSeconds)
      : Core.secondsFromMinutes(Core.DEFAULT_SETTINGS.waitMinutes);
  const waitMinutes = Core.minutesFromSeconds(waitSeconds);
  const waitDuration = `${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}`;
  $('request').setAttribute('aria-label', 'Request access to ' + access.name);
  $('wait-step').textContent = `Pause for ${waitDuration}.`;
  $('begin').textContent = `Start the ${waitMinutes}-minute wait`;
  $('reason-requirement').textContent =
    `${Core.INTENTION_LIMITS.minLength}–${Core.INTENTION_LIMITS.maxLength} characters. A little clarity, then ${waitDuration} to pause.`;
  $('session-step').textContent = `Open a ${access.sessionMinutes}-minute session.`;
  $('heading').textContent = active
    ? `${access.name} is open.`
    : blockedLine.replace('{wait}', waitMinutes === 1 ? 'a minute' : waitDuration);
  $('access-steps').hidden = active;
  const stateText = access.goalAllowed ? 'Above your daily goal' : active ? 'Temporary access' : 'Blocked by default';
  if ($('state-text').textContent !== stateText) $('state-text').textContent = stateText;
  $('description').textContent = access.goalAllowed
    ? `${access.name} is open while today’s creation score is above your current daily target. No intention, wait or timer needed.`
    : active
      ? `Time counts only in the active tab of a focused browser window. When time runs out, all ${access.name} tabs return to this page.`
      : `${access.name} is paused. Set an intention, take a deliberate pause, then open a timed session.`;
  document.title = `${access.name} ${active ? 'session' : 'blocked'} - CreateRatio`;
  if ($('request').hidden !== (active || waiting)) {
    $('request').hidden = active || waiting;
    renderError();
  }
  $('waiting').hidden = !waiting;
  $('active').hidden = !active;
  $('reason').disabled = busy;
  $('begin').disabled = busy;
  $('cancel').disabled = busy;
  $('cancel-pending').disabled = busy;
  $('cancel-pending').hidden = !access.goalAllowed || !access.readyAt;
  $('end').disabled = busy;
  $('end').hidden = !!access.goalAllowed;
  $('return').disabled = busy || !active;
  if (waiting) {
    const untilReady = Core.asMilliseconds(access.readyAt - now);
    const seconds = Math.max(0, Math.ceil(Core.secondsFromMilliseconds(untilReady)));
    $('clock').textContent = remaining(untilReady);
    const progress = /** @type {HTMLProgressElement} */ (document.getElementById('progress'));
    progress.max = waitSeconds;
    progress.value = Math.max(0, waitSeconds - seconds);
    $('open').disabled = busy || seconds > 0;
    $('open').textContent =
      `Open ${access.name} for ${access.sessionMinutes} active minute${access.sessionMinutes === 1 ? '' : 's'}`;
    const message =
      seconds > 0
        ? 'A deliberate pause, not an instant override.'
        : 'Ready when you are. Confirm to start your session.';
    if ($('wait-status').textContent !== message) $('wait-status').textContent = message;
  }
  if (active)
    $('active-time').textContent = access.goalAllowed
      ? 'Blocking returns at or below your current daily target, or on a new day, unless a timed session still has time left.'
      : `${remaining(access.expiresAt ? Core.asMilliseconds(access.expiresAt - now) : access.remainingMs)} remaining${access.expiresAt ? '' : ' · paused'}. All ${access.name} tabs will block again when time runs out.`;
  RefillAnimation.render($('active-countdown'), access.goalAllowed ? { ...access, remainingMs: 0 } : access);
}
/** @param {AccessSessionMessage['type']} type
 * @param {{ reason?: string }} [extra] */
async function send(type, extra = {}) {
  const result = await messages.send({ type, site, ...extra }, 'Unable to check access. The site stays blocked.');
  if (!result.access?.[site]) throw new Error('Open this page by visiting X or LinkedIn.');
  if ('intentionHistoryEnabled' in result && typeof result.intentionHistoryEnabled === 'boolean')
    $('reason-hint').textContent = result.intentionHistoryEnabled
      ? 'Be specific. Your intention is saved on this device. Review or clear it in the dashboard.'
      : 'Be specific. Your intention is not saved. You can enable intention history in Settings.';
  access = result.access[site];
  return access;
}
/** @param {AccessSessionMessage['type']} type
 * @param {{ reason?: string }} [extra] */
async function action(type, extra = {}, navigate = false) {
  if (busy) return;
  const previousRefill = access?.refilledAt || 0;
  const previousFocus = document.activeElement;
  const restoreFocus = target => {
    if (document.activeElement === previousFocus || document.activeElement === document.body) target?.focus();
  };
  let focusTarget = previousFocus;
  busy = true;
  render();
  try {
    await send(type, extra);
    error();
    render();
    focusTarget =
      type === 'access-begin' && !$('waiting').hidden
        ? $('waiting-title')
        : (type === 'access-cancel' || type === 'access-end') && !$('request').hidden
          ? $('reason')
          : null;
    if (type === 'access-cancel' && access.goalAllowed) focusTarget = $('return');
    if (navigate && (access.enabled === false || access.goalAllowed || access.remainingMs > 0)) {
      if (!$('active').hidden) restoreFocus($('active-title'));
      if (
        access.enabled !== false &&
        !access.goalAllowed &&
        type === 'access-open' &&
        access.refilledAt &&
        access.refilledAt !== previousRefill
      )
        await RefillAnimation.waitForFill($('active-countdown'));
      location.replace(access.home);
    }
    if (type === 'access-cancel' || type === 'access-end') {
      $('reason').value = '';
      clearIntentionError();
    }
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
    render();
    restoreFocus(focusTarget);
  }
}
async function refresh() {
  if (busy || refreshing) return;
  refreshing = true;
  try {
    await send('access-status');
    error();
    if (access.enabled === false) {
      location.replace(access.home);
      return;
    }
    render();
  } catch (e) {
    error(e.message);
  } finally {
    refreshing = false;
  }
}
$('reason').addEventListener('input', clearIntentionError);
$('request').addEventListener('submit', event => {
  event.preventDefault();
  const reason = $('reason').value.trim();
  if (!Core.validIntention(reason)) {
    intentionError = `Write a specific intention of ${Core.INTENTION_LIMITS.minLength}–${Core.INTENTION_LIMITS.maxLength} characters.`;
    renderError();
    return;
  }
  if (!$('request').reportValidity()) return;
  clearIntentionError();
  void action('access-begin', { reason });
});
$('open').addEventListener('click', () => action('access-open', {}, true));
$('return').addEventListener('click', () => action('access-status', {}, true));
$('cancel').addEventListener('click', () => action('access-cancel'));
$('cancel-pending').addEventListener('click', () => action('access-cancel'));
$('end').addEventListener('click', () => action('access-end'));
api.storage.onChanged.addListener((changes, area) => {
  if (RuntimeMessages.shouldRefresh(changes, area)) void refresh();
});
addEventListener('focus', refresh);
setInterval(render, 1000);
setInterval(refresh, 5000);
void refresh();
