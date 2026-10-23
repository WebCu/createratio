'use strict';
const createDOM = require('../src/content/dom.js');

class Element {
  constructor(selectors = [], text = '', listen = () => {}) {
    this.selectors = new Set(selectors); this.textContent = text;
    this.children = []; this.isConnected = true; this.attributes = {}; this.style = {};
    this.listen = listen;
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } return nodes[0]; }
  matches(selector) {
    return selector.split(',').some(part => this.selectors.has(part) || part === '[hidden]' && this.attributes.hidden !== undefined || part === '[aria-hidden="true"]' && this.attributes['aria-hidden'] === 'true');
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(node) {
    let root = this; while (root.parentElement) root = root.parentElement;
    const flatten = item => [item, ...item.children.flatMap(flatten)];
    const nodes = flatten(root); return nodes.indexOf(node) > nodes.indexOf(this) ? 4 : 2;
  }
  getClientRects() { return this.isConnected ? [{}] : []; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, fn) { this.listen(type, fn); }
  attachShadow() { return this.shadow = new Element([], '', this.listen); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.isConnected = false; this.removed = true; }
}
function environment(url, listen = () => {}) {
  const html = new Element(), body = html.append(new Element());
  const location = { href: url, pathname: new URL(url).pathname };
  const document = {
    body, documentElement: html, activeElement: body, visibilityState: 'visible', hasFocus: () => true,
    querySelectorAll: selector => html.querySelectorAll(selector), querySelector: selector => html.querySelector(selector),
    addEventListener: listen, createElement: () => new Element([], '', listen)
  };
  const getComputedStyle = node => ({ visibility: node.style.visibility || 'visible', display: node.style.display || 'block' });
  const dom = createDOM({ document, location, Element, getComputedStyle });
  return { document, body, location, dom, Element, getComputedStyle };
}
function xFixture({ dialog = false, url = 'https://x.com/home', action = 'posts', listen } = {}) {
  const env = environment(url, listen);
  const scope = env.body.append(new Element([dialog || action === 'quotes' ? '[role="dialog"]' : '[data-testid="tweetComposer"]']));
  const editor = scope.append(new Element(['[data-testid="tweetTextarea_0"][contenteditable="true"]']));
  const button = scope.append(new Element(['[data-testid="tweetButton"]'], 'Post'));
  if (action === 'replies') scope.append(new Element(['[data-testid="replyingTo"]']));
  if (action === 'quotes') scope.append(new Element(['[data-testid="quoteTweetPreview"]']));
  return { ...env, scope, editor, button, adapter: require('./x.js').create(env) };
}
function linkedinFixture({ url = 'https://www.linkedin.com/feed/', message = false, standalonePost = false, listen } = {}) {
  const env = environment(url, listen);
  const scope = env.body.append(new Element(standalonePost ? [] : [message ? '.msg-form' : '.comments-comment-box']));
  const editor = scope.append(new Element(standalonePost ? ['.tiptap.ProseMirror[role="textbox"][contenteditable="true"]'] : message ? ['.msg-form__contenteditable[contenteditable="true"]', '.msg-form [contenteditable="true"]'] : ['.comments-comment-box [contenteditable="true"]']));
  const button = scope.append(new Element(['button', message ? '.msg-form__send-button' : '.comments-comment-box__submit-button'], message ? 'Send' : 'Comment'));
  return { ...env, scope, editor, button, adapter: require('./linkedin.js').create(env) };
}
function key(target, extra = {}) { return { type: 'keydown', key: 'Enter', target, ...extra }; }
function click(target) { return { type: 'click', target }; }
module.exports = { Element, environment, xFixture, linkedinFixture, key, click };
