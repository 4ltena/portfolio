'use strict';

(() => {
  const fragment = location.hash.slice(1);
  const match = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/.exec(fragment);
  const state = document.getElementById('state');
  const note = document.getElementById('note');
  const notFound = () => {
    state.textContent = 'この限定公開ノートは利用できません。';
    document.title = 'Shared note unavailable | Altena';
  };
  if (!match) { notFound(); return; }

  const [, id, signature] = match;
  fetch(`/portfolio/api/shared-articles/${encodeURIComponent(id)}`, {
    headers: { 'X-Note-Share': signature },
    cache: 'no-store',
    referrerPolicy: 'no-referrer'
  }).then(async response => {
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  }).then(article => {
    document.getElementById('note-title').textContent = article.title || '';
    document.getElementById('note-date').textContent = article.date || '';
    const tags = document.getElementById('note-tags');
    (article.tags || []).forEach(tag => {
      const chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = `#${tag}`; tags.appendChild(chip);
    });
    // The API sanitizer is canonical. Text is never interpolated into HTML here.
    document.getElementById('note-content').innerHTML = article.content || '';
    document.title = `${article.title || 'Shared note'} | Altena`;
    state.remove(); note.hidden = false;
  }).catch(notFound);
})();
