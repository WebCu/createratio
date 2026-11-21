declare global {
  type AccessPreference = 'accessMinutes' | 'waitMinutes';
  type HistoryKind = 'ratio' | 'websites';
  type HistoryRange = 'today' | 'week' | 'month';
  type SegmentMode = 'create' | 'consume';
  type TimeSegment = { date: string; mode: SegmentMode; sec: number; start?: number; end?: number };
  type SiteActionEntry = { date: string; action: string; at?: number };
  type PreferenceMessage =
    | { type: 'tracking'; site: string; enabled: boolean }
    | { type: 'access-duration'; site?: string; minutes: number | null; preference?: AccessPreference }
    | { type: 'access-goal-setting'; enabled: boolean }
    | { type: 'access-history-setting'; enabled: boolean }
    | { type: 'scroll-friction-setting'; enabled: boolean; strength?: number }
    | { type: 'website-time-setting'; enabled: boolean };
  type AccessSessionMessage = {
    type: 'access-status' | 'access-begin' | 'access-open' | 'access-cancel' | 'access-end';
    site?: string;
    reason?: string;
  };
  type IngestMessage = { type: 'ingest'; id: string; generation: string | null; site: string; segments: TimeSegment[]; actions: SiteActionEntry[] };
  type PreferenceRules = { [K in PreferenceMessage['type']]: (message: Extract<PreferenceMessage, { type: K }>) => void };
  type HistoryStore = ReturnType<typeof ActivityHistory.create>;
  type SnapshotReply = { ok: true; generation: string | null; date: string; day: ReturnType<HistoryStore['creationDay']>; settings: ReturnType<typeof C3.settingsSnapshot>; access: Record<string, AccessStatus>; websiteTimeEnabled: boolean };
  type AccessReply = { ok: true; access: Record<string, AccessStatus> };
  type SavedIntention = { site: string; reason: string; requestedAt: number };
  type ReplyTable<T extends Record<RuntimeMessage['type'], { ok: true }>> = T;
  type RuntimeReplies = {
    'snapshot': SnapshotReply;
    'ingest': SnapshotReply;
    'tracking': SnapshotReply;
    'clear-history': SnapshotReply;
    'scroll-friction-setting': SnapshotReply;
    'history': { ok: true; days: Awaited<ReturnType<HistoryStore['read']>> };
    'update-apply': { ok: true; applied: boolean };
    'website-time-setting': { ok: true; enabled: boolean };
    'access-status': AccessReply & { intentionHistoryEnabled: boolean; navigationHandled: boolean };
    'access-begin': AccessReply;
    'access-open': AccessReply;
    'access-cancel': AccessReply;
    'access-end': AccessReply;
    'access-duration': AccessReply;
    'access-goal-setting': AccessReply;
    'access-history-setting': { ok: true };
    'access-history-list': { ok: true; intentions: SavedIntention[] };
    'access-history-clear': { ok: true };
  };
  type RuntimeMessenger = { send<M extends RuntimeMessage>(message: M, fallbackMessage: string): Promise<RuntimeReplies[M['type']]> };
  type RuntimeMessage =
    | PreferenceMessage
    | AccessSessionMessage
    | { type: 'snapshot' | 'clear-history' | 'update-apply' | 'access-history-list' | 'access-history-clear' }
    | { type: 'history'; kind: HistoryKind; range: HistoryRange }
    | IngestMessage;
}

export {};
