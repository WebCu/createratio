declare global {
  type LocalDate = string & { readonly __brand: 'LocalDate' };
  type Milliseconds = number & { readonly __brand: 'Milliseconds' };
  type Seconds = number & { readonly __brand: 'Seconds' };
  type Minutes = number & { readonly __brand: 'Minutes' };
  type StoredSettings = Partial<typeof Core.DEFAULT_SETTINGS> & { siteOverrides?: Record<string, Record<string, unknown>> };
  type StoredData = { settings?: StoredSettings; [key: string]: unknown };
  type AccessStatus = { site: string; enabled: boolean; goalAllowed: boolean; name: string; home: string; remainingMs: Milliseconds; expiresAt: number; readyAt: number; refilledAt: number; waitSeconds: Seconds; sessionMinutes: Minutes };
  type SiteAccessApi = {
    handle(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown>;
    reconcile(closeAll?: boolean): Promise<Record<string, AccessStatus>>;
    siteForURL(raw: string): string | null;
    gateURL(site: string): string;
  };
  type ContentOwner = { prepare(force: boolean): Promise<boolean>; resume(): void; stop(): void };
  type ContentLifecycleApi = { register(name: 'guard' | 'tracker', owner: ContentOwner): void };
  type RefillAnimationApi = {
    render(target: HTMLElement, access: { refilledAt?: unknown; remainingMs: number }): void;
    waitForFill(target: HTMLElement): Promise<void> | undefined;
  };
  type SocialSharingApi = { mount(options: { messages: RuntimeMessenger; range: () => HistoryRange; error: (message?: string) => void }): { clear(): void } };
  var Core: typeof import('../core/core.js');
  var Sites: typeof import('../sites/index.js');
  var SITE_MODULES: Record<string, unknown> | undefined;
  var PageQueries: typeof import('../src/content/dom.js');
  var RuntimeMessages: typeof import('../src/shared/messages.js');
  var MessageContracts: typeof import('../src/background/message-contracts.js');
  var ActivityHistory: typeof import('../src/background/history.js');
  var WebTime: typeof import('../src/background/web-time.js');
  var ExtensionUpdates: typeof import('../src/background/updates.js');
  var CreationReport: typeof import('../src/pages/dashboard/report.js');
  var SocialCard: typeof import('../src/pages/dashboard/share-card.js');
  var ScrollFriction: typeof import('../src/content/scroll-friction.js');
  var SiteAccess: SiteAccessApi;
  var RefillAnimation: RefillAnimationApi;
  var ContentLifecycle: ContentLifecycleApi | undefined;
  var SocialSharing: SocialSharingApi;
  var browser: typeof chrome | undefined;
  var module: { exports: unknown } | undefined;
  function require(id: string): unknown;
  function importScripts(...urls: string[]): void;
}

export {};
