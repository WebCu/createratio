(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).facebook = plugin;
})(globalThis, function () {
  'use strict';
  const hosts = ['facebook.com', 'www.facebook.com'];
  const selectors = {
    postScope: ['[role="dialog"][aria-label="Create post"]', '[role="dialog"][aria-label="Create a post"]'],
    postEditor: ['[role="textbox"][contenteditable="true"][data-lexical-editor="true"]'],
    commentScope: ['form'],
    commentEditor: ['[role="textbox"][contenteditable="true"][aria-label^="Write a comment" i]', '[role="textbox"][contenteditable="true"][aria-label^="Write a reply" i]'],
    messageEditor: ['[role="textbox"][contenteditable="true"][aria-label="Message"]'],
    ownProfileLink: ['a[aria-label="Your profile"]', 'a[aria-label="Your profile picture"]'],
    button: ['button', '[role="button"]']
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
    if (/^\/messages(?:\/t\/[a-zA-Z0-9._-]+)?$/.test(path)) return 'message';
    if (path === '/profile.php' && /^\d+$/.test(url.searchParams.get('id') || '')) return 'profile';
    if (/^\/people\/[^/]+\/\d+$/.test(path)) return 'profile';
    if (['/', '/home.php', '/watch', '/groups/feed'].includes(path)) return 'consume';
    if (/^\/reel\/\d+$/.test(path)) return 'consume';
    if (/^\/groups\/(?!create$|discover$|joins$)[a-zA-Z0-9._-]+(?:\/posts\/(?:\d+|pfbid[a-zA-Z0-9]+))?$/.test(path)) return 'consume';
    if (/^\/[a-zA-Z0-9._-]+\/posts\/(?:\d+|pfbid[a-zA-Z0-9]+)$/.test(path)) return 'consume';
    if (path === '/permalink.php' && /^(?:\d+|pfbid[a-zA-Z0-9]+)$/.test(url.searchParams.get('story_fbid') || '') && /^\d+$/.test(url.searchParams.get('id') || '')) return 'consume';
    return null;
  }
  function ownProfile(url, ownProfileURL) {
    const own = parseURL(ownProfileURL);
    if (!own || route(own) !== 'profile') return false;
    const profileId = profile => pathOf(profile) === '/profile.php' ? profile.searchParams.get('id') : pathOf(profile).split('/').at(-1);
    return profileId(own) === profileId(url);
  }
  function classifyPage({ url, facebookEditorFocused = false, facebookMessageEditorFocused = false, ownProfileURL = null }) {
    const parsed = parseURL(url);
    if (!parsed) return 'neutral';
    const kind = route(parsed);
    if (!kind) return 'neutral';
    if (kind === 'message') return facebookMessageEditorFocused ? 'create' : 'neutral';
    if (facebookEditorFocused) return 'create';
    if (kind === 'profile' && ownProfile(parsed, ownProfileURL)) return 'neutral';
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
    function editorScope(editor) {
      if (dom.matches(editor, selectors.commentEditor)) return dom.closest(editor, selectors.commentScope);
      if (dom.matches(editor, selectors.postEditor)) return dom.closest(editor, selectors.postScope);
      return null;
    }
    function submission(target) {
      const button = dom.closest(target, selectors.button);
      if (!usable(button)) return null;
      const form = dom.closest(button, selectors.commentScope);
      const commentEditor = form && dom.find(form, selectors.commentEditor);
      const comment = usable(commentEditor) && editorScope(commentEditor) === form;
      const scope = comment ? form : dom.closest(button, selectors.postScope);
      if (!scope) return null;
      const editor = dom.find(scope, comment ? selectors.commentEditor : selectors.postEditor);
      if (!usable(editor) || editorScope(editor) !== scope) return null;
      const labels = comment ? ['Comment', 'Reply', 'Post a comment'] : ['Post'];
      if (!labels.includes(dom.label(button))) return null;
      return { button, action: comment ? 'comments' : 'posts', submission: true };
    }
    function keyboardSubmission(event) {
      if (!dom.submitKey(event) || event.ctrlKey || event.metaKey) return null;
      const editor = dom.closest(event.target, selectors.commentEditor);
      if (!usable(editor) || !dom.visible(event.target)) return null;
      const scope = editorScope(editor);
      if (!scope) return null;
      for (const button of scope.querySelectorAll(selectors.button.join(','))) {
        const result = submission(button);
        if (result && dom.closest(button, selectors.commentScope) === scope && dom.find(scope, selectors.commentEditor) === editor) return result;
      }
      return null;
    }
    function ownProfileURL() {
      for (const selector of selectors.ownProfileLink) {
        const link = document.querySelector(selector);
        if (link) return link.href;
      }
      return null;
    }
    return {
      mode() {
        const active = document.activeElement;
        const editor = dom.closest(active, selectors.commentEditor) || dom.closest(active, selectors.postEditor);
        const message = dom.closest(active, selectors.messageEditor);
        return classifyPage({ url: location.href, ownProfileURL: ownProfileURL(), facebookEditorFocused: usable(editor) && dom.visible(active) && !!editorScope(editor), facebookMessageEditorFocused: usable(message) && dom.visible(active) });
      },
      action(event) {
        const parsed = parseURL(location.href);
        const kind = parsed && route(parsed);
        if (!kind || kind === 'message') return null;
        if (event.type === 'click') return submission(event.target);
        if (event.type === 'keydown') return keyboardSubmission(event);
        return null;
      }
    };
  }
  return { id: 'facebook', name: 'Facebook', hosts, actions: ['posts', 'comments'], classifyPage, create };
});
