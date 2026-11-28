(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../core/core.js') : root.Core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SiteAccessModel = api;
})(globalThis, function (Core) {
  'use strict';
  /** @typedef {{ phase: 'request', readyAt: EpochTime, waitMs: Milliseconds | null }} AccessRequest */
  /** @typedef {{ running: true, expiresAt: EpochTime } | { running: false }} SessionClock */
  /** @typedef {{ phase: 'session', remainingMs: Milliseconds | null, clock: SessionClock | null, refilledAt: EpochTime | null, date: LocalDate | null, goalActive: boolean }} AccessSession */
  /** @typedef {AccessRequest | AccessSession | null} SiteAccessState */
  /** @typedef {{ now: EpochTime, date: LocalDate, dayStart: EpochTime, midnight: EpochTime, restart: boolean, enabled: boolean, goalAllowed: boolean, focused: boolean, accessMinutes: AccessMinutes, hasRules: boolean, hasWindows: boolean, closeAll: boolean }} AccessFacts */
  /** @typedef {{ state: SiteAccessState, rules: 'unrestricted' | 'session' | 'none', alarmAt: EpochTime | null, expire: boolean, window: { start: EpochTime, end: EpochTime | null } | null, clearWindows: boolean }} AccessDecision */
  const MAXIMUM_BUDGET = Core.millisecondsFromMinutes(Core.ACCESS_LIMITS.maxMinutes);
  /** @type {SessionClock} */
  const PAUSED = { running: false };
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
   * @param {EpochTime} expiresAt
   * @returns {SessionClock}
   */
  function runningUntil(expiresAt) {
    return { running: true, expiresAt };
  }
  /** @returns {SessionClock | null} */
  function clockFromStored(value) {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? PAUSED : runningUntil(Core.asEpochTime(value));
  }
  /** @param {SessionClock | null} clock */
  function storedFromClock(clock) {
    if (clock === null) return null;
    return clock.running ? clock.expiresAt : 0;
  }
  /** @param {SessionClock | null} clock */
  function deadline(clock) {
    return clock?.running ? clock.expiresAt : null;
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
        clock: clockFromStored(raw.expiresAt),
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
            expiresAt: storedFromClock(state.clock),
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
   * @param {AccessMinutes} sessionMinutes
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
        clock: PAUSED,
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
        alarmAt: null,
        expire: false,
        window: null,
        clearWindows: true
      };
    const budget = state?.phase === 'session' ? state : null;
    let remaining = budget?.remainingMs ?? null;
    let clock = budget?.clock ?? null;
    let refilledAt = budget?.refilledAt ?? null;
    let sessionDate = budget?.date ?? null;
    let goalActive = budget?.goalActive ?? false;
    let windowStart = now;
    const hadSession = remaining !== null || clock !== null;
    if (sessionDate && sessionDate !== date) {
      const previousDeadline = deadline(clock);
      const runningAtMidnight =
        !restart && ((previousDeadline !== null && previousDeadline >= dayStart) || (!goalAllowed && goalActive));
      const pausedAtMidnight = !restart && remaining > 0 && !clock?.running;
      if (runningAtMidnight || pausedAtMidnight) windowStart = dayStart;
      remaining = Core.millisecondsFromMinutes(facts.accessMinutes);
      refilledAt = dayStart;
      clock = runningAtMidnight ? runningUntil(Core.timeAfter(dayStart, remaining)) : PAUSED;
    }
    const authorizedUntil = deadline(clock);
    goalActive = goalAllowed && focused && remaining > 0;
    if (remaining > 0) sessionDate = date;
    if (!restart && authorizedUntil !== null)
      remaining = Core.asMilliseconds(Math.min(remaining, Math.max(0, Core.millisecondsBetween(now, authorizedUntil))));
    let rules = /** @type {AccessDecision['rules']} */ ('none'),
      expire = false;
    if (goalAllowed || remaining > 0) {
      clock = !goalAllowed && focused ? runningUntil(Core.timeAfter(now, remaining)) : PAUSED;
      rules = 'session';
    } else {
      expire = hadSession || facts.closeAll || facts.hasRules;
      clock = null;
      remaining = null;
    }
    const alarmAt = deadline(clock);
    const window =
      facts.hasWindows || refilledAt > 0 || alarmAt !== null || goalAllowed
        ? {
            start: windowStart,
            end: goalAllowed
              ? midnight
              : remaining > 0 && alarmAt === null
                ? null
                : (alarmAt ?? Core.asEpochTime(Math.min(now, authorizedUntil ?? now)))
          }
        : null;
    const next =
      state?.phase === 'request'
        ? state
        : budget === null ||
            (remaining === null && clock === null && refilledAt === null && sessionDate === null && !goalActive)
          ? null
          : /** @type {AccessSession} */ ({
              phase: 'session',
              remainingMs: remaining,
              clock,
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
