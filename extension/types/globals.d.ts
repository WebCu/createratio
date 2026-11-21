declare global {
  var C3: typeof import('../core/core.js');
  var C3Sites: typeof import('../sites/index.js');
  var C3_SITE_MODULES: Record<string, any> | undefined;
  var C3_DOM: typeof import('../src/content/dom.js');
  var RuntimeMessages: typeof import('../src/shared/messages.js');
  var MessageContracts: typeof import('../src/background/message-contracts.js');
  var ActivityHistory: typeof import('../src/background/history.js');
  var WebTime: typeof import('../src/background/web-time.js');
  var ExtensionUpdates: typeof import('../src/background/updates.js');
  var CreationReport: typeof import('../src/pages/dashboard/report.js');
  var SocialCard: typeof import('../src/pages/dashboard/share-card.js');
  var ScrollFriction: typeof import('../src/content/scroll-friction.js');
  var SiteAccess: any;
  var RefillAnimation: any;
  var ContentLifecycle: any;
  var SocialSharing: any;
  var browser: any;
  var chrome: any;
  var module: any;
  function require(id: string): any;
  function importScripts(...urls: string[]): void;
}

export {};
