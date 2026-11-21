declare global {
  type AccessPreference = 'accessMinutes' | 'waitMinutes';
  type HistoryKind = 'ratio' | 'websites';
  type HistoryRange = 'today' | 'week' | 'month';
  type SegmentMode = 'create' | 'consume';
  type TimeSegment = { date: string; mode: SegmentMode; sec: number };
  type SiteActionEntry = { date: string; action: string };
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
  type RuntimeMessage =
    | PreferenceMessage
    | AccessSessionMessage
    | { type: 'snapshot' | 'clear-history' | 'update-apply' | 'access-history-list' | 'access-history-clear' }
    | { type: 'history'; kind: HistoryKind; range: HistoryRange }
    | { type: 'ingest'; id: string; generation: string | null; site: string; segments: TimeSegment[]; actions: SiteActionEntry[] };
}

export {};
