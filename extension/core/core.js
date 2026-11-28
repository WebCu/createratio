(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../sites/index.js') : root.Sites);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(globalThis, function (integrations) {
  'use strict';
  const FIELDS = /** @type {const} */ ([
    'consumeSec',
    'createSec',
    'posts',
    'replies',
    'comments',
    'likes',
    'bookmarks',
    'quotes',
    'reposts'
  ]);
  const { sites: SITES, validSiteId } = /** @type {typeof Sites} */ (integrations);
  const ACCESS_LIMITS = {
    minMinutes: /** @type {AccessMinutes} */ (1),
    maxMinutes: /** @type {AccessMinutes} */ (240)
  };
  const INTENTION_LIMITS = { minLength: 20, maxLength: 280 };
  const SCROLL_FRICTION_LIMITS = { minStrength: 50, maxStrength: 95, step: 5 };
  const DELIVERY_LIMITS = { maxPackets: 64, maxItems: 64, maxSeconds: 3600, maxIdLength: 100, receiptLimit: 512 };
  /** @returns {value is Intention} */
  function validIntention(value) {
    return (
      typeof value === 'string' &&
      value === value.trim() &&
      value.length >= INTENTION_LIMITS.minLength &&
      value.length <= INTENTION_LIMITS.maxLength
    );
  }
  /** @returns {Intention | null} */
  function intentionFromText(value) {
    if (typeof value !== 'string' || value.length > INTENTION_LIMITS.maxLength) return null;
    const text = value.trim();
    return validIntention(text) ? text : null;
  }
  /** @returns {value is AccessMinutes} */
  function validAccessMinutes(value) {
    return Number.isInteger(value) && value >= ACCESS_LIMITS.minMinutes && value <= ACCESS_LIMITS.maxMinutes;
  }
  /** @param {Minutes} minutes */
  function millisecondsFromMinutes(minutes) {
    return /** @type {Milliseconds} */ (minutes * 60000);
  }
  /** @param {Milliseconds} milliseconds */
  function secondsFromMilliseconds(milliseconds) {
    return /** @type {Seconds} */ (milliseconds / 1000);
  }
  /** @param {Milliseconds} milliseconds */
  function minutesFromMilliseconds(milliseconds) {
    return /** @type {Minutes} */ (milliseconds / 60000);
  }
  /** @param {Minutes} minutes */
  function secondsFromMinutes(minutes) {
    return /** @type {Seconds} */ (minutes * 60);
  }
  /** @param {Seconds} seconds */
  function millisecondsFromSeconds(seconds) {
    return /** @type {Milliseconds} */ (seconds * 1000);
  }
  /** @param {Seconds} seconds */
  function minutesFromSeconds(seconds) {
    return /** @type {Minutes} */ (seconds / 60);
  }
  /** @param {number} milliseconds */
  function asMilliseconds(milliseconds) {
    return /** @type {Milliseconds} */ (milliseconds);
  }
  /** @param {number} seconds */
  function asSeconds(seconds) {
    return /** @type {Seconds} */ (seconds);
  }
  /** @param {number} minutes */
  function asMinutes(minutes) {
    return /** @type {Minutes} */ (minutes);
  }
  /** @param {number} time */
  function asEpochTime(time) {
    return /** @type {EpochTime} */ (time);
  }
  /** @param {number} time */
  function asPageTime(time) {
    return /** @type {PageTime} */ (time);
  }
  /**
   * @template {EpochTime | PageTime} T
   * @param {T} time
   * @param {Milliseconds} duration
   * @returns {T}
   */
  function timeAfter(time, duration) {
    return /** @type {T} */ (time + duration);
  }
  /**
   * @template {EpochTime | PageTime} T
   * @param {T} start
   * @param {NoInfer<T>} end
   */
  function millisecondsBetween(start, end) {
    return asMilliseconds(end - start);
  }
  /**
   * @param {EpochTime} epochTime
   * @param {PageTime} pageTime
   */
  function pageOriginFromClocks(epochTime, pageTime) {
    return asEpochTime(epochTime - pageTime);
  }
  /**
   * @param {PageTime} pageTime
   * @param {EpochTime} pageOrigin
   */
  function epochTimeFromPageTime(pageTime, pageOrigin) {
    return asEpochTime(pageOrigin + pageTime);
  }
  function validScrollFrictionStrength(value) {
    return (
      Number.isInteger(value) &&
      value >= SCROLL_FRICTION_LIMITS.minStrength &&
      value <= SCROLL_FRICTION_LIMITS.maxStrength &&
      value % SCROLL_FRICTION_LIMITS.step === 0
    );
  }
  /** @type {Record<AccessPreference, true>} */
  const ACCESS_PREFERENCES = { accessMinutes: true, waitMinutes: true };
  const ACCESS_PREFERENCE_KEYS = Object.keys(ACCESS_PREFERENCES);
  const DEFAULT_SETTINGS = {
    accessMinutes: /** @type {AccessMinutes} */ (5),
    waitMinutes: /** @type {AccessMinutes} */ (5),
    dailyTarget: /** @type {DailyTarget} */ (1),
    allowAboveGoal: false,
    intentionHistoryEnabled: false,
    scrollFrictionEnabled: true,
    scrollFrictionStrength: 50,
    trackedSites: /** @type {string[]} */ (SITES.filter(site => site.defaultEnabled).map(site => site.id))
  };
  /** @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function trackingSelection(settings) {
    const selected = isRecord(settings) ? settings.trackedSites : undefined;
    return selected === undefined ? DEFAULT_SETTINGS.trackedSites : Array.isArray(selected) ? selected : [];
  }
  /** @param {StoredSettings} [settings] */
  function settingsSnapshot(settings = {}) {
    if (!isRecord(settings)) settings = {};
    /** @type {typeof DEFAULT_SETTINGS & { siteOverrides?: Record<string, Record<string, unknown>>, nudgeEnabled?: unknown, nudgeMinutes?: unknown }} */
    const resolved = { ...DEFAULT_SETTINGS, ...settings };
    resolved.dailyTarget = dailyTarget(settings);
    resolved.trackedSites = trackingSelection(settings).filter(site => typeof site === 'string');
    for (const key of ACCESS_PREFERENCE_KEYS)
      if (!validAccessMinutes(resolved[key])) resolved[key] = DEFAULT_SETTINGS[key];
    if (resolved.scrollFrictionStrength === 0) resolved.scrollFrictionEnabled = false;
    if (!validScrollFrictionStrength(resolved.scrollFrictionStrength))
      resolved.scrollFrictionStrength = DEFAULT_SETTINGS.scrollFrictionStrength;
    for (const key of ['allowAboveGoal', 'intentionHistoryEnabled', 'scrollFrictionEnabled'])
      if (typeof resolved[key] !== 'boolean') resolved[key] = DEFAULT_SETTINGS[key];
    delete resolved.nudgeEnabled;
    delete resolved.nudgeMinutes;
    if (Object.hasOwn(resolved, 'siteOverrides'))
      resolved.siteOverrides = Object.fromEntries(
        Object.entries(isRecord(resolved.siteOverrides) ? resolved.siteOverrides : {})
          .filter(([, preferences]) => isRecord(preferences))
          .map(([site, preferences]) => {
            const overrides = { ...preferences };
            for (const key of ACCESS_PREFERENCE_KEYS) if (!validAccessMinutes(overrides[key])) delete overrides[key];
            delete overrides.nudgeEnabled;
            delete overrides.nudgeMinutes;
            return [site, overrides];
          })
          .filter(([, overrides]) => Object.keys(overrides).length)
      );
    return resolved;
  }
  function siteSettings(site, settings = {}) {
    const resolved = settingsSnapshot(settings);
    const overrides = Object.hasOwn(resolved.siteOverrides || {}, site) ? resolved.siteOverrides[site] : {};
    for (const key of ACCESS_PREFERENCE_KEYS) if (overrides?.[key] !== undefined) resolved[key] = overrides[key];
    return resolved;
  }
  function updatePreferences(settings = {}, changes, site) {
    if (!isRecord(settings)) settings = {};
    if (!isRecord(changes)) throw new Error('Choose valid preferences');
    if (site !== undefined && !SITES.some(definition => definition.id === site))
      throw new Error('Choose a vetted website');
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(ACCESS_PREFERENCES, key)) throw new Error('Unsupported preference');
      if (value === null && site !== undefined) continue;
      if (!validAccessMinutes(value))
        throw new Error(
          `Choose a whole number from ${ACCESS_LIMITS.minMinutes} to ${ACCESS_LIMITS.maxMinutes} minutes`
        );
    }
    if (site === undefined) return { ...DEFAULT_SETTINGS, ...settings, ...changes };
    const siteOverrides = { ...(isRecord(settings.siteOverrides) ? settings.siteOverrides : {}) };
    const overrides = { ...(isRecord(siteOverrides[site]) ? siteOverrides[site] : {}) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete overrides[key];
      else overrides[key] = value;
    }
    if (Object.keys(overrides).length) siteOverrides[site] = overrides;
    else delete siteOverrides[site];
    return { ...DEFAULT_SETTINGS, ...settings, siteOverrides };
  }
  function trackingEnabled(site, settings = {}) {
    return SITES.some(definition => definition.id === site) && trackingSelection(settings).includes(site);
  }
  function recordedSites(day = {}) {
    return Object.keys(isRecord(day) ? day : {}).filter(validSiteId);
  }
  /** @returns {CreationStats} */
  function emptyStats() {
    return statsSnapshot(undefined);
  }
  function nonnegative(n) {
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  function knownStats(stats) {
    return Object.fromEntries(FIELDS.map(key => [key, nonnegative(stats?.[key])]));
  }
  /** @returns {CreationStats} */
  function statsSnapshot(stats) {
    return /** @type {CreationStats} */ (knownStats(stats));
  }
  /** @returns {CreationStats} */
  function sumStats(rows) {
    const sums = Object.fromEntries(FIELDS.map(key => [key, 0]));
    for (const row of rows) for (const key of FIELDS) sums[key] += nonnegative(row?.[key]);
    return statsSnapshot(sums);
  }
  /** @returns {CreationStats} */
  function aggregate(day = {}) {
    return sumStats(recordedSites(day).map(id => day[id]));
  }
  /**
   * @param {unknown} value
   * @returns {CreationDay}
   */
  function creationDayFromStored(value) {
    const rows = Object.entries(isRecord(value) ? value : {}).map(([site, row]) => {
      if (!isRecord(row)) return [site, {}];
      const known = knownStats(row);
      return [
        site,
        Object.fromEntries(
          Object.entries(row).map(([key, field]) => [key, Object.hasOwn(known, key) ? known[key] : field])
        )
      ];
    });
    return /** @type {CreationDay} */ (Object.fromEntries(rows));
  }
  /**
   * @param {unknown} stored
   * @param {string} site
   * @param {Pick<TimeSegment, 'mode' | 'sec'>[]} segments
   * @param {Pick<SiteActionEntry, 'action'>[]} actions
   * @returns {Record<string, unknown>}
   */
  function creditCreationDay(stored, site, segments, actions) {
    const day = isRecord(stored) ? stored : {};
    const row = isRecord(day[site]) ? day[site] : {};
    const totals = knownStats(row);
    for (const segment of segments) totals[segment.mode + 'Sec'] += segment.sec;
    for (const { action } of actions) {
      totals[action] += 1;
      if (action === 'quotes') totals.posts += 1;
    }
    return { ...day, [site]: { ...row, ...totals } };
  }
  /**
   * @param {CreationStats} stats
   * @returns {CreationScore}
   */
  function score(stats) {
    return /** @type {CreationScore} */ (
      (nonnegative(stats.createSec) +
        120 * (nonnegative(stats.posts) + nonnegative(stats.replies) + nonnegative(stats.comments))) /
        Math.max(nonnegative(stats.consumeSec), 1)
    );
  }
  /** @returns {value is DailyTarget} */
  function validDailyTarget(value) {
    return (
      Number.isFinite(value) && value >= 0.1 && value <= 100 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9
    );
  }
  /** @returns {DailyTarget} */
  function dailyTarget(settings = {}) {
    const value = settings?.dailyTarget;
    return validDailyTarget(value) ? value : DEFAULT_SETTINGS.dailyTarget;
  }
  /**
   * @param {CreationScore} value
   * @param {DailyTarget} target
   */
  function aboveDailyTarget(value, target) {
    return value > target;
  }
  const SCORE_COLORS = { high: '#16804a', mid: '#b77900', low: '#be3f43' };
  /** @param {CreationScore} value */
  function scoreBand(value) {
    return value >= 1 ? 'high' : value >= 0.5 ? 'mid' : 'low';
  }
  /** @param {CreationScore} value */
  function scoreColor(value) {
    return SCORE_COLORS[scoreBand(value)];
  }
  /** @param {CreationScore} value */
  function badgeText(value) {
    return value >= 100 ? '99+' : value >= 10 ? value.toFixed(0) : value.toFixed(1);
  }
  function localDate(date = new Date()) {
    return /** @type {LocalDate} */ (
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    );
  }
  /** @returns {value is LocalDate} */
  function validLocalDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return (
      value.length === 10 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    );
  }
  function recentDates(count = 7, now = new Date()) {
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (count - 1 - i));
      return localDate(d);
    });
  }
  function siteForURL(raw) {
    return integrations.forURL(raw)?.id || null;
  }
  function classifyPage(state) {
    return integrations.forURL(state.url)?.classifyPage(state) || 'neutral';
  }
  /** @param {{ start: PageTime, end: PageTime, lastInput: PageTime | null, visible: boolean, focused: boolean, mode: string }} sample */
  function activeMilliseconds({ start, end, lastInput, visible, focused, mode }) {
    if (
      lastInput === null ||
      !visible ||
      !focused ||
      !['create', 'consume'].includes(mode) ||
      end < start ||
      end - start > 15000
    )
      return 0;
    return Math.max(0, Math.min(end, lastInput + 30000) - Math.max(start, lastInput));
  }
  /**
   * @param {EpochTime} start
   * @param {EpochTime} end
   */
  function splitInterval(start, end) {
    const parts = [];
    for (let cursor = start; cursor < end; ) {
      const date = new Date(cursor);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const partEnd = asEpochTime(Math.min(end, midnight));
      parts.push({ date: localDate(date), sec: secondsFromMilliseconds(millisecondsBetween(cursor, partEnd)) });
      cursor = partEnd;
    }
    return parts;
  }
  function csv(all) {
    const columns = ['date', 'site', ...FIELDS, 'score'];
    const rows = [columns.join(',')];
    for (const date of Object.keys(all)
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()) {
      for (const site of new Set([...SITES.map(site => site.id), ...recordedSites(all[date])])) {
        const stats = statsSnapshot(all[date][site]);
        rows.push(
          [date, site, ...FIELDS.map(k => stats[k].toFixed(k.endsWith('Sec') ? 3 : 0)), score(stats).toFixed(3)].join(
            ','
          )
        );
      }
    }
    return rows.join('\r\n') + '\r\n';
  }
  return {
    FIELDS,
    SITES,
    ACCESS_LIMITS,
    INTENTION_LIMITS,
    DELIVERY_LIMITS,
    SCROLL_FRICTION_LIMITS,
    validScrollFrictionStrength,
    validAccessMinutes,
    millisecondsFromMinutes,
    secondsFromMilliseconds,
    minutesFromMilliseconds,
    secondsFromMinutes,
    millisecondsFromSeconds,
    minutesFromSeconds,
    asMilliseconds,
    asSeconds,
    asMinutes,
    asEpochTime,
    asPageTime,
    timeAfter,
    millisecondsBetween,
    pageOriginFromClocks,
    epochTimeFromPageTime,
    validIntention,
    intentionFromText,
    DEFAULT_SETTINGS,
    settingsSnapshot,
    siteSettings,
    updatePreferences,
    trackingEnabled,
    recordedSites,
    emptyStats,
    statsSnapshot,
    sumStats,
    aggregate,
    creationDayFromStored,
    creditCreationDay,
    score,
    validDailyTarget,
    dailyTarget,
    aboveDailyTarget,
    scoreBand,
    scoreColor,
    badgeText,
    localDate,
    validLocalDate,
    recentDates,
    siteForURL,
    classifyPage,
    activeMilliseconds,
    splitInterval,
    csv
  };
});
