(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).tiktok = plugin;
})(globalThis, function () {
  'use strict';
  const hosts = ['tiktok.com', 'www.tiktok.com'];
  const selectors = {
    commentEditor: ['[data-e2e="comment-input"] [contenteditable="true"]'],
    commentSubmit: ['[data-e2e="comment-post"]'],
    commentScope: ['[class*="DivCommentInputContainer"]'],
    postScope: ['form', '[data-e2e="upload-container"]'],
    captionEditor: ['[data-e2e="upload-caption"] [contenteditable="true"]', '[data-e2e="caption-container"] [contenteditable="true"]'],
    postSubmit: ['button[data-e2e="post_video_button"]'],
    messageEditor: ['[data-e2e="message-input"][contenteditable="true"]', '[data-e2e="message-input"] [contenteditable="true"]'],
    ownProfileLink: ['a[data-e2e="nav-profile"]', 'a[data-e2e="profile-icon"]'],
    light: {
      likes: ['button[data-e2e="like-icon"][aria-pressed="false"]', '[role="button"][data-e2e="browse-like-icon"][aria-pressed="false"]'],
      bookmarks: ['button[data-e2e="bookmark-icon"][aria-pressed="false"]', '[role="button"][data-e2e="browse-collect-icon"][aria-pressed="false"]']
    }
  };
  function page(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) return null;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (/^\/(?:foryou|following|explore|search)?$/.test(path) || /^\/(?:tag|music)\/[^/]+$/.test(path)) return { kind: 'browse' };
    const profile = path.match(/^\/@([A-Za-z0-9_.]{1,24})(?:\/(video|photo)\/[0-9]+)?$/);
    if (profile) return { kind: profile[2] ? 'content' : 'profile', profile: '/@' + profile[1] };
    if (path === '/upload' || path === '/tiktokstudio/upload') return { kind: 'upload' };
    if (path === '/messages') return { kind: 'messages' };
    return null;
  }
  function classifyPage({ url, tiktokEditorFocused = false, ownProfilePath = null } = {}) {
    const route = page(url);
    if (!route) return 'neutral';
    if (tiktokEditorFocused) return 'create';
    if (route.kind === 'upload' || route.kind === 'messages') return 'neutral';
    if (route.kind === 'profile' && route.profile.toLowerCase() === ownProfilePath?.replace(/\/+$/, '').toLowerCase()) return 'neutral';
    return 'consume';
  }
  function create({ document, location, dom }) {
    function commentRoute(route) {
      return route && (route.kind === 'content' || route.kind === 'profile' || route.kind === 'browse');
    }
    function available(node) {
      return dom.enabled(node) && !node.closest('[inert],[aria-disabled="true"],fieldset[disabled]');
    }
    function editable(editor) {
      return available(editor) && !editor.readOnly && editor.getAttribute('aria-readonly') !== 'true';
    }
    function submission(target, route) {
      const post = route?.kind === 'upload';
      if (!post && !commentRoute(route)) return null;
      const editors = post ? selectors.captionEditor : selectors.commentEditor;
      const submits = post ? selectors.postSubmit : selectors.commentSubmit;
      const button = dom.closest(target, submits);
      if (!available(button)) return null;
      const scope = dom.closest(button, post ? selectors.postScope : selectors.commentScope);
      const editor = scope && dom.find(scope, editors);
      return editable(editor) ? { button, editor, action: post ? 'posts' : 'comments', submission: true } : null;
    }
    return {
      mode() {
        const route = page(location.href);
        const editors = route?.kind === 'upload' ? selectors.captionEditor : route?.kind === 'messages' ? selectors.messageEditor : commentRoute(route) ? selectors.commentEditor : [];
        const editor = dom.closest(document.activeElement, editors);
        return classifyPage({ url: location.href, tiktokEditorFocused: editable(editor) && dom.visible(document.activeElement), ownProfilePath: dom.ownProfilePath(selectors.ownProfileLink) });
      },
      action(event) {
        const route = page(location.href);
        if (!route) return null;
        if (event.type === 'keydown') {
          if (!commentRoute(route) || !dom.submitKey(event) || event.ctrlKey || event.metaKey) return null;
          const editor = dom.closest(event.target, selectors.commentEditor);
          if (!editable(editor)) return null;
          const scope = dom.closest(editor, selectors.commentScope);
          if (!scope) return null;
          for (const button of scope.querySelectorAll(selectors.commentSubmit.join(','))) {
            const result = submission(button, route);
            if (result?.editor === editor) return result;
          }
          return null;
        }
        if (event.type !== 'click') return null;
        const result = submission(event.target, route);
        if (result || !commentRoute(route)) return result;
        const light = dom.lightAction(event.target, selectors);
        return light && available(light.button) ? light : null;
      }
    };
  }
  return { id: 'tiktok', name: 'TikTok', hosts, actions: ['posts', 'comments', 'likes', 'bookmarks'], classifyPage, create };
});
