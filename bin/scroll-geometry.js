(() => {
  const tags = new Set(['HTML', 'BODY', 'MAIN', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'FORM', 'INPUT', 'TEXTAREA']);
  const number = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  const keyword = (value, allowed) => allowed.includes(value) ? value : null;
  const tokens = (value, allowed) => typeof value === 'string' && value.split(/\s+/).every(token => allowed.includes(token)) ? value : null;
  const nodes = [];
  let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  for (; node && nodes.length < 32; node = node.parentElement) {
    const style = getComputedStyle(node);
    nodes.push({
      tag: tags.has(node.tagName) ? node.tagName : 'OTHER',
      root: node === document.scrollingElement,
      clientHeight: number(node.clientHeight), scrollHeight: number(node.scrollHeight),
      clientWidth: number(node.clientWidth), scrollWidth: number(node.scrollWidth), scrollTop: number(node.scrollTop),
      overflowX: keyword(style.overflowX, ['visible', 'hidden', 'clip', 'auto', 'scroll', 'overlay']),
      overflowY: keyword(style.overflowY, ['visible', 'hidden', 'clip', 'auto', 'scroll', 'overlay']),
      contain: tokens(style.contain, ['none', 'strict', 'content', 'size', 'inline-size', 'layout', 'style', 'paint']),
      contentVisibility: keyword(style.contentVisibility, ['visible', 'hidden', 'auto']),
      containerType: tokens(style.containerType, ['normal', 'size', 'inline-size', 'scroll-state'])
    });
  }
  return JSON.stringify({ version: 1, viewport: { width: number(innerWidth), height: number(innerHeight) }, nodes, truncated: Boolean(node) });
})();
