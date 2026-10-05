'use strict';
// 할 일 자세히 보기: 보드(카테고리별 열) / 눈금(표). (app.js 의 함수·데이터를 사용)
// 대상: 시간 없는 한 번짜리 항목(= 할 일). 시간 있는 일정·반복·여러 날 일정은 달력에서만.
const isTask = it => !it.time && !it.repeat && !isSpan(it);
const tasks = () => live().filter(isTask);
// 마감일 가까운 순 → 날짜 없는 것은 뒤로
const taskOrder = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt;
const knownCat = it => (catColor(it.cat) ? it.cat : null);

function dueBadge(it) {
  if (!it.date) return null;
  return h('span', 'due' + (!it.done && it.date < todayStr() ? ' late' : ''), `📅 ${fmtShort(it.date)}`);
}
function doneCheck(it) {
  const b = h('button', 'check' + (it.done ? ' on' : ''));
  b.setAttribute('aria-label', '완료 표시');
  b.addEventListener('click', e => { e.stopPropagation(); toggleDone(it); });
  return b;
}

// ---------- 보드 ----------
const openDoneCols = new Set();
let boardFocus; // 작업 추가 후 같은 열 입력칸에 다시 커서

function card(it) {
  const e = h('div', 'card' + (it.done ? ' done' : ''));
  setColor(e, it.cat);
  const top = h('div', 'card-top');
  top.append(doneCheck(it), h('span', 'card-title', it.title));
  e.append(top);
  if (!it.done) {
    for (const c of (it.checklist || []).filter(c => !c.done).slice(0, 5)) {
      const row = h('div', 'card-cl');
      const b = h('button', 'check small');
      b.setAttribute('aria-label', '항목 완료');
      b.addEventListener('click', ev => { ev.stopPropagation(); c.done = true; touch(it); save(); });
      row.append(b, h('span', '', c.text));
      e.append(row);
    }
  }
  const meta = h('div', 'card-meta');
  const due = dueBadge(it);
  if (due) meta.append(due);
  const p = clProgress(it);
  if (p) meta.append(h('span', '', `☑ ${p}`));
  if (it.note) meta.append(h('span', '', '📝 메모'));
  if (meta.childElementCount) e.append(meta);
  e.addEventListener('click', () => openEditor(it, it.date));
  draggable(e, it, it.date);
  return e;
}

function renderBoard() {
  const all = tasks();
  const cols = [...db.categories, { id: null, name: '미분류', color: null }];
  $('boardView').replaceChildren(...cols.map(c => {
    const mine = all.filter(it => knownCat(it) === c.id).sort(taskOrder);
    const open = mine.filter(it => !it.done), done = mine.filter(it => it.done);
    const key = String(c.id);
    const col = h('section', 'col');
    col.dataset.cat = key;
    if (c.color) col.style.setProperty('--c', c.color);

    const head = h('div', 'col-head');
    head.append(h('span', 'dot'), h('h3', '', c.name), h('span', 'count', open.length));
    const add = h('form', 'col-add');
    const input = h('input', 'add-input');
    input.placeholder = '+ 작업 추가';
    input.autocomplete = 'off';
    add.append(input);
    add.addEventListener('submit', e => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      db.items.push(newItem({ title, cat: c.id }));
      boardFocus = key;
      save();
    });
    const list = h('div', 'cards');
    list.append(...open.map(card));
    col.append(head, add, list);

    if (done.length) {
      const toggle = h('button', 'done-toggle', `완료된 작업 ${done.length} ${openDoneCols.has(key) ? '▴' : '▾'}`);
      toggle.addEventListener('click', () => {
        if (openDoneCols.has(key)) openDoneCols.delete(key); else openDoneCols.add(key);
        renderBoard();
      });
      col.append(toggle);
      if (openDoneCols.has(key)) {
        const dl = h('div', 'cards');
        dl.append(...done.map(card));
        col.append(dl);
      }
    }

    // 다른 열로 끌어다 놓으면 카테고리 변경
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drop');
      const it = db.items.find(i => i.id === e.dataTransfer.getData('text/plain').split('|')[0]);
      if (it && knownCat(it) !== c.id) { it.cat = c.id; touch(it); save(); }
    });
    return col;
  }));
  if (boardFocus !== undefined) {
    const input = $('boardView').querySelector(`.col[data-cat="${boardFocus}"] .add-input`);
    if (input) input.focus();
    boardFocus = undefined;
  }
}

// ---------- 눈금 (표) ----------
function renderTable() {
  const all = tasks(), showDone = !!prefs.tableDone;
  const doneCount = all.filter(it => it.done).length;
  $('tableDoneChk').checked = showDone;
  $('tableDoneLabel').textContent = `완료된 작업도 표시 (${doneCount})`;
  const rows = all.filter(it => showDone || !it.done).sort((a, b) => a.done - b.done || taskOrder(a, b));

  $('taskRows').replaceChildren(...(rows.length ? rows.map(it => {
    const tr = h('tr', it.done ? 'done' : '');
    setColor(tr, it.cat);
    const stop = e => e.stopPropagation();

    const tdCheck = h('td', 't-check');
    tdCheck.append(doneCheck(it));

    // 카테고리·날짜는 표에서 바로 바꿀 수 있게
    const cat = h('select', 't-input');
    for (const c of [{ id: '', name: '미분류' }, ...db.categories]) {
      const o = h('option', '', c.name);
      o.value = c.id;
      cat.append(o);
    }
    cat.value = knownCat(it) || '';
    cat.addEventListener('click', stop);
    cat.addEventListener('change', () => { it.cat = cat.value || null; touch(it); save(); });
    const tdCat = h('td', 't-cat');
    tdCat.append(h('span', 'dot'), cat);

    const date = h('input', 't-input');
    date.type = 'date';
    date.value = it.date || '';
    date.addEventListener('click', stop);
    date.addEventListener('change', () => { it.date = date.value || null; touch(it); save(); });
    const tdDate = h('td', 't-date' + (!it.done && it.date && it.date < todayStr() ? ' late' : ''));
    tdDate.append(date);

    tr.append(tdCheck, h('td', 't-title', it.title), tdCat, tdDate,
      h('td', 't-cl', clProgress(it) ? `☑ ${clProgress(it)}` : ''),
      h('td', 't-note', (it.note || '').split('\n')[0]));
    tr.addEventListener('click', () => openEditor(it, it.date));
    return tr;
  }) : [(() => { const tr = h('tr', 'empty'); const td = h('td', '', '할 일이 없어요'); td.colSpan = 6; tr.append(td); return tr; })()]));
}
$('tableDoneChk').addEventListener('change', e => { prefs.tableDone = e.target.checked; savePrefs(); renderTable(); });
$('tableAdd').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('tableInput').value.trim();
  if (!title) return;
  db.items.push(newItem({ title }));
  $('tableInput').value = '';
  save();
  $('tableInput').focus();
});

// 보기 전환 버튼
document.querySelectorAll('#viewSeg [data-view]').forEach(b => b.addEventListener('click', () => {
  prefs.view = b.dataset.view;
  savePrefs();
  render();
}));
