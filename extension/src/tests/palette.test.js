'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stylesheet(file) {
  const css = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]+)\\}'))[1];
  const declarations = selector => Object.fromEntries(rule(selector).split(';').filter(value => value.includes(':')).map(value => value.split(':').map(part => part.trim())));
  const tokens = declarations(':root');
  const color = (selector, property) => {
    const value = declarations(selector)[property];
    return value.startsWith('var(') ? tokens[value.slice(4, -1)] : value;
  };
  return { tokens, color };
}
function luminance(hex) {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(value => value + value).join('');
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(foreground, background, minimum, label) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  const ratio = (values[0] + 0.05) / (values[1] + 0.05);
  assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(2)}:1 must be at least ${minimum}:1`);
}

test('website and extension share readable violet branding and text', () => {
  const site = stylesheet('../../../site/styles.css');
  for (const file of ['../shared/popup.css', '../pages/blocked/blocked.css']) {
    const css = stylesheet(file);
    for (const token of ['--paper', '--ink', '--muted', '--violet']) assert.equal(css.tokens[token], site.tokens[token], `${file}: ${token}`);
    contrast(css.tokens['--ink'], css.tokens['--paper'], 4.5, `${file}: text`);
    contrast(css.tokens['--muted'], css.tokens['--paper'], 4.5, `${file}: muted text`);
    contrast('#fff', css.tokens['--violet'], 4.5, `${file}: brand and buttons`);
    contrast(css.tokens['--control-line'], '#fff', 3, `${file}: control border`);
  }
});
test('extension score-card text and chart bars remain readable', () => {
  const css = stylesheet('../shared/popup.css');
  const surface = css.color('.score-card', 'background');
  for (const selector of ['.caption', '.score-card p', '.goal small']) contrast(css.color(selector, 'color'), surface, 4.5, selector);
  for (const token of ['--green', '--consume']) contrast(css.tokens[token], css.tokens['--paper'], 3, `${token}: chart bar`);
  contrast(css.tokens['--muted'], css.color('.view-nav', 'background'), 4.5, 'navigation text');
});
test('website illustrative card keeps dark text on both lavender bars', () => {
  const css = stylesheet('../../../site/styles.css');
  for (const selector of ['.creating', '.consuming', '.example']) contrast(css.tokens['--ink'], css.color(selector, 'background'), 4.5, selector);
  contrast(css.tokens['--muted'], css.color('.example', 'background'), 4.5, 'example caption');
});
