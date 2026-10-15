(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).x = plugin;
})(globalThis, function () {
  'use strict';
  const selectors = {
    editor: ['[data-testid="tweetTextarea_0"][contenteditable="true"]', '[data-testid^="tweetTextarea_"][contenteditable="true"]', '[role="textbox"][contenteditable="true"][aria-label="Post text"]', '[role="textbox"][contenteditable="true"][aria-label="Texto de la publicación"]'],
    dialog: ['[role="dialog"]'],
    composer: ['[data-testid="tweetComposer"]', '[data-testid="inline_reply_offscreen"]'],
    submit: ['[data-testid="tweetButton"]', '[data-testid="tweetButtonInline"]'],
    replyContext: ['[data-testid="replyingTo"]', '[data-testid="replyingToText"]', '[data-testid="inline_reply_offscreen"]'],
    replyLabels: ['Reply', 'Responder'],
    quoteContext: ['[data-testid="quoteTweet"]', '[data-testid="quoteTweetPreview"]', '[data-testid="tweet"]'],
    quoteIntent: ['[data-testid="retweetDropdown"] a[href*="/compose/post"]', '[data-testid="retweetDropdown"] a[href*="/compose/tweet"]', '[role="menuitem"][aria-label="Quote"]', '[role="menuitem"][aria-label="Citar"]'],
    replyIntent: ['[data-testid="reply"]'],
    ownProfileLink: ['a[data-testid="AppTabBar_Profile_Link"]'],
    light: {
      likes: ['[data-testid="like"]'],
      bookmarks: ['[data-testid="bookmark"]', '[data-testid="bookmarkDropdown"]'],
      reposts: ['[data-testid="retweetConfirm"]']
    }
  };
  const hosts = ['x.com', 'www.x.com'];
  const domains = ['x.com', 'twitter.com'], navigationId = 101, resourceId = 104;
  const access = {
    domains, home: 'https://x.com/home', redirectRuleId: 1, ruleIds: [navigationId, resourceId],
    unrestrictedRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
      { id: resourceId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
    ],
    sessionRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } }
    ]
  };
  function classifyPage({ url, xComposerOpen = false, ownProfilePath = null }) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'neutral'; }
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) return 'neutral';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (/^\/compose(?:\/|$)/.test(path) || xComposerOpen) return 'create';
    if (/^\/(home|explore|search)(?:\/|$)/.test(path)) return 'consume';
    const reserved = /^(?:i|settings|messages|notifications|compose|login|logout|signup|tos|privacy|about|jobs|help|account|intent)$/;
    const match = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(with_replies|media|likes|highlights|articles|status)(?:\/.*)?)?$/);
    if (match && !reserved.test(match[1])) {
      const profile = '/' + match[1];
      if (ownProfilePath && profile.toLowerCase() === ownProfilePath.toLowerCase() && !path.includes('/status/')) return 'neutral';
      return 'consume';
    }
    return 'neutral';
  }
  function create({ document, location, dom }) {
    let intent = null, previouslyOpen = false;
    function replyButton(scope) {
      const button = dom.find(scope, selectors.submit);
      return button && selectors.replyLabels.some(text => text.toLowerCase() === dom.label(button).toLowerCase());
    }
    function quoteAfterEditor(scope, editor) {
      return [...scope.querySelectorAll(selectors.quoteContext.join(','))].some(node => dom.visible(node) && !!(editor.compareDocumentPosition(node) & 4));
    }
    function composer() {
      const dialog = [...document.querySelectorAll(selectors.dialog.join(','))].find(node => dom.visible(node) && dom.find(node, selectors.editor));
      const focusedEditor = dom.closest(document.activeElement, selectors.editor);
      const editor = dialog ? dom.find(dialog, selectors.editor) : dom.visible(focusedEditor) ? focusedEditor : dom.find(document, selectors.editor);
      if (!editor) return null;
      const scope = dialog || dom.closest(editor, selectors.composer) || dom.composerScope(editor, selectors.editor, selectors.submit);
      if (!scope) return null;
      const isReply = !!dom.find(scope, selectors.replyContext) || replyButton(scope) || (!dialog && location.pathname.includes('/status/'));
      return { open: !!dialog || isReply || scope.contains(document.activeElement) };
    }
    function submission(target) {
      const button = dom.closest(target, selectors.submit);
      if (!dom.enabled(button)) return null;
      const dialog = dom.closest(button, selectors.dialog);
      const scope = dialog || dom.closest(button, selectors.composer) || dom.composerScope(button, selectors.editor, selectors.submit);
      if (!scope) return null;
      const editor = dom.find(scope, selectors.editor);
      if (!editor) return null;
      const reply = !!dom.find(scope, selectors.replyContext) || replyButton(scope) || (!dialog && location.pathname.includes('/status/')) || intent === 'reply';
      const quote = (!!dialog && quoteAfterEditor(scope, editor)) || intent === 'quote';
      return { button, editor, action: quote ? 'quotes' : reply ? 'replies' : 'posts', submission: true };
    }
    function keyboardSubmission(target) {
      const editor = dom.closest(target, selectors.editor);
      if (!dom.visible(editor)) return null;
      const scope = dom.closest(editor, selectors.dialog) || dom.closest(editor, selectors.composer) || dom.composerScope(editor, selectors.editor, selectors.submit);
      if (!scope) return null;
      for (const button of scope.querySelectorAll(selectors.submit.join(','))) {
        const result = submission(button);
        if (result?.editor === editor) return result;
      }
      return null;
    }
    return {
      mode() {
        const open = !!composer()?.open || /^\/compose\//.test(location.pathname);
        if (previouslyOpen && !open) intent = null;
        previouslyOpen = open;
        return classifyPage({ url: location.href, xComposerOpen: open, ownProfilePath: dom.ownProfilePath(selectors.ownProfileLink) });
      },
      action(event) {
        let result;
        if (event.type === 'keydown') {
          if (!dom.submitKey(event) || !(event.ctrlKey || event.metaKey)) return null;
          result = keyboardSubmission(event.target);
        } else if (event.type === 'click') {
          if (dom.closest(event.target, selectors.replyIntent)) intent = 'reply';
          if (dom.closest(event.target, selectors.quoteIntent)) intent = 'quote';
          result = submission(event.target) || dom.lightAction(event.target, selectors);
        } else return null;
        if (result?.submission) intent = null;
        return result;
      }
    };
  }
  return { id: 'x', name: 'X', hosts, defaultEnabled: true, access, actions: ['posts', 'replies', 'quotes', 'likes', 'bookmarks', 'reposts'], classifyPage, create };
});
