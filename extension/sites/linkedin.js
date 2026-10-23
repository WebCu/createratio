(function (root, factory) {
  const plugin = factory();
  if (typeof module === 'object' && module.exports) module.exports = plugin;
  else (root.C3_SITE_MODULES ||= {}).linkedin = plugin;
})(globalThis, function () {
  'use strict';
  const selectors = {
    editor: ['.share-box [contenteditable="true"]', '.share-creation-state__text-editor [contenteditable="true"]', '.share-creation-state [contenteditable="true"]', '.comments-comment-box [contenteditable="true"]', '[role="dialog"][aria-label*="post" i] .ql-editor[contenteditable="true"]', '[role="dialog"][aria-label*="publicación" i] .ql-editor[contenteditable="true"]', '.comments-comment-texteditor [contenteditable="true"]', '[role="textbox"][contenteditable="true"][aria-label*="comment" i]', '[role="textbox"][contenteditable="true"][aria-label*="post" i]'],
    standalonePostEditor: ['.tiptap.ProseMirror[role="textbox"][contenteditable="true"]'],
    messageEditor: ['.msg-form__contenteditable[contenteditable="true"]', '.msg-form [contenteditable="true"]'],
    postComposer: ['.share-box', '.share-creation-state', '[role="dialog"]:has(.share-creation-state__text-editor)', '[role="dialog"]:has(.ql-editor)'],
    commentComposer: ['.comments-comment-box', '.comments-comment-texteditor', 'form:has([contenteditable="true"][aria-label*="comment" i])'],
    postSubmit: ['.share-actions__primary-action', 'button.share-box_actions'],
    commentSubmit: ['.comments-comment-box__submit-button', '.comments-comment-box__submit-button--cr', '.comments-comment-box button[type="submit"]'],
    button: ['button', '[role="button"]'],
    labels: { posts: ['Post', 'Publicar'], comments: ['Comment', 'Reply', 'Comentar', 'Responder'] },
    ownProfileLink: ['a.global-nav__me-view-profile-link', '.global-nav__me-content a[href*="/in/"]'],
    light: {
      likes: ['button[aria-pressed="false"][aria-label^="Like" i]', 'button[aria-pressed="false"][aria-label^="Recommend" i]', 'button[aria-pressed="false"][aria-label^="Recomendar" i]', 'button.react-button__trigger[aria-pressed="false"]'],
      bookmarks: ['[role="menuitem"][aria-label="Save"]', '[role="menuitem"][aria-label="Guardar"]', 'button[aria-label="Save post"]', 'button[aria-label="Guardar publicación"]'],
      reposts: ['button.artdeco-dropdown__item[aria-label="Repost"]', '[role="menuitem"][aria-label="Repost"]']
    },
    menuItem: ['[role="menuitem"]', '.feed-shared-control-menu__item', '.social-reshare-button__dropdown-option', '.artdeco-dropdown__item'],
    lightLabels: { bookmarks: ['Save', 'Guardar'], reposts: ['Repost', 'Republicar'] }
  };
  const hosts = ['linkedin.com', 'www.linkedin.com'];
  const domains = ['linkedin.com'], navigationId = 102, frameId = 103;
  const access = {
    domains, home: 'https://www.linkedin.com/feed/', redirectRuleId: 2, ruleIds: [navigationId, frameId],
    unrestrictedRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
      { id: frameId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
    ],
    sessionRules: [
      { id: navigationId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } },
      { id: frameId, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, initiatorDomains: domains, resourceTypes: ['sub_frame'] } }
    ]
  };
  function classifyPage({ url, linkedinEditorFocused = false, ownProfilePath = null }) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'neutral'; }
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) return 'neutral';
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (linkedinEditorFocused) return 'create';
    if (/^\/feed(?:\/|$)/.test(path)) return 'consume';
    if (/^\/(in|company|school)\/[^/]+(?:\/.*)?$/.test(path)) {
      if (ownProfilePath && (path === ownProfilePath || path.startsWith(ownProfilePath + '/'))) return 'neutral';
      return 'consume';
    }
    return 'neutral';
  }
  function create({ document, location, dom }) {
    function submission(target) {
      const button = dom.closest(target, selectors.button);
      if (!dom.enabled(button)) return null;
      const commentScope = dom.closest(button, selectors.commentComposer);
      const scope = commentScope || dom.closest(button, selectors.postComposer);
      if (!scope) return null;
      const action = commentScope ? 'comments' : 'posts';
      const known = dom.matches(button, action === 'comments' ? selectors.commentSubmit : selectors.postSubmit);
      if (!known && !selectors.labels[action].some(text => text.toLowerCase() === dom.label(button).toLowerCase())) return null;
      const editor = dom.find(scope, selectors.editor);
      return editor ? { button, editor, action, submission: true } : null;
    }
    function keyboardSubmission(target) {
      const editor = dom.closest(target, selectors.editor);
      if (!dom.visible(editor)) return null;
      const scope = dom.closest(editor, selectors.commentComposer);
      if (!scope) return null;
      for (const button of scope.querySelectorAll(selectors.button.join(','))) {
        const result = submission(button);
        if (result?.editor === editor && result.action === 'comments') return result;
      }
      return null;
    }
    return {
      mode() {
        const standalonePostEditor = /^\/sharing\/compose\/?$/.test(location.pathname) ? dom.closest(document.activeElement, selectors.standalonePostEditor) : null;
        const editor = dom.closest(document.activeElement, selectors.editor) || dom.closest(document.activeElement, selectors.messageEditor) || standalonePostEditor;
        return classifyPage({ url: location.href, linkedinEditorFocused: !!editor && dom.visible(editor) && dom.visible(document.activeElement), ownProfilePath: dom.ownProfilePath(selectors.ownProfileLink) });
      },
      action(event) {
        if (event.type === 'keydown') {
          if (!dom.submitKey(event) || event.ctrlKey || event.metaKey) return null;
          return keyboardSubmission(event.target);
        }
        if (event.type === 'click') return submission(event.target) || dom.lightAction(event.target, selectors);
        return null;
      }
    };
  }
  return { id: 'linkedin', name: 'LinkedIn', hosts, defaultEnabled: true, access, actions: ['posts', 'comments', 'likes', 'bookmarks', 'reposts'], classifyPage, create };
});
