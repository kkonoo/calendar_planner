'use strict';
// 할 일 자세히 보기: 보드 / 눈금(표). 왼쪽 탭 = 카테고리, 보드의 열 = 카테고리 안의 그룹. (app.js 의 함수·데이터를 사용)
// 대상: 시간 없는 한 번짜리 항목(= 할 일). 시간 있는 일정·반복·여러 날 일정은 달력에서만.
// 그룹은 category.buckets = [{ id, name }], 할 일의 그룹은 item.bucket
const isTask = it => !it.time && !it.repeat && !isSpan(it);
const tasks = () => live().filter(isTask);
// 마감일 가까운 순 → 날짜 없는 것은 뒤로
const taskOrder = (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt;
const catById = id => db.categories.find(c => c.id === id);
const knownCat = it => (catById(it.cat) ? it.cat : null);
const bucketsOf = catId => (catById(catId) || {}).buckets || [];
const knownBucket = it => (bucketsOf(knownCat(it)).some(b => b.id === it.bucket) ? it.bucket : null);
const dragId = e => e.dataTransfer.getData('text/plain').split('|')[0];
// 지금 보고 있는 탭: 'all' | 'none'(미분류) | 카테고리 id
const currentPlan = () => { const p = prefs.plan || 'all'; return p === 'all' || p === 'none' || catById(p) ? p : 'all'; };
const inPlan = (it, plan) => plan === 'all' || (plan === 'none' ? !knownCat(it) : knownCat(it) === plan);

// 카테고리·그룹 옮기기. bucket이 undefined면: 같은 카테고리 안이면 그룹 유지, 다른 카테고리면 그룹 없음
function moveTask(id, cat, bucket) {
  const it = db.items.find(i => i.id === id);
  if (!it) return;
  const same = knownCat(it) === cat;
  const nb = bucket === undefined ? (same ? knownBucket(it) : null) : bucket;
  if (same && knownBucket(it) === nb) return;
  it.cat = cat;
  it.bucket = nb;
  touch(it);
  save();
}
function dropZone(e, onDrop) {
  e.addEventListener('dragover', ev => { ev.preventDefault(); e.classList.add('drop'); });
  e.addEventListener('dragleave', ev => { if (!e.contains(ev.relatedTarget)) e.classList.remove('drop'); });
  e.addEventListener('drop', ev => { ev.preventDefault(); e.classList.remove('drop'); onDrop(dragId(ev)); });
}
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

// ---------- 왼쪽 탭 (보드·눈금 공통) ----------
function renderPlanNav() {
  const open = tasks().filter(it => !it.done);
  const plans = [
    { key: 'all', name: '전체' },
    ...db.categories.map(c => ({ key: c.id, name: c.name, color: c.color })),
    { key: 'none', name: '미분류' },
  ];
  const cur = currentPlan();
  $('planNav').replaceChildren(...plans.map(p => {
    const b = h('button', `plan${p.key === cur ? ' on' : ''}${p.key === 'all' ? ' all' : ''}`);
    if (p.color) b.style.setProperty('--c', p.color);
    const n = open.filter(it => inPlan(it, p.key)).length;
    b.append(h('span', 'dot'), h('span', 'plan-name', p.name), h('span', 'count', n || ''));
    b.addEventListener('click', () => { prefs.plan = p.key; savePrefs(); render(); });
    // 탭에 카드를 끌어다 놓으면 그 카테고리로
    if (p.key !== 'all') dropZone(b, id => moveTask(id, p.key === 'none' ? null : p.key));
    return b;
  }));
}

// ---------- 보드 ----------
const openDoneCols = new Set();
let boardFocus; // 작업·그룹 추가 후 다시 커서 줄 곳

function card(it, showGroup) {
  const e = h('div', 'card' + (it.done ? ' done' : ''));
  setColor(e, it.cat);
  const top = h('div', 'card-top');
  top.append(doneCheck(it), h('span', 'card-title', it.title));
  e.append(top);
  const todo = it.done ? [] : (it.checklist || []).filter(c => !c.done).slice(0, 5);
  for (const c of todo) {
    const row = h('div', 'card-cl');
    const b = h('button', 'check small');
    b.setAttribute('aria-label', '항목 완료');
    b.addEventListener('click', ev => { ev.stopPropagation(); c.done = true; touch(it); save(); });
    row.append(b, h('span', '', c.text));
    e.append(row);
  }
  if (!todo.length && !it.done && it.note) e.append(h('div', 'card-note', it.note));

  const meta = h('div', 'card-meta');
  const group = showGroup && bucketsOf(knownCat(it)).find(b => b.id === it.bucket);
  if (group) meta.append(h('span', 'tag', group.name));
  const due = dueBadge(it);
  if (due) meta.append(due);
  const p = clProgress(it);
  if (p) meta.append(h('span', '', `☑ ${p}`));
  if (meta.childElementCount) e.append(meta);
  e.addEventListener('click', () => openEditor(it, it.date));
  draggable(e, it, it.date);
  return e;
}

// c = { key, name, color, cat, bucket(undefined: 전체 보기의 카테고리 열), group(이름 바꿀 수 있는 그룹), items }
function column(c, plan) {
  const open = c.items.filter(it => !it.done).sort(taskOrder);
  const done = c.items.filter(it => it.done).sort(taskOrder);
  const key = `${plan}/${c.key}`;
  const col = h('section', 'col');
  col.dataset.key = key;
  if (c.color) col.style.setProperty('--c', c.color);

  const head = h('div', 'col-head');
  head.append(h('span', 'dot'));
  if (c.group) {
    const name = h('input', 'col-name');
    name.value = c.group.name;
    name.title = '눌러서 이름 바꾸기';
    name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) name.blur(); });
    name.addEventListener('change', () => { c.group.name = name.value.trim() || c.group.name; save(); });
    const del = h('button', 'icon-btn small col-del', '✕');
    del.title = '그룹 삭제';
    del.addEventListener('click', () => {
      const n = c.items.length;
      if (n && !confirm(`'${c.group.name}' 그룹을 삭제할까요? 안의 작업 ${n}개는 '그룹 없음'으로 옮겨져요.`)) return;
      const cat = catById(c.cat);
      cat.buckets = cat.buckets.filter(b => b !== c.group);
      db.items.forEach(i => { if (i.bucket === c.group.id) { i.bucket = null; touch(i); } });
      save();
    });
    head.append(name, h('span', 'count', open.length), del);
  } else head.append(h('h3', '', c.name), h('span', 'count', open.length));

  const add = h('form', 'col-add');
  const input = h('input', 'add-input');
  input.placeholder = '+ 작업 추가';
  input.autocomplete = 'off';
  add.append(input);
  add.addEventListener('submit', e => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    db.items.push(newItem({ title, cat: c.cat, bucket: c.bucket || null }));
    boardFocus = `.col[data-key="${key}"] .add-input`;
    save();
  });
  const list = h('div', 'cards');
  list.append(...open.map(it => card(it, plan === 'all')));
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
      dl.append(...done.map(it => card(it, plan === 'all')));
      col.append(dl);
    }
  }
  dropZone(col, id => moveTask(id, c.cat, c.bucket));
  return col;
}

function renderBoard() {
  renderPlanNav();
  const plan = currentPlan(), all = tasks();
  const none = { key: 'none', name: '미분류', cat: null, bucket: null, items: all.filter(it => !knownCat(it)) };
  let cols;
  if (plan === 'all') {
    cols = [...db.categories.map(c => ({ key: c.id, name: c.name, color: c.color, cat: c.id, items: all.filter(it => knownCat(it) === c.id) })), none];
  } else if (plan === 'none') {
    cols = [none];
  } else {
    const c = catById(plan), mine = all.filter(it => knownCat(it) === plan);
    cols = bucketsOf(plan).map(b => ({ key: b.id, name: b.name, color: c.color, cat: plan, bucket: b.id, group: b, items: mine.filter(it => knownBucket(it) === b.id) }));
    const loose = mine.filter(it => !knownBucket(it));
    if (loose.length || !cols.length) cols.push({ key: 'loose', name: cols.length ? '그룹 없음' : c.name, color: c.color, cat: plan, bucket: null, items: loose });
  }
  const board = $('boardCols');
  board.replaceChildren(...cols.map(c => column(c, plan)));
  if (plan !== 'all' && plan !== 'none') {
    const addGroup = h('button', 'add-group', '+ 새 그룹 추가');
    addGroup.addEventListener('click', () => {
      const c = catById(plan), b = { id: uid(), name: '새 그룹' };
      c.buckets = [...(c.buckets || []), b];
      boardFocus = `.col[data-key="${plan}/${b.id}"] .col-name`;
      save();
    });
    board.append(addGroup);
  }
  if (boardFocus) {
    const e = board.querySelector(boardFocus);
    if (e) { e.focus(); if (e.select) e.select(); }
    boardFocus = undefined;
  }
}

// ---------- 눈금 (표) ----------
function renderTable() {
  renderPlanNav();
  const plan = currentPlan(), mine = tasks().filter(it => inPlan(it, plan)), showDone = !!prefs.tableDone;
  $('tableDoneChk').checked = showDone;
  $('tableDoneLabel').textContent = `완료된 작업도 표시 (${mine.filter(it => it.done).length})`;
  const rows = mine.filter(it => showDone || !it.done).sort((a, b) => a.done - b.done || taskOrder(a, b));
  const stop = e => e.stopPropagation();
  const select = (options, value, onChange) => {
    const s = h('select', 't-input');
    for (const [v, label] of options) { const o = h('option', '', label); o.value = v; s.append(o); }
    s.value = value;
    s.addEventListener('click', stop);
    s.addEventListener('change', () => onChange(s.value || null));
    return s;
  };

  $('taskRows').replaceChildren(...(rows.length ? rows.map(it => {
    const tr = h('tr', it.done ? 'done' : '');
    setColor(tr, it.cat);
    const tdCheck = h('td', 't-check');
    tdCheck.append(doneCheck(it));

    // 카테고리·그룹·날짜는 표에서 바로 바꿀 수 있게
    const tdCat = h('td', 't-cat');
    tdCat.append(h('span', 'dot'), select([['', '미분류'], ...db.categories.map(c => [c.id, c.name])], knownCat(it) || '',
      v => { it.cat = v; it.bucket = null; touch(it); save(); }));
    const tdGroup = h('td', 't-group');
    const bs = bucketsOf(knownCat(it));
    if (bs.length) {
      tdGroup.append(select([['', '그룹 없음'], ...bs.map(b => [b.id, b.name])], knownBucket(it) || '',
        v => { it.bucket = v; touch(it); save(); }));
    }
    const date = h('input', 't-input');
    date.type = 'date';
    date.value = it.date || '';
    date.addEventListener('click', stop);
    date.addEventListener('change', () => { it.date = date.value || null; touch(it); save(); });
    const tdDate = h('td', 't-date' + (!it.done && it.date && it.date < todayStr() ? ' late' : ''));
    tdDate.append(date);

    tr.append(tdCheck, h('td', 't-title', it.title), tdCat, tdGroup, tdDate,
      h('td', 't-cl', clProgress(it) ? `☑ ${clProgress(it)}` : ''),
      h('td', 't-note', (it.note || '').split('\n')[0]));
    tr.addEventListener('click', () => openEditor(it, it.date));
    return tr;
  }) : [(() => { const tr = h('tr', 'empty'), td = h('td', '', '할 일이 없어요'); td.colSpan = 7; tr.append(td); return tr; })()]));
}
$('tableDoneChk').addEventListener('change', e => { prefs.tableDone = e.target.checked; savePrefs(); renderTable(); });
$('tableAdd').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('tableInput').value.trim();
  if (!title) return;
  const plan = currentPlan();
  db.items.push(newItem({ title, cat: plan === 'all' || plan === 'none' ? null : plan }));
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
