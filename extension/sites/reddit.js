(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).reddit = plugin;
})(globalThis, function () {
  'use strict';
  const hosts = ['reddit.com', 'www.reddit.com'];
  const selectors = {
    postScope: ['form[action="/api/submit"]', 'shreddit-post-composer'],
    postEditor: ['textarea[name="title"]', 'input[name="title"]', 'textarea[name="text"]', 'input[name="url"]', '[contenteditable="true"][role="textbox"]'],
    commentScope: ['form[action="/api/comment"]', 'shreddit-composer'],
    commentEditor: ['textarea[name="text"]', 'textarea[name="body"]', '[contenteditable="true"][role="textbox"]'],
    messageScope: ['form[action="/api/compose"]'],
    messageEditor: ['textarea[name="text"]'],
    ownProfileLink: ['a[data-testid="profile-link"]', '#USER_DROPDOWN_ID a[href^="/user/"]'],
    button: ['button', 'input[type="submit"]']
  };
  function parseURL(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && hosts.includes(parsed.hostname) && !parsed.port && !parsed.username && !parsed.password ? parsed : null;
    } catch (_) { return null; }
  }
  function pathOf(url) { return url.pathname.replace(/\/+$/, '') || '/'; }
  function route(url) {
    const path = pathOf(url);
    if (/^\/(?:r\/[a-zA-Z0-9_]+\/)?submit$/.test(path)) return 'post';
    if (path === '/message/compose') return 'message';
    if (/^\/(?:user|u)\/[a-zA-Z0-9_-]+(?:\/(?:overview|submitted|comments))?$/.test(path)) return 'profile';
    if (/^\/(?:r\/[a-zA-Z0-9_]+\/)?comments\/[a-zA-Z0-9]+(?:\/[^/]+(?:\/[a-zA-Z0-9]+)?)?$/.test(path)) return 'thread';
    if (['/', '/best', '/hot', '/new', '/top', '/rising', '/controversial', '/search'].includes(path)) return 'feed';
    if (/^\/r\/[a-zA-Z0-9_]+(?:\/(?:hot|new|top|rising|controversial|search))?$/.test(path)) return 'feed';
    return null;
  }
  function profileName(path) { return /^\/(?:user|u)\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(path)?.[1].toLowerCase() || null; }
  function classifyPage({ url, redditEditorFocused = false, redditMessageEditorFocused = false, ownProfilePath = null }) {
    const parsed = parseURL(url);
    if (!parsed) return 'neutral';
    const kind = route(parsed);
    if (!kind) return 'neutral';
    if (kind === 'message') return redditMessageEditorFocused ? 'create' : 'neutral';
    if (redditEditorFocused) return 'create';
    if (kind === 'post') return 'neutral';
    const profile = profileName(pathOf(parsed));
    if (kind === 'profile' && (profile === 'me' || ownProfilePath && profile === profileName(ownProfilePath))) return 'neutral';
    return 'consume';
  }
  function create({ document, location, dom }) {
    function usable(node) {
      if (!dom.enabled(node)) return false;
      for (let current = node; current; current = current.parentElement) {
        if (current.readOnly || current.disabled || current.inert || ['readonly', 'disabled', 'inert'].some(name => current.getAttribute(name) !== null) || ['aria-readonly', 'aria-disabled'].some(name => current.getAttribute(name) === 'true')) return false;
      }
      return true;
    }
    function composer(kind) {
      if (kind === 'post') return { scopes: selectors.postScope, editors: selectors.postEditor, labels: ['Post', 'Submit'], action: 'posts' };
      if (['thread', 'profile', 'feed'].includes(kind)) return { scopes: selectors.commentScope, editors: selectors.commentEditor, labels: ['Comment', 'Reply'], action: 'comments' };
      return null;
    }
    function focused(config) {
      if (!config) return false;
      const editor = dom.closest(document.activeElement, config.editors);
      return usable(editor) && dom.visible(document.activeElement) && !!dom.closest(editor, [config.scopes.join(',')]);
    }
    return {
      mode() {
        const parsed = parseURL(location.href);
        const kind = parsed && route(parsed);
        return classifyPage({ url: location.href, ownProfilePath: dom.ownProfilePath(selectors.ownProfileLink), redditEditorFocused: focused(composer(kind)), redditMessageEditorFocused: kind === 'message' && focused({ scopes: selectors.messageScope, editors: selectors.messageEditor }) });
      },
      action(event) {
        if (event.type !== 'click') return null;
        const parsed = parseURL(location.href);
        const config = parsed && composer(route(parsed));
        if (!config) return null;
        const button = dom.closest(event.target, selectors.button);
        if (!usable(button)) return null;
        const scope = dom.closest(button, [config.scopes.join(',')]);
        if (!scope) return null;
        const editor = dom.find(scope, config.editors);
        if (!usable(editor) || dom.closest(editor, [config.scopes.join(',')]) !== scope) return null;
        const label = dom.label(button) || button.getAttribute('value');
        if (!config.labels.includes(label)) return null;
        return { button, action: config.action, submission: true };
      }
    };
  }
  return { id: 'reddit', name: 'Reddit', hosts, actions: ['posts', 'comments'], classifyPage, create };
});
