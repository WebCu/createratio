(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../core/core.js') : root.Core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SiteAccessModel = api;
})(globalThis, function (Core) {
  'use strict';
  /** @typedef {{ phase: 'request', readyAt: EpochTime, waitMs: Milliseconds | null }} AccessRequest */
  /** @typedef {{ phase: 'session', remainingMs: Milliseconds | null, expiresAt: EpochTime | null, refilledAt: EpochTime | null, date: LocalDate | null, goalActive: boolean }} AccessSession */
  /** @typedef {AccessRequest | AccessSession | null} SiteAccessState */
  /** @typedef {{ now: EpochTime, date: LocalDate, dayStart: EpochTime, midnight: EpochTime, restart: boolean, enabled: boolean, goalAllowed: boolean, focused: boolean, accessMinutes: Minutes, hasRules: boolean, hasWindows: boolean, closeAll: boolean }} AccessFacts */
  /** @typedef {{ state: SiteAccessState, rules: 'unrestricted' | 'session' | 'none', alarmAt: EpochTime, expire: boolean, window: { start: EpochTime, end: EpochTime } | null, clearWindows: boolean }} AccessDecision */
  const MAXIMUM_BUDGET = Core.millisecondsFromMinutes(Core.ACCESS_LIMITS.maxMinutes);
  const OPEN_WINDOW_END = Core.asEpochTime(Number.MAX_SAFE_INTEGER);
  const SESSION_FIELDS = ['remainingMs', 'expiresAt', 'refilledAt'];
  /**
   * @param {unknown} value
   * @returns {value is Record<string, any>}
   */
  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function validSession(raw, now) {
    return (
      (!Object.hasOwn(raw, 'date') || Core.validLocalDate(raw.date)) &&
      SESSION_FIELDS.every(field => !Object.hasOwn(raw, field) || (Number.isFinite(raw[field]) && raw[field] >= 0)) &&
      (!Object.hasOwn(raw, 'remainingMs') || raw.remainingMs <= MAXIMUM_BUDGET) &&
      (Object.hasOwn(raw, 'remainingMs') || !Object.hasOwn(raw, 'expiresAt') || raw.expiresAt - now <= MAXIMUM_BUDGET)
    );
  }
  function validWaitDuration(value) {
    return Number.isFinite(value) && Core.validAccessMinutes(Core.minutesFromMilliseconds(value));
  }
  function waitDurationFromStored(value) {
    const wait = Core.asMilliseconds(value);
    return validWaitDuration(wait) ? wait : Core.millisecondsFromMinutes(Core.ACCESS_LIMITS.minMinutes);
  }
  function validWait(raw, now) {
    return Number.isFinite(raw.readyAt) && raw.readyAt > 0 && raw.readyAt <= now + waitDurationFromStored(raw.waitMs);
  }
  /** @returns {EpochTime | null} */
  function epochTimeOrNull(value) {
    return Number.isFinite(value) ? Core.asEpochTime(value) : null;
  }
  /**
   * @param {unknown} raw
   * @param {EpochTime} now
   * @returns {SiteAccessState}
   */
  function siteAccessFromStored(raw, now) {
    if (!record(raw) || !validSession(raw, now)) return null;
    const hasDate = Object.hasOwn(raw, 'date');
    const remaining = Number.isFinite(raw.remainingMs)
      ? raw.remainingMs
      : Number.isFinite(raw.expiresAt)
        ? Math.max(0, raw.expiresAt - now)
        : null;
    const session = () =>
      /** @type {AccessSession} */ ({
        phase: 'session',
        remainingMs: remaining === null ? null : Core.asMilliseconds(remaining),
        expiresAt: epochTimeOrNull(raw.expiresAt),
        refilledAt: epochTimeOrNull(raw.refilledAt),
        date: hasDate ? raw.date : null,
        goalActive: raw.goalActive === true
      });
    if (remaining > 0 || raw.refilledAt > 0 || hasDate) return session();
    if (validWait(raw, now))
      return {
        phase: 'request',
        readyAt: Core.asEpochTime(raw.readyAt),
        waitMs: validWaitDuration(raw.waitMs) ? Core.asMilliseconds(raw.waitMs) : null
      };
    return Number.isFinite(raw.remainingMs) || Number.isFinite(raw.expiresAt) ? session() : null;
  }
  /**
   * @param {SiteAccessState} state
   * @returns {Record<string, unknown> | undefined}
   */
  function storedFromSiteAccess(state) {
    if (state === null) return undefined;
    const fields =
      state.phase === 'request'
        ? { readyAt: state.readyAt, waitMs: state.waitMs }
        : {
            remainingMs: state.remainingMs,
            expiresAt: state.expiresAt,
            refilledAt: state.refilledAt,
            date: state.date,
            goalActive: state.goalActive || null
          };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  }
  /** @param {AccessRequest} request */
  function waitDuration(request) {
    return waitDurationFromStored(request.waitMs);
  }
  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  function sameStoredEntry(a, b) {
    if (!record(a) || !record(b)) return a === b;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
    );
  }
  /**
   * @param {SiteAccessState} state
   * @param {Milliseconds} waitMilliseconds
   * @param {EpochTime} now
   * @returns {SiteAccessState}
   */
  function requestAccess(state, waitMilliseconds, now) {
    if (state?.phase === 'request' || (state?.phase === 'session' && state.remainingMs)) return state;
    return { phase: 'request', readyAt: Core.timeAfter(now, waitMilliseconds), waitMs: waitMilliseconds };
  }
  /**
   * @param {SiteAccessState} state
   * @returns {SiteAccessState}
   */
  function cancelRequest(state) {
    return state?.phase === 'request' ? null : state;
  }
  /**
   * @param {SiteAccessState} state
   * @param {Minutes} sessionMinutes
   * @param {EpochTime} now
   * @returns {{ ready: true, state: AccessSession } | { ready: false }}
   */
  function confirmRequest(state, sessionMinutes, now) {
    if (state?.phase !== 'request' || now < state.readyAt) return { ready: false };
    return {
      ready: true,
      state: {
        phase: 'session',
        remainingMs: Core.millisecondsFromMinutes(sessionMinutes),
        expiresAt: Core.UNSET_EPOCH_TIME,
        refilledAt: now,
        date: null,
        goalActive: false
      }
    };
  }
  /**
   * @param {SiteAccessState} state
   * @param {AccessFacts} facts
   * @returns {AccessDecision}
   */
  function reconcileSiteAccess(state, facts) {
    const { now, date, dayStart, midnight, restart, goalAllowed, focused } = facts;
    if (!facts.enabled)
      return {
        state: null,
        rules: 'unrestricted',
        alarmAt: Core.UNSET_EPOCH_TIME,
        expire: false,
        window: null,
        clearWindows: true
      };
    const budget = state?.phase === 'session' ? state : null;
    let remaining = budget?.remainingMs ?? null;
    let expiresAt = budget?.expiresAt ?? null;
    let refilledAt = budget?.refilledAt ?? null;
    let sessionDate = budget?.date ?? null;
    let goalActive = budget?.goalActive ?? false;
    let windowStart = now;
    const hadSession = remaining !== null || expiresAt !== null;
    if (sessionDate && sessionDate !== date) {
      const runningAtMidnight =
        !restart && ((expiresAt !== null && expiresAt >= dayStart) || (!goalAllowed && goalActive));
      const pausedAtMidnight = !restart && remaining > 0 && !expiresAt;
      if (runningAtMidnight || pausedAtMidnight) windowStart = dayStart;
      remaining = Core.millisecondsFromMinutes(facts.accessMinutes);
      refilledAt = dayStart;
      expiresAt = runningAtMidnight ? Core.timeAfter(dayStart, remaining) : Core.UNSET_EPOCH_TIME;
    }
    const authorizedUntil = expiresAt;
    goalActive = goalAllowed && focused && remaining > 0;
    if (remaining > 0) sessionDate = date;
    if (!restart && expiresAt)
      remaining = Core.asMilliseconds(Math.min(remaining, Math.max(0, Core.millisecondsBetween(now, expiresAt))));
    let rules = /** @type {AccessDecision['rules']} */ ('none'),
      alarmAt = Core.UNSET_EPOCH_TIME,
      expire = false;
    if (goalAllowed || remaining > 0) {
      expiresAt = !goalAllowed && focused ? Core.timeAfter(now, remaining) : Core.UNSET_EPOCH_TIME;
      rules = 'session';
      alarmAt = expiresAt;
    } else {
      expire = hadSession || facts.closeAll || facts.hasRules;
      expiresAt = null;
      remaining = null;
    }
    const window =
      facts.hasWindows || refilledAt > 0 || expiresAt || goalAllowed
        ? {
            start: windowStart,
            end: goalAllowed
              ? midnight
              : remaining > 0 && !expiresAt
                ? OPEN_WINDOW_END
                : expiresAt || Core.asEpochTime(Math.min(now, authorizedUntil || now))
          }
        : null;
    const next =
      state?.phase === 'request'
        ? state
        : budget === null ||
            (remaining === null && expiresAt === null && refilledAt === null && sessionDate === null && !goalActive)
          ? null
          : /** @type {AccessSession} */ ({
              phase: 'session',
              remainingMs: remaining,
              expiresAt,
              refilledAt,
              date: sessionDate,
              goalActive
            });
    return { state: next, rules, alarmAt, expire, window, clearWindows: false };
  }
  return {
    reconcileSiteAccess,
    siteAccessFromStored,
    storedFromSiteAccess,
    waitDuration,
    sameStoredEntry,
    requestAccess,
    cancelRequest,
    confirmRequest
  };
});
