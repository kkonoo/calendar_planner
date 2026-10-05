'use strict';
// 검색: 제목·메모·체크리스트에서 찾기. 결과를 누르면 그 날짜로 이동 + 편집 창. (app.js 의 함수·데이터를 사용)
const searchInput = $('searchInput'), searchBox = $('searchResults');
let searchHits = [], searchActive = 0;

function searchItems(q) {
  const today = todayStr();
  const text = it => [it.title, it.note, ...(it.checklist || []).map(c => c.text)].join('\n').toLowerCase();
  // 다가오는 일정(가까운 순) → 지난 일정(최근 순) → 날짜 없는 할 일
  const rank = r => (!r.when ? 2 : r.when >= today ? 0 : 1);
  return live().filter(it => text(it).includes(q))
    .map(it => ({ it, when: it.repeat ? nextOccurrence(it, today) || it.date : it.date }))
    .sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 0 ? a.when.localeCompare(b.when) : rank(a) === 1 ? b.when.localeCompare(a.when) : b.it.createdAt - a.it.createdAt));
}

// 찾은 글자 표시 (<mark>)
function marked(cls, text, q) {
  const e = h('span', cls), i = text.toLowerCase().indexOf(q);
  if (i < 0) e.textContent = text;
  else e.append(text.slice(0, i), h('mark', '', text.slice(i, i + q.length)), text.slice(i + q.length));
  return e;
}

function renderSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchBox.hidden = true; return; }
  searchHits = searchItems(q).slice(0, 50);
  searchActive = 0;
  const thisYear = ymd(todayStr())[0];
  searchBox.replaceChildren(...(searchHits.length ? searchHits.map(({ it, when }, k) => {
    const row = h('button', 'sr' + (k === 0 ? ' on' : ''));
    row.type = 'button';
    setColor(row, it.cat);
    const date = when ? `${ymd(when)[0] !== thisYear ? `${ymd(when)[0]}. ` : ''}${fmtShort(when)}` : '할 일';
    row.append(h('span', 'dot'), marked('sr-title', it.title, q),
      h('span', 'sr-meta', [date, it.time, it.repeat ? '↻' : ''].filter(Boolean).join(' ')));
    // 제목에 없고 메모·체크리스트에서 찾은 경우 그 부분을 한 줄 보여줌
    if (!it.title.toLowerCase().includes(q)) {
      const line = [it.note || '', ...(it.checklist || []).map(c => c.text)].join('\n').split('\n').find(l => l.toLowerCase().includes(q));
      if (line) row.append(marked('sr-snip', line.trim(), q));
    }
    row.addEventListener('mousedown', e => e.preventDefault()); // 검색칸 포커스 유지
    row.addEventListener('click', () => openHit(k));
    return row;
  }) : [h('div', 'sr-empty', '찾는 일정이 없어요')]));
  searchBox.hidden = false;
}

function openHit(k) {
  const hit = searchHits[k];
  if (!hit) return;
  searchBox.hidden = true;
  searchInput.blur();
  if (hit.when) { prefs.view = 'calendar'; savePrefs(); select(hit.when); }
  openEditor(hit.it, hit.when || null);
}

searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('focus', renderSearch);
searchInput.addEventListener('blur', () => { searchBox.hidden = true; });
searchInput.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Escape') { searchInput.value = ''; searchBox.hidden = true; searchInput.blur(); return; }
  if (e.key === 'Enter') { e.preventDefault(); openHit(searchActive); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = searchBox.querySelectorAll('.sr');
  if (!rows.length) return;
  searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows.forEach((r, k) => r.classList.toggle('on', k === searchActive));
  rows[searchActive].scrollIntoView({ block: 'nearest' });
});
// Ctrl+K (Mac: ⌘K) → 검색칸
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
