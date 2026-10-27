(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).instagram = plugin;
})(globalThis, function () {
  'use strict';
  const hosts = ['instagram.com', 'www.instagram.com'];
  const domains = ['instagram.com'], navigationId = 107, resourceId = 108;
  const access = {
    domains, home: 'https://www.instagram.com/', redirectRuleId: 4, ruleIds: [navigationId, resourceId],
    unrestrictedRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
      { id: resourceId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
    ],
    sessionRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } }
    ]
  };
  const selectors = {
    commentEditor: ['textarea[aria-label="Add a comment…"]', 'textarea[aria-label="Add a comment..."]'],
    captionEditor: ['textarea[aria-label="Write a caption…"]', 'textarea[aria-label="Write a caption..."]'],
    messageEditor: ['[role="textbox"][contenteditable="true"][aria-label="Message"]'],
    commentScope: ['form'],
    postScope: ['[role="dialog"]'],
    button: ['button', '[role="button"]'],
    ownProfileLink: ['a[aria-label="Profile"]', 'a:has(svg[aria-label="Profile"])'],
    light: {
      likes: ['button[aria-label="Like"]', '[role="button"][aria-label="Like"]', 'button:has(svg[aria-label="Like"])', '[role="button"]:has(svg[aria-label="Like"])'],
      bookmarks: ['button[aria-label="Save"]', '[role="button"][aria-label="Save"]', 'button:has(svg[aria-label="Save"])', '[role="button"]:has(svg[aria-label="Save"])']
    }
  };
  const reserved = /^(?:about|accounts|ads|api|auth|challenge|create|developer|developers|direct|directory|emails|explore|graphql|legal|login|logout|notifications|oauth|p|press|privacy|push|reel|reels|session|settings|signup|static|stories|terms|web)$/i;
  function page(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) return null;
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (/^\/(?:explore(?:\/search)?|reels)?$/.test(path) || /^\/explore\/tags\/[A-Za-z0-9_]+$/.test(path)) return { kind: 'browse' };
    if (/^\/(?:p|reel|reels)\/[A-Za-z0-9_-]+$/.test(path) || /^\/stories\/[A-Za-z0-9_.]+\/[0-9]+$/.test(path)) return { kind: 'content' };
    if (/^\/direct\/(?:inbox|new|t\/[A-Za-z0-9_-]+)$/.test(path)) return { kind: 'messages' };
    if (/^\/create\/(?:select|style|details)$/.test(path)) return { kind: 'upload' };
    const profile = path.match(/^\/([A-Za-z0-9_.]{1,30})(?:\/(?:reels|tagged))?$/);
    if (profile && !reserved.test(profile[1])) return { kind: 'profile', profile: '/' + profile[1] };
    return null;
  }
  function classifyPage({ url, instagramEditorFocused = false, ownProfilePath = null } = {}) {
    const route = page(url);
    if (!route) return 'neutral';
    if (instagramEditorFocused) return 'create';
    if (route.kind === 'upload' || route.kind === 'messages') return 'neutral';
    if (route.kind === 'profile' && route.profile.toLowerCase() === ownProfilePath?.replace(/\/+$/, '').toLowerCase()) return 'neutral';
    return 'consume';
  }
  function create({ document, location, dom }) {
    function contentRoute(route) {
      return route && ['browse', 'content', 'profile'].includes(route.kind);
    }
    function available(node) {
      return dom.enabled(node) && !node.closest('[inert],[aria-disabled="true"],fieldset[disabled]');
    }
    function editable(editor) {
      return available(editor) && !editor.readOnly && editor.getAttribute('aria-readonly') !== 'true';
    }
    function submission(target, route) {
      if (!contentRoute(route) && route?.kind !== 'upload') return null;
      const button = dom.closest(target, selectors.button);
      if (!available(button)) return null;
      const label = dom.label(button);
      const commentScope = dom.closest(button, selectors.commentScope);
      const comment = contentRoute(route) && commentScope && dom.find(commentScope, selectors.commentEditor);
      if (comment && label === 'Post' && editable(comment)) return { button, editor: comment, action: 'comments', submission: true };
      const postScope = dom.closest(button, selectors.postScope);
      const caption = postScope && dom.find(postScope, selectors.captionEditor);
      return caption && label === 'Share' && editable(caption) ? { button, editor: caption, action: 'posts', submission: true } : null;
    }
    return {
      mode() {
        const route = page(location.href);
        const editors = route?.kind === 'messages' ? selectors.messageEditor : contentRoute(route) ? [...selectors.commentEditor, ...selectors.captionEditor] : route?.kind === 'upload' ? selectors.captionEditor : [];
        const editor = dom.closest(document.activeElement, editors);
        const caption = dom.matches(editor, selectors.captionEditor);
        const scoped = !caption || !!dom.closest(editor, selectors.postScope);
        return classifyPage({ url: location.href, instagramEditorFocused: scoped && editable(editor) && dom.visible(document.activeElement), ownProfilePath: dom.ownProfilePath(selectors.ownProfileLink) });
      },
      action(event) {
        const route = page(location.href);
        if (!route) return null;
        if (event.type === 'keydown') {
          if (!contentRoute(route) || !dom.submitKey(event) || event.ctrlKey || event.metaKey) return null;
          const editor = dom.closest(event.target, selectors.commentEditor);
          if (!editable(editor)) return null;
          const scope = dom.closest(editor, selectors.commentScope);
          if (!scope) return null;
          for (const button of scope.querySelectorAll(selectors.button.join(','))) {
            const result = submission(button, route);
            if (result?.editor === editor && result.action === 'comments') return result;
          }
          return null;
        }
        if (event.type !== 'click') return null;
        const result = submission(event.target, route);
        if (result || !contentRoute(route)) return result;
        const light = dom.lightAction(event.target, selectors);
        return light && available(light.button) && light.button.getAttribute('aria-pressed') !== 'true' ? light : null;
      }
    };
  }
  return { id: 'instagram', name: 'Instagram', hosts, access, actions: ['posts', 'comments', 'likes', 'bookmarks'], classifyPage, create };
});
