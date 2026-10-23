(function (root) {
  'use strict';
  function mount({ messages, range, error }) {
    const $ = id => document.getElementById(id);
    const button = $('share-create'), label = button.textContent;
    const expandable = button.hasAttribute('aria-expanded');
    let url = null, card = null, version = 0, copying = false;
    function clear() {
      version++;
      if (url) URL.revokeObjectURL(url);
      url = null; card = null;
      $('share-preview').width = 0; $('share-preview').height = 0;
      $('share-preview').removeAttribute('aria-label');
      $('share-result').hidden = true; $('share-caption').value = '';
      $('share-download').disabled = true; $('share-copy').disabled = true;
      $('share-status').textContent = '';
      if (expandable) button.setAttribute('aria-expanded', 'false');
      if ($('share-caption-details')) $('share-caption-details').open = false;
    }
    clear();
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      clear(); error();
      const request = version;
      button.disabled = true; button.textContent = 'Preparing…';
      try {
        const now = new Date(), date = C3.localDate(now), period = range();
        const data = await messages.send({ type: 'history', kind: 'ratio', range: period }, 'Unable to create share card.');
        if (request !== version) return;
        if (C3.localDate() !== date) throw new Error('The local date changed while loading history. Please try again.');
        const next = SocialCard.create(data.days, period, now), canvas = $('share-preview');
        SocialCard.draw(canvas, next);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to create the PNG. Please try again.')), 'image/png'));
        if (request !== version) return;
        url = URL.createObjectURL(blob); card = next;
        canvas.setAttribute('aria-label', card.description);
        $('share-caption').value = card.caption; $('share-result').hidden = false;
        $('share-download').disabled = false; $('share-copy').disabled = copying;
        if (expandable) button.setAttribute('aria-expanded', 'true');
        $('share-status').textContent = 'Your card is ready. Review it before sharing.';
      } catch (e) { if (request === version) { clear(); error(e.message); } }
      finally { button.disabled = false; button.textContent = label; }
    });
    $('share-download').addEventListener('click', () => {
      if (!card || !url) return;
      const link = document.createElement('a'); link.href = url;
      link.download = card.filename; document.body.append(link); link.click(); link.remove();
      $('share-status').textContent = 'PNG download started. Attach it to your post and include the caption link.';
    });
    $('share-copy').addEventListener('click', async () => {
      if (!card || copying) return;
      const caption = $('share-caption').value, request = version;
      copying = true; $('share-copy').disabled = true;
      try {
        await navigator.clipboard.writeText(caption);
        if (request === version) $('share-status').textContent = 'Caption copied. Paste it alongside your image.';
      } catch (_) {
        if (request !== version) return;
        if ($('share-caption-details')) $('share-caption-details').open = true;
        $('share-caption').focus(); $('share-caption').select();
        $('share-status').textContent = 'Clipboard unavailable. The caption is selected; copy it manually.';
      } finally {
        copying = false;
        if (card) $('share-copy').disabled = false;
      }
    });
    if ($('share-close')) $('share-close').addEventListener('click', () => { clear(); error(); button.focus(); });
    addEventListener('pagehide', clear);
    return { clear };
  }
  root.SocialSharing = { mount };
})(globalThis);
