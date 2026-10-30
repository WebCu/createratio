(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).youtube = plugin;
})(globalThis, function () {
  'use strict';
  const hosts = ['youtube.com', 'www.youtube.com'];
  const selectors = {
    composer: ['ytd-commentbox'],
    editor: ['#contenteditable-root[contenteditable="true"]'],
    submit: ['#submit-button button']
  };
  function classifyPage({ url, youtubeCommentFocused = false }) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'neutral'; }
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) return 'neutral';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const feed = /^\/(?:watch|results|playlist)$/.test(path)
      || /^\/shorts(?:\/[A-Za-z0-9_-]+)?$/.test(path)
      || /^\/feed\/(?:subscriptions|trending|explore|history|library|you|playlists)$/.test(path);
    const channel = /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)(?:\/(?:featured|videos|shorts|streams|playlists|community|posts|releases|podcasts|courses))?$/.test(path);
    if (path !== '/' && !feed && !channel) return 'neutral';
    return youtubeCommentFocused ? 'create' : 'consume';
  }
  function create({ document, location, dom }) {
    function available(node) {
      if (!dom.enabled(node)) return false;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.getAttribute('disabled') !== null || ancestor.getAttribute('aria-disabled') === 'true' || ancestor.getAttribute('inert') !== null) return false;
      }
      return true;
    }
    function localElements(scope, candidates) {
      return [...scope.querySelectorAll(candidates.join(','))].filter(node => dom.visible(node) && dom.closest(node, selectors.composer) === scope);
    }
    function commentEditor(scope) {
      const editors = localElements(scope, selectors.editor);
      const editor = editors.length === 1 ? editors[0] : null;
      return available(editor) && editor.getAttribute('aria-readonly') !== 'true' ? editor : null;
    }
    function focusedComment() {
      const editor = dom.closest(document.activeElement, selectors.editor);
      const scope = dom.closest(editor, selectors.composer);
      return !!scope && dom.visible(document.activeElement) && commentEditor(scope) === editor;
    }
    return {
      mode() {
        return classifyPage({ url: location.href, youtubeCommentFocused: focusedComment() });
      },
      action(event) {
        if (event.type !== 'click' || classifyPage({ url: location.href }) === 'neutral') return null;
        const button = dom.closest(event.target, selectors.submit);
        if (!available(button)) return null;
        const scope = dom.closest(button, selectors.composer);
        if (!scope || !commentEditor(scope)) return null;
        const buttons = localElements(scope, selectors.submit);
        return buttons.length === 1 && buttons[0] === button ? { button, action: 'comments', submission: true } : null;
      }
    };
  }
  return { id: 'youtube', name: 'YouTube', hosts, actions: ['comments'], classifyPage, create };
});
