'use strict';

// ---------- 날짜 유틸: 'YYYY-MM-DD' 문자열 ↔ 일(day) 번호 ----------
const DAY_MS = 86400000;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const toNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS;
const toStr = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
const ymd = s => [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)];
const weekday = n => (n + 4) % 7; // 1970-01-01 = 목요일
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDay = s => { const [, m, d] = ymd(s); return `${m}월 ${d}일 ${WD[weekday(toNum(s))]}요일`; };
const fmtShort = s => { const [, m, d] = ymd(s); return `${m}/${d} (${WD[weekday(toNum(s))]})`; };
const fmtMD = s => { const [, m, d] = ymd(s); return `${m}/${d}`; };

// '9' '930' '14:15' '1415' → 'HH:MM', 빈칸 → '', 잘못된 값 → null
function parseTime(v) {
  v = v.trim();
  if (!v) return '';
  const m = v.match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) return null;
  return `${pad(m[1])}:${m[2] || '00'}`;
}

// 한국 음력: 브라우저 내장 dangi 달력 사용 (윤달은 '6bis'처럼 나옴)
const LUNAR_FMT = new Intl.DateTimeFormat('en-u-ca-dangi', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const lunarCache = new Map();
function lunar(s) {
  let v = lunarCache.get(s);
  if (!v) {
    const p = Object.fromEntries(LUNAR_FMT.formatToParts(new Date(`${s}T00:00:00Z`)).map(x => [x.type, x.value]));
    v = { y: +p.relatedYear, m: parseInt(p.month, 10), d: +p.day, leap: p.month.endsWith('bis') };
    lunarCache.set(s, v);
  }
  return v;
}

// ---------- 반복 규칙 ----------
// repeat = { freq: 'daily'|'weekly'|'monthly'|'yearly', interval, days?: [0-6], nth?: true, lunar?: true, until?: 'YYYY-MM-DD' }
// 반복 없는 일정은 endDate로 며칠짜리 일정이 될 수 있음
function occursOn(it, s) {
  if (!it.date) return false;
  if (!it.repeat) return it.date <= s && s <= (it.endDate || it.date);
  const r = it.repeat, a = toNum(it.date), b = toNum(s), n = r.interval || 1;
  if (b < a || (r.until && s > r.until) || it.skipDates.includes(s)) return false;
  const [ay, am, ad] = ymd(it.date), [by, bm, bd] = ymd(s);
  switch (r.freq) {
    case 'daily': return (b - a) % n === 0;
    case 'weekly': return r.days.includes(weekday(b)) && ((b - weekday(b)) - (a - weekday(a))) / 7 % n === 0;
    case 'monthly':
      if (((by - ay) * 12 + bm - am) % n) return false;
      return r.nth ? weekday(b) === weekday(a) && Math.ceil(bd / 7) === Math.ceil(ad / 7) : bd === ad;
    case 'yearly': {
      if (!r.lunar) return bm === am && bd === ad && (by - ay) % n === 0;
      if (b === a) return true; // 시작일이 윤달이어도 표시
      const A = lunar(it.date), B = lunar(s);
      if (B.leap || B.m !== A.m || (B.y - A.y) % n) return false;
      // 음력 30일이 없는 해에는 그 달 마지막 날(29일)에
      return B.d === A.d || (A.d === 30 && B.d === 29 && lunar(toStr(b + 1)).d === 1);
    }
  }
  return false;
}
const isDone = (it, s) => it.repeat ? it.doneDates.includes(s) : it.done;
const isSpan = it => !it.repeat && !!it.endDate && it.endDate > it.date;

// 반복 횟수(예: 12회) → 마지막 날짜
function untilFromCount(it, count) {
  let k = 0;
  for (let b = toNum(it.date), end = b + 3700; b < end; b++) {
    if (occursOn(it, toStr(b)) && ++k === count) return toStr(b);
  }
  return null;
}

function nextOccurrence(it, from) {
  if (!it.repeat) return it.date >= from ? it.date : null;
  const end = toNum(from) + 366 * (it.repeat.interval || 1) + 31;
  for (let b = Math.max(toNum(from), toNum(it.date)); b <= end; b++) {
    const s = toStr(b);
    if (it.repeat.until && s > it.repeat.until) return null;
    if (occursOn(it, s)) return s;
  }
  return null;
}

// ---------- 저장소 ----------
const KEY = 'planner.v1', PKEY = 'planner.prefs';
const DEFAULT_CATS = [
  { id: 'work', name: '업무', color: '#8B93A1' },
  { id: 'lab', name: '학생·랩', color: '#2BB39A' },
  { id: 'research', name: '연구·외부', color: '#9D7BE0' },
  { id: 'social', name: '약속·모임', color: '#F0727A' },
  { id: 'personal', name: '개인·가족', color: '#E8B10C' },
  { id: 'teach', name: '강의·교육', color: '#5B9BEA' },
];
const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
// 일정 데이터는 IndexedDB에 (localStorage는 사이트 주소당 약 5MB이고 같은 주소의 일상노트와 나눠 씀).
// 예전 localStorage 값은 처음 한 번 옮기고 지움. IndexedDB를 못 쓰는 브라우저면 localStorage 그대로
let db = { version: 1, categories: DEFAULT_CATS, items: [] }, idb = null, dbLoaded = false;
const idbReq = (r, ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); };
const dbReady = new Promise((ok, fail) => {
  const r = indexedDB.open('calendar-planner', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  idbReq(r, d => idbReq(d.transaction('kv').objectStore('kv').get(KEY), v => { idb = d; ok(v); }, fail), fail);
}).catch(() => null).then(saved => {
  const legacy = readJSON(KEY);
  db = (saved && JSON.parse(saved)) || legacy || db;
  dbLoaded = true;
  if (idb && !saved && legacy) persist().then(() => localStorage.removeItem(KEY));
});
let prefs = readJSON(PKEY) || {};
const savePrefs = () => localStorage.setItem(PKEY, JSON.stringify(prefs));
const persist = () => {
  if (!dbLoaded) return Promise.resolve(); // 다 읽기 전의 빈 값으로 덮어쓰지 않게
  const s = JSON.stringify(db);
  if (!idb) return Promise.resolve(localStorage.setItem(KEY, s));
  return new Promise((ok, fail) => {
    const t = idb.transaction('kv', 'readwrite');
    t.objectStore('kv').put(s, KEY);
    t.oncomplete = ok;
    t.onerror = t.onabort = () => fail(t.error);
  });
};
// 변경 저장 → 다시 그리기 → (로그인돼 있으면) sync.js가 계정에 올림
function save() { persist(); render(); if (window.onSave) window.onSave(); }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function newItem(fields) {
  const t = Date.now();
  return {
    id: uid(), title: '', date: null, endDate: null, time: null, cat: null, place: '', note: '', done: false, dday: false,
    repeat: null, doneDates: [], skipDates: [], createdAt: t, updatedAt: t, ...fields,
  };
}
const touch = it => { it.updatedAt = Date.now(); };
// 삭제는 표시만 해둠 (나중에 기기 간 동기화할 때 삭제도 전달하려고)
const live = () => db.items.filter(i => !i.deleted);
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || a.createdAt - b.createdAt;
// 하루 안 순서: 완료는 맨 밑, 그 안에서 할 일(끌어서 정한 순서 dayOrder) → 일정(시간순)
const byDay = s => (a, b) => isDone(a, s) - isDone(b, s) || !!a.time - !!b.time
  || (a.time ? byTime(a, b) : (a.dayOrder ?? Infinity) - (b.dayOrder ?? Infinity) || a.createdAt - b.createdAt);
const itemsOn = s => shown().filter(i => occursOn(i, s)).sort(byDay(s));
const catColor = id => (db.categories.find(c => c.id === id) || {}).color || null;
const isSharedCat = id => !!(db.categories.find(c => c.id === id) || {}).shared;
// 공유 캘린더 일정이면 넣은 사람 이름 (내가 넣은 건 '')
const byName = it => (it.by && it.by.uid !== window.me?.uid && isSharedCat(it.cat) ? it.by.name : '');
// 추가 카테고리: db.also = { 일정 id: [카테고리 id] } — 내 계정에만 저장 (공유 일정에 붙여도 다른 멤버에겐 안 보임).
// 색·공유 여부는 대표 카테고리(it.cat)가 정하고, 추가는 내 카테고리만 (보기·탭에 같이 나오기만 함)
const alsoOf = it => ((db.also || {})[it.id] || []).filter(id => id !== it.cat && db.categories.some(c => c.id === id && !c.shared));
// 달력 화면에 보일 일정: 전체 / 개인 / 공유 (prefs.scope, 기기별). 공유 캘린더가 없으면 전체
// 공유 일정이라도 내 카테고리를 추가로 붙였으면 개인에도 나옴. 공유 보기에선 끈 공유 캘린더(prefs.hideShared)는 빼고
const scope = () => (db.categories.some(c => c.shared) && prefs.scope) || 'all';
const shown = () => {
  const s = scope(), off = prefs.hideShared || [];
  if (s === 'all') return live();
  return live().filter(it => (s === 'shared' ? isSharedCat(it.cat) && !off.includes(it.cat) : !isSharedCat(it.cat) || alsoOf(it).length > 0));
};
// 달력 화면의 색: 개인 보기에선 공유 일정도 내가 추가한 (첫) 카테고리 색, 전체·공유 보기는 대표(공유 캘린더) 색
const viewCat = it => (scope() === 'mine' && isSharedCat(it.cat) && alsoOf(it)[0]) || it.cat;
// 체크리스트 진행 '2/5' (없으면 '')
const clProgress = it => { const c = it.checklist || []; return c.length ? `${c.filter(x => x.done).length}/${c.length}` : ''; };

function toggleDone(it, s) {
  if (it.repeat) {
    const k = it.doneDates.indexOf(s);
    if (k < 0) it.doneDates.push(s); else it.doneDates.splice(k, 1);
  } else it.done = !it.done;
  touch(it);
  save();
}
// 반복 일정에서 하루만 떼어내 따로 고칠 수 있는 일반 일정으로 만듦
function detach(series, s) {
  series.skipDates.push(s);
  touch(series);
  const copy = newItem({
    title: series.title, date: s, time: series.time, endTime: series.endTime || null, cat: series.cat, place: series.place || '', note: series.note,
    done: series.doneDates.includes(s), seriesId: series.id,
  });
  db.items.push(copy);
  if ((db.also || {})[series.id]) db.also = { ...db.also, [copy.id]: db.also[series.id].slice() };
  return copy;
}
// 반복을 s 전날에서 끝냄 ('이후 모두 삭제' — s부터 따로 떼어 둔 날들도 지움)
function endSeries(series, s) {
  series.repeat = { ...series.repeat, until: toStr(toNum(s) - 1) };
  touch(series);
  db.items.forEach(i => { if (i.seriesId === series.id && i.date >= s && !i.deleted) { i.deleted = true; touch(i); } });
}
// '이후 모두' 고치기: 반복을 s 전날에서 끝내고 s부터는 새 반복으로 (편집 창에서 고친 내용은 새 반복에).
// s부터의 완료·뺀 날과 따로 떼어 둔 날들은 새 반복 쪽으로
function splitSeries(series, s) {
  const copy = newItem({ ...JSON.parse(JSON.stringify(series)), id: uid(), createdAt: Date.now(), date: s });
  copy.doneDates = series.doneDates.filter(d => d >= s);
  copy.skipDates = series.skipDates.filter(d => d >= s);
  series.repeat = { ...series.repeat, until: toStr(toNum(s) - 1) };
  touch(series);
  db.items.forEach(i => { if (i.seriesId === series.id && i.date >= s) { i.seriesId = copy.id; touch(i); } });
  if ((db.also || {})[series.id]) db.also = { ...db.also, [copy.id]: db.also[series.id].slice() };
  db.items.push(copy);
  return copy;
}
function moveTo(id, s) {
  const it = db.items.find(i => i.id === id);
  if (!it || it.repeat || it.date === s) return;
  if (it.endDate) it.endDate = toStr(toNum(it.endDate) + toNum(s) - toNum(it.date)); // 기간 유지
  it.date = s;
  delete it.dayOrder; // 다른 날로 가면 그날 할 일 맨 아래로
  touch(it);
  save();
}

// ---------- 화면 상태 ----------
const $ = id => document.getElementById(id);
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// 다크 모드에서는 같은 색을 밝게 (--lift: 라이트 0%, 다크 35%) — 테마를 바꿔도 다시 그릴 필요 없음
const tone = c => `color-mix(in srgb, ${c}, #fff var(--lift))`;
const setColor = (e, cat) => { const c = catColor(cat); if (c) e.style.setProperty('--c', tone(c)); };

let selected = todayStr();
let view = { y: ymd(selected)[0], m: ymd(selected)[1] };

function select(s) {
  selected = s;
  const [y, m] = ymd(s);
  view = { y, m };
  render();
}
function shiftMonth(d) {
  let m = view.m + d, y = view.y;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  view = { y, m };
  render();
}

// ---------- 그리기 ----------
// 보기: calendar(일정) / board(보드) / table(눈금) — 보드·눈금은 views.js
function render() {
  const v = prefs.view || 'calendar';
  document.body.dataset.view = v;
  document.querySelectorAll('#viewSeg [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('scopeSeg').hidden = v !== 'calendar' || !db.categories.some(c => c.shared);
  document.querySelectorAll('#scopeSeg [data-show]').forEach(b => b.classList.toggle('on', b.dataset.show === scope()));
  renderSharedPick();
  if (v === 'board') return renderBoard();
  if (v === 'table') return renderTable();
  $('monthTitle').textContent = `${view.y}년 ${view.m}월`;
  renderGrid();
  renderDay();
  renderDday();
  renderTodo();
  renderCatPick($('dayCats'), prefs.cat || null, c => { prefs.cat = c; savePrefs(); render(); });
}

function dropTarget(e, s) {
  e.addEventListener('dragover', ev => { ev.preventDefault(); e.classList.add('drop'); });
  e.addEventListener('dragleave', () => e.classList.remove('drop'));
  e.addEventListener('drop', ev => {
    ev.preventDefault();
    e.classList.remove('drop');
    const [id, from] = ev.dataTransfer.getData('text/plain').split('|');
    const it = db.items.find(i => i.id === id);
    if (!it) return;
    if (!it.date) {
      // 할 일 목록에서 끌어온 경우: 날짜를 채운 편집 창을 열어 시간 입력 (취소하면 그대로)
      openEditor(it, s, s);
      form.time.focus();
    } else if (it.repeat) {
      // 반복 일정은 끌어온 그날 하나만 옮김
      if (from !== s) { detach(it, from).date = s; save(); }
    } else moveTo(id, s);
  });
}
let dragging = null; // 끄는 중인 { it, s } (dragover 중에는 dataTransfer를 못 읽어서)
function draggable(e, it, s) {
  e.draggable = true;
  e.addEventListener('dragstart', ev => { dragging = { it, s }; ev.dataTransfer.setData('text/plain', `${it.id}|${s || ''}`); });
  e.addEventListener('dragend', () => { dragging = null; });
}
// 할 일 it을 그날 target 앞/뒤로 놓고, 그날 할 일 순서를 0,1,2…로 다시 매김
function placeInDay(it, target, before, s) {
  const arr = itemsOn(s).filter(x => !x.time && !isSpan(x) && x !== it);
  arr.splice(arr.indexOf(target) + (before ? 0 : 1), 0, it);
  arr.forEach((x, k) => { if (x.dayOrder !== k) { x.dayOrder = k; touch(x); } });
  save();
}
function checkBox(it, s) {
  const box = h('span', 'box');
  box.addEventListener('click', ev => { ev.stopPropagation(); toggleDone(it, s); });
  return box;
}

// grid·v를 주면 다른 달을 다른 칸에 그림 (폰에서 밀 때 옆 달 미리 보기)
function renderGrid(grid = $('grid'), v = view) {
  const today = todayStr();
  const first = toNum(`${v.y}-${pad(v.m)}-01`);
  const start = first - weekday(first);
  const weeks = Math.ceil((weekday(first) + new Date(Date.UTC(v.y, v.m, 0)).getUTCDate()) / 7);
  // 폰: 제목을 줄바꿈해서 다 보여주고 칸이 내용만큼 늘어남 (줄 높이는 CSS grid-auto-rows)
  const phone = matchMedia('(max-width: 900px)').matches;
  grid.style.gridTemplateRows = phone ? '' : `repeat(${weeks}, minmax(0, 1fr))`;
  grid.replaceChildren();

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const s = toStr(start + i), [, m, d] = ymd(s), hol = HOLIDAYS[s];
    const cell = h('div', 'cell');
    cell.style.gridArea = `${Math.floor(i / 7) + 1} / ${i % 7 + 1}`; // 여러 날 막대를 같은 칸에 겹쳐 놓으려고 위치 고정
    if (m !== v.m) cell.classList.add('out');
    if (s === today) cell.classList.add('today');
    if (s === selected) cell.classList.add('sel');
    if (i % 7 === 0 || hol) cell.classList.add('sun'); else if (i % 7 === 6) cell.classList.add('sat');
    const hl = (db.dayColors || {})[s];
    if (hl) { cell.classList.add('hl'); cell.style.setProperty('--hl', tone(hl)); }

    const head = h('div', 'cell-head');
    head.append(h('span', 'num', d));
    if (hol) head.append(h('span', 'hol', hol));
    cell.append(head);

    cell.addEventListener('click', () => cellClick(s));
    dropTarget(cell, s);
    grid.append(cell);
    cells.push([cell, s]);
  }

  // 한 줄 높이는 실제로 재서 계산 → 칸에 들어가는 줄 수
  const [cell0] = cells[0], head = cell0.firstChild, probe = h('div', 'chip', '가');
  cell0.append(probe);
  const lineH = probe.offsetHeight + 2; // + 줄 간격
  probe.remove();
  const top = head.offsetTop + head.offsetHeight + 2;
  const room = phone ? Infinity : Math.max(1, Math.floor((cell0.clientHeight - top - 2) / lineH));

  // 여러 날 일정: 주(줄)마다 막대로 그리고, 겹치면 아래 줄로
  const spans = shown().filter(isSpan);
  for (let w = 0; w < weeks; w++) {
    const w0 = start + w * 7, w6 = w0 + 6, lanes = [], used = [0, 0, 0, 0, 0, 0, 0];
    spans.filter(it => toNum(it.date) <= w6 && toNum(it.endDate) >= w0)
      .sort((a, b) => a.date.localeCompare(b.date) || b.endDate.localeCompare(a.endDate))
      .forEach(it => {
        const from = Math.max(toNum(it.date), w0) - w0, to = Math.min(toNum(it.endDate), w6) - w0;
        let k = lanes.findIndex(end => end < from);
        if (k < 0) k = lanes.length;
        lanes[k] = to;
        for (let c = from; c <= to; c++) used[c] = Math.max(used[c], k + 1);
        grid.append(spanBar(it, w, from, to, top + k * lineH, toNum(it.date) < w0, toNum(it.endDate) > w6));
      });

    for (let c = 0; c < 7; c++) {
      const [cell, s] = cells[w * 7 + c];
      if (used[c]) {
        const space = h('div', 'span-space');
        space.style.height = `${used[c] * lineH - 2}px`;
        cell.append(space);
      }
      const items = itemsOn(s).filter(it => !isSpan(it));
      const free = Math.max(0, room - used[c]);
      const shown = items.length > free ? Math.max(0, free - 1) : free;
      for (const it of items.slice(0, shown)) cell.append(chip(it, s));
      if (items.length > shown) cell.append(h('div', 'more', `+${items.length - shown}개 더`));
    }
  }
}

// 날짜 칸: 한 번 클릭 = 선택, 두 번 클릭 = 새 일정 창
// (첫 클릭에 달력을 다시 그려서 브라우저 dblclick이 안 잡히므로 직접 판별)
let lastClick = { s: null, t: 0 };
function cellClick(s) {
  const now = Date.now();
  if (lastClick.s === s && now - lastClick.t < 400) {
    lastClick = { s: null, t: 0 };
    openEditor(newItem({ date: s, cat: prefs.cat || null }), s);
    return;
  }
  lastClick = { s, t: now };
  select(s);
}

// 시간 있음 = 일정 (색 배경 + 동그라미 체크 + 시간), 시간 없음 = 할 일 (네모 체크)
function chip(it, s) {
  const e = h('div', 'chip' + (it.time ? '' : ' task') + (isDone(it, s) ? ' done' : ''));
  setColor(e, viewCat(it));
  e.append(checkBox(it, s));
  if (it.time) e.append(h('span', 't', it.time));
  e.append(it.title);
  e.title = (it.time ? it.time + ' ' : '') + it.title;
  e.addEventListener('click', ev => { ev.stopPropagation(); openEditor(it, s); });
  draggable(e, it, s);
  if (!it.time) {
    // 같은 날 할 일끼리 끌면 순서 바꾸기 (그 밖의 끌기는 칸으로 넘겨서 날짜 옮기기)
    const side = ev => (ev.clientY < e.getBoundingClientRect().top + e.offsetHeight / 2 ? 'before' : 'after');
    const reorder = () => dragging && dragging.it !== it && !dragging.it.time && dragging.s === s;
    e.addEventListener('dragover', ev => {
      if (!reorder()) return;
      ev.preventDefault();
      ev.stopPropagation();
      e.classList.toggle('drop-before', side(ev) === 'before');
      e.classList.toggle('drop-after', side(ev) === 'after');
    });
    e.addEventListener('dragleave', () => e.classList.remove('drop-before', 'drop-after'));
    e.addEventListener('drop', ev => {
      // 다시 그리면서 dragend가 안 올 수 있어 dragging이 남아 있을 수 있음 → 놓은 데이터로 확인
      if (!reorder() || ev.dataTransfer.getData('text/plain').split('|')[0] !== dragging.it.id) return;
      ev.preventDefault();
      ev.stopPropagation();
      e.closest('.cell').classList.remove('drop');
      placeInDay(dragging.it, it, side(ev) === 'before', s);
    });
  }
  return e;
}

function spanBar(it, w, from, to, top, contLeft, contRight) {
  const e = h('div', 'span-bar' + (isDone(it) ? ' done' : '') + (contLeft ? ' cont-l' : '') + (contRight ? ' cont-r' : ''));
  e.style.gridArea = `${w + 1} / ${from + 1} / ${w + 2} / ${to + 2}`;
  e.style.marginTop = `${top}px`;
  setColor(e, viewCat(it));
  e.append(checkBox(it, it.date));
  if (it.time) e.append(h('span', 't', it.time));
  e.append(it.title);
  e.title = `${fmtMD(it.date)}~${fmtMD(it.endDate)} ${it.title}`;
  e.addEventListener('click', ev => { ev.stopPropagation(); openEditor(it, it.date); });
  draggable(e, it, it.date);
  return e;
}

function itemRow(it, s, extra) {
  const li = h('li', (it.time ? '' : 'task ') + (isDone(it, s) ? 'done' : ''));
  setColor(li, viewCat(it));
  const check = h('button', 'check');
  check.setAttribute('aria-label', '완료 표시');
  check.addEventListener('click', e => { e.stopPropagation(); toggleDone(it, s); });
  li.append(check);
  if (it.time) li.append(h('span', 'time', it.endTime ? `${it.time}–${it.endTime}` : it.time)); // 끝 시간은 목록에만 (달력 칸은 시작만)
  li.append(h('span', 'title', it.title));
  if (it.place) li.append(h('span', 'meta place', `📍 ${it.place}`));
  const p = clProgress(it);
  if (p) li.append(h('span', 'meta', `☑ ${p}`));
  if (byName(it)) li.append(h('span', 'meta', `👤 ${byName(it)}`));
  if (extra) li.append(extra);
  li.addEventListener('click', () => openEditor(it, s));
  return li;
}
const emptyRow = text => h('li', 'empty', text);

// 날짜 칠하기 (강조)
const DAY_COLORS = ['#FF5A5F', '#FF9F1C', '#FFD60A', '#34C759', '#3B82F6', '#A855F7'];
function setDayColor(s, color) {
  const m = { ...db.dayColors };
  if (color) m[s] = color; else delete m[s];
  db.dayColors = m;
  save();
}
function renderDayPalette() {
  const cur = (db.dayColors || {})[selected] || null;
  $('dayColorBtn').classList.toggle('on', !!cur);
  if (cur) $('dayColorBtn').style.setProperty('--hl', tone(cur));
  $('dayPalette').replaceChildren(...[null, ...DAY_COLORS].map(c => {
    const b = h('button', 'swatch' + (c ? '' : ' none') + (c === cur ? ' on' : ''));
    b.type = 'button';
    b.title = c ? '이 색으로 칠하기' : '칠하기 지우기';
    if (c) b.style.background = c;
    b.addEventListener('click', () => setDayColor(selected, c));
    return b;
  }));
}
$('dayColorBtn').addEventListener('click', () => { $('dayPalette').hidden = !$('dayPalette').hidden; });

function renderDay() {
  $('dayTitle').textContent = fmtDay(selected);
  $('dayHoliday').textContent = HOLIDAYS[selected] || '';
  renderDayPalette();
  const items = itemsOn(selected);
  const meta = it => it.repeat ? h('span', 'meta', it.repeat.lunar ? '음력 ↻' : '↻')
    : isSpan(it) ? h('span', 'meta', `${fmtMD(it.date)}~${fmtMD(it.endDate)}`) : null;
  $('dayList').replaceChildren(...(items.length
    ? items.map(it => itemRow(it, selected, meta(it)))
    : [emptyRow('일정이 없어요')]));
}

function renderDday() {
  const today = todayStr();
  const rows = shown().filter(i => i.dday && i.date)
    .map(it => ({ it, next: nextOccurrence(it, today) }))
    .filter(r => r.next)
    .sort((a, b) => a.next.localeCompare(b.next));
  $('ddayList').replaceChildren(...(rows.length ? rows.map(({ it, next }) => {
    const li = h('li');
    setColor(li, viewCat(it));
    const diff = toNum(next) - toNum(today);
    li.append(h('span', 'title', it.title), h('span', 'meta', fmtShort(next)), h('span', 'dd', diff ? `D-${diff}` : 'D-day'));
    li.addEventListener('click', () => openEditor(it, next));
    return li;
  }) : [emptyRow('일정 편집에서 D-day를 켜면 여기 나와요')]));
}

function renderTodo() {
  const items = shown().filter(i => !i.date).sort((a, b) => a.done - b.done || a.createdAt - b.createdAt);
  $('todoList').replaceChildren(...(items.length ? items.map(it => {
    const li = itemRow(it, null);
    draggable(li, it, null);
    return li;
  }) : [emptyRow('할 일이 없어요')]));
}

function renderCatPick(box, current, onPick) {
  const opts = [{ id: null, name: '없음', color: null }, ...db.categories];
  box.replaceChildren(...opts.map(c => {
    const b = h('button', 'cat-pill' + (c.id === current ? ' on' : '') + (c.shared ? ' shared' : ''), c.name);
    b.type = 'button';
    if (c.shared) b.title = '공유 캘린더 — 멤버 모두가 보고 고칠 수 있어요';
    if (c.color) b.style.setProperty('--c', tone(c.color));
    b.addEventListener('click', () => onPick(c.id));
    return b;
  }));
}

// ---------- 연·월 이동 ----------
let pickYear;
function renderPicker() {
  $('mpYear').textContent = `${pickYear}년`;
  const [ty, tm] = ymd(todayStr());
  $('mpGrid').replaceChildren(...Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const b = h('button', (pickYear === view.y && m === view.m ? 'on' : '') + (pickYear === ty && m === tm ? ' now' : ''), `${m}월`);
    b.addEventListener('click', () => { view = { y: pickYear, m }; $('monthPicker').hidePopover(); render(); });
    return b;
  }));
}
$('monthPicker').addEventListener('beforetoggle', e => {
  if (e.newState !== 'open') return;
  pickYear = view.y;
  renderPicker();
  const r = $('monthTitle').getBoundingClientRect();
  $('monthPicker').style.top = `${r.bottom + 6}px`;
  $('monthPicker').style.left = `${r.left + r.width / 2}px`;
});
$('mpPrev').addEventListener('click', () => { pickYear--; renderPicker(); });
$('mpNext').addEventListener('click', () => { pickYear++; renderPicker(); });

// ---------- 빠른 추가 ----------
$('dayAdd').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('dayInput').value.trim();
  if (!text) return;
  // '14:00 랩미팅' 또는 끝 시간까지 '14:00-15:00 랩미팅' (~ 도 됨)
  const t = text.match(/^(\d{1,2}:\d{2})(?:\s*[-~–]\s*(\d{1,2}:\d{2}))?\s+(.+)$/);
  const time = t && parseTime(t[1]), endTime = t && t[2] && parseTime(t[2]);
  db.items.push(newItem({
    title: time ? t[3] : text,
    time: time || null,
    endTime: time && endTime && endTime > time ? endTime : null,
    date: selected,
    cat: prefs.cat || null,
  }));
  $('dayInput').value = '';
  save();
});
$('todoAdd').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('todoInput').value.trim();
  if (!text) return;
  db.items.push(newItem({ title: text }));
  $('todoInput').value = '';
  save();
});

// ---------- 편집 창 ----------
const editor = $('editor'), form = $('editForm');
let editing = null, editingDate = null, editCat = null, editAlso = [], editBucket = null, editDays = [], editScope = 'all', editChecklist = [];
// 이미 저장된 반복 일정을 특정 날짜에서 연 경우 → '이 날만 / 모든 반복' 선택
const isSeriesEdit = () => !!(editing.repeat && editingDate && db.items.includes(editing));
// 저장된 반복 → 편집 창 '반복' 선택값 (분기·반기 = 3·6개월마다 같은 날짜)
const FIXED_MONTHS = { quarterly: 3, half: 6 };
function freqOf(r) {
  if (!r) return '';
  if (r.freq === 'monthly' && r.nth) return 'monthly-nth';
  if (r.freq === 'monthly' && r.interval === 3) return 'quarterly';
  if (r.freq === 'monthly' && r.interval === 6) return 'half';
  if (r.freq === 'yearly' && r.lunar) return 'yearly-lunar';
  return r.freq;
}

function openEditor(it, s, presetDate) {
  editing = it;
  editingDate = s;
  editCat = it.cat;
  editAlso = alsoOf(it);
  editBucket = it.bucket || null;
  const r = it.repeat;
  form.title.value = it.title;
  form.endDate.value = it.endDate || '';
  form.time.value = it.time || '';
  form.time.setCustomValidity('');
  form.endTime.value = it.endTime || '';
  form.endTime.setCustomValidity('');
  form.date.setCustomValidity('');
  form.freq.value = freqOf(r);
  form.interval.value = (r && r.interval) || 1;
  form.until.value = (r && r.until) || '';
  form.dday.checked = it.dday;
  form.place.value = it.place || '';
  syncMapLinks();
  form.note.value = it.note || '';
  editChecklist = (it.checklist || []).map(c => ({ ...c }));
  $('clInput').value = '';
  renderChecklist();
  editDays = (r && r.days) ? r.days.slice() : [];
  $('delBtn').hidden = !db.items.includes(it);
  $('scopeOneBtn').textContent = s ? `이 날만 (${fmtMD(s)})` : '이 날만';
  setScope(isSeriesEdit() ? 'one' : 'all', presetDate);
  editor.showModal();
}

// '이 날만'·'이후 모두'면 날짜 칸에 그날, '모든 반복'이면 반복 시작일
function setScope(scope, presetDate) {
  editScope = scope;
  form.date.value = presetDate || (scope === 'all' ? editing.date : editingDate) || '';
  syncEditor();
}
document.querySelectorAll('#scopeRow [data-scope]').forEach(b => b.addEventListener('click', () => setScope(b.dataset.scope)));

const editBuckets = () => (db.categories.find(c => c.id === editCat) || {}).buckets || [];
function syncEditor() {
  renderCatPick($('editCats'), editCat, c => { editCat = c; syncEditor(); });
  // 추가 카테고리: 대표 말고 내 카테고리 여러 개 켜고 끄기 (대표를 고른 뒤에만)
  const extra = editCat ? db.categories.filter(c => !c.shared && c.id !== editCat) : [];
  $('alsoRow').hidden = !extra.length;
  $('alsoHint').textContent = isSharedCat(editCat) ? '나에게만 보여요' : '';
  $('editAlso').replaceChildren(...extra.map(c => {
    const b = h('button', 'cat-pill' + (editAlso.includes(c.id) ? ' on' : ''), c.name);
    b.type = 'button';
    b.style.setProperty('--c', tone(c.color));
    b.addEventListener('click', () => {
      editAlso = editAlso.includes(c.id) ? editAlso.filter(x => x !== c.id) : [...editAlso, c.id];
      syncEditor();
    });
    return b;
  }));
  // 그룹: 고른 카테고리에 그룹이 있을 때만
  const bs = editBuckets();
  $('bucketRow').hidden = !bs.length;
  form.bucket.replaceChildren(...[{ id: '', name: '그룹 없음' }, ...bs].map(b => { const o = h('option', '', b.name); o.value = b.id; return o; }));
  form.bucket.value = bs.some(b => b.id === editBucket) ? editBucket : '';
  const series = isSeriesEdit(), one = series && editScope === 'one';
  const f = one ? '' : form.freq.value;
  $('scopeRow').hidden = !series;
  document.querySelectorAll('#scopeRow [data-scope]').forEach(b => b.classList.toggle('on', b.dataset.scope === editScope));
  $('freqRow').hidden = one;
  $('delBtn').textContent = !series ? '삭제' : one ? '이 날만 삭제' : editScope === 'after' ? '이후 모두 삭제' : '반복 전체 삭제';
  if (f === 'weekly' && !editDays.length && form.date.value) editDays = [weekday(toNum(form.date.value))];
  document.querySelectorAll('#editor .repeat-opt').forEach(e => { e.hidden = !f; });
  $('endDateWrap').hidden = !!f; // 며칠짜리 일정은 반복 없을 때만
  $('weekdayRow').hidden = f !== 'weekly';
  $('intervalUnit').textContent = { daily: '일', weekly: '주', monthly: '개월', 'monthly-nth': '개월', yearly: '년', 'yearly-lunar': '년' }[f] || '';
  $('intervalWrap').hidden = !f || !!FIXED_MONTHS[f]; // 분기·반기는 간격 고정
  // 날짜 옆 안내: 음력 날짜, 또는 분기·반기면 반복되는 달 (예: 1·4·7·10월 15일)
  let hint = '';
  if (form.date.value && f === 'yearly-lunar') {
    const lu = lunar(form.date.value);
    hint = `음력 ${lu.leap ? '윤' : ''}${lu.m}월 ${lu.d}일`;
  } else if (form.date.value && FIXED_MONTHS[f]) {
    const [, m, d] = ymd(form.date.value), step = FIXED_MONTHS[f];
    const months = Array.from({ length: 12 / step }, (_, k) => (m - 1 + k * step) % 12 + 1).sort((a, b) => a - b);
    hint = `${months.join('·')}월 ${d}일`;
  }
  $('repeatHint').textContent = hint;
  $('weekdayPick').replaceChildren(...WD.map((w, i) => {
    const b = h('button', editDays.includes(i) ? 'on' : '', w);
    b.type = 'button';
    b.addEventListener('click', () => {
      editDays = editDays.includes(i) ? editDays.filter(x => x !== i) : [...editDays, i].sort();
      syncEditor();
    });
    return b;
  }));
}
form.freq.addEventListener('change', syncEditor);
form.date.addEventListener('change', syncEditor);
form.date.addEventListener('input', () => form.date.setCustomValidity(''));
form.freq.addEventListener('change', () => form.date.setCustomValidity(''));
form.bucket.addEventListener('change', () => { editBucket = form.bucket.value || null; });

// 장소: 누르면 지도 사이트(폰은 지도 앱)에서 검색 — API 키 없이 링크만
const MAPS = {
  naver: q => `https://map.naver.com/p/search/${encodeURIComponent(q)}`,
  kakao: q => `https://map.kakao.com/link/search/${encodeURIComponent(q)}`,
  google: q => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
};
function syncMapLinks() {
  const q = form.place.value.trim();
  $('mapLinks').hidden = !q;
  $('mapLinks').querySelectorAll('a').forEach(a => { a.href = q ? MAPS[a.dataset.map](q) : ''; });
}
form.place.addEventListener('input', syncMapLinks);

// 체크리스트 (하위 항목) — 저장 버튼 누를 때 반영. 줄을 끌어서 순서 변경, 글자를 누르면 고치기
let clDragging = null; // 끌고 있는 항목
function renderChecklist() {
  const n = editChecklist.length;
  $('clCount').textContent = n ? `${editChecklist.filter(c => c.done).length}/${n}` : '';
  $('clList').replaceChildren(...editChecklist.map(c => {
    const li = h('li', c.done ? 'done' : '');
    li.draggable = true;
    const check = h('button', 'check');
    check.type = 'button';
    check.addEventListener('click', () => { c.done = !c.done; renderChecklist(); });
    const text = h('span', 'cl-text', c.text);
    text.title = '눌러서 고치기 · 끌어서 순서 바꾸기';
    text.addEventListener('click', () => {
      li.draggable = false;
      const input = h('input', 'cl-text');
      input.value = c.text;
      text.replaceWith(input);
      input.focus();
      let finished = false;
      const finish = () => { if (finished) return; finished = true; c.text = input.value.trim() || c.text; renderChecklist(); };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.value = c.text; input.blur(); }
      });
    });
    const del = h('button', 'icon-btn small', '✕');
    del.type = 'button';
    del.title = '항목 삭제';
    del.addEventListener('click', () => { editChecklist = editChecklist.filter(x => x !== c); renderChecklist(); });
    li.append(check, text, del);

    const side = e => (e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2 ? 'before' : 'after');
    li.addEventListener('dragstart', e => {
      clDragging = c;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ''); // 일부 브라우저는 데이터가 있어야 끌기 시작
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => { clDragging = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', e => {
      if (!clDragging || clDragging === c) return;
      e.preventDefault();
      li.classList.toggle('drop-before', side(e) === 'before');
      li.classList.toggle('drop-after', side(e) === 'after');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', e => {
      if (!clDragging || clDragging === c) return;
      e.preventDefault();
      const moving = clDragging, before = side(e) === 'before';
      editChecklist = editChecklist.filter(x => x !== moving);
      editChecklist.splice(editChecklist.indexOf(c) + (before ? 0 : 1), 0, moving);
      renderChecklist();
    });
    return li;
  }));
}
$('clInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return; // 한글 조합 중 Enter는 무시
  const text = e.target.value.trim();
  if (!text) return; // 비어 있으면 Enter = 저장
  e.preventDefault();
  editChecklist.push({ id: uid(), text, done: false });
  e.target.value = '';
  renderChecklist();
});

// 시간 칸 (시작·끝): 누르면 1시간 단위 목록, 직접 입력도 가능 (예: 14:15). near() = 비어 있을 때 목록을 보여줄 위치
function timeField(input, menu, near) {
  const show = () => {
    const values = ['', ...Array.from({ length: 24 }, (_, i) => `${pad(i)}:00`)];
    menu.replaceChildren(...values.map(v => {
      const b = h('button', v && v === input.value ? 'on' : '', v || '시간 없음');
      b.type = 'button';
      b.addEventListener('mousedown', e => e.preventDefault()); // 입력칸 포커스 유지
      b.addEventListener('click', () => { input.value = v; input.setCustomValidity(''); menu.hidden = true; });
      return b;
    }));
    menu.hidden = false;
    const t = parseTime(input.value);
    menu.scrollTop = menu.children[t ? 1 + +t.slice(0, 2) : near()].offsetTop - 40; // 입력된 시각 근처
  };
  input.addEventListener('focus', show);
  input.addEventListener('click', () => { if (menu.hidden) show(); });
  input.addEventListener('input', () => { input.setCustomValidity(''); menu.hidden = true; });
  input.addEventListener('blur', () => {
    menu.hidden = true;
    const t = parseTime(input.value);
    if (t) input.value = t;
  });
}
timeField(form.time, $('timeMenu'), () => 10); // 비어 있으면 09:00 근처
// 끝 시간: 비어 있으면 시작 1시간 뒤 근처
timeField(form.endTime, $('endTimeMenu'), () => { const t = parseTime(form.time.value); return t ? Math.min(24, 2 + +t.slice(0, 2)) : 10; });

form.addEventListener('submit', e => {
  e.preventDefault();
  const time = parseTime(form.time.value), endTime = parseTime(form.endTime.value);
  if (time === null || endTime === null) {
    const bad = time === null ? form.time : form.endTime;
    bad.setCustomValidity('시간은 9, 14:30, 1415 처럼 입력해 주세요');
    bad.reportValidity();
    return;
  }
  // 같은 날 끝나는데 끝 시간이 시작보다 앞 (여러 날 일정이면 끝나는 날의 시각이라 괜찮음)
  if (time && endTime && endTime <= time && !(form.endDate.value > form.date.value)) {
    form.endTime.setCustomValidity('끝나는 시간은 시작 시간보다 뒤로 해 주세요');
    form.endTime.reportValidity();
    return;
  }
  // 반복 일정: 이 날만 / 이후 모두 / 모든 반복 (첫 회차에서 '이후 모두' = 모든 반복)
  let scope = isSeriesEdit() ? editScope : 'all';
  if (scope === 'after' && editingDate === editing.date) scope = 'all';
  const one = scope === 'one';
  if (!one && form.freq.value && !form.date.value) {
    form.date.setCustomValidity('반복하려면 시작 날짜가 필요해요');
    form.date.reportValidity();
    return;
  }
  const it = one ? detach(editing, editingDate) : scope === 'after' ? splitSeries(editing, editingDate) : editing;
  const f = one ? '' : form.freq.value;
  it.title = form.title.value.trim();
  it.date = form.date.value || null;
  it.endDate = it.date && !f && form.endDate.value > it.date ? form.endDate.value : null;
  it.time = time || null;
  it.endTime = time && endTime ? endTime : null;
  it.cat = editCat;
  it.bucket = editBuckets().some(b => b.id === editBucket) ? editBucket : null;
  it.dday = form.dday.checked;
  it.place = form.place.value.trim();
  it.note = form.note.value;
  it.checklist = editChecklist.filter(c => c.text.trim());
  if (!f || !it.date) it.repeat = null;
  else {
    const freq = { 'monthly-nth': 'monthly', 'yearly-lunar': 'yearly', quarterly: 'monthly', half: 'monthly' }[f] || f;
    const interval = FIXED_MONTHS[f] || Math.max(1, +form.interval.value || 1);
    it.repeat = { freq, interval, until: form.until.value || null };
    if (f === 'monthly-nth') it.repeat.nth = true;
    if (f === 'yearly-lunar') it.repeat.lunar = true;
    if (f === 'weekly') it.repeat.days = editDays.length ? editDays : [weekday(toNum(it.date))];
  }
  touch(it);
  if (!db.items.includes(it)) db.items.push(it);
  const also = { ...db.also };
  delete also[it.id];
  if (it.cat) { const a = editAlso.filter(id => id !== it.cat && db.categories.some(c => c.id === id && !c.shared)); if (a.length) also[it.id] = a; }
  db.also = also;
  editor.close();
  save();
});
// PC: 카테고리·날짜 등을 누른 뒤에도 Enter = 저장 (메모 줄바꿈, 체크리스트에 쓴 글 추가, 아래 버튼·지도 링크는 그대로)
form.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented) return;
  const t = e.target;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'A' || t.closest('.dialog-actions')) return;
  e.preventDefault(); // 제목 칸 기본 제출과 겹치지 않게
  form.requestSubmit();
});
$('cancelBtn').addEventListener('click', () => editor.close());
// 삭제 표시 (보드 카드의 ✕도 같이 씀). 반복이면 확인 후 전부 — 취소하면 false
function removeItem(it) {
  if (it.repeat && !confirm(`'${it.title}' 반복 일정을 전부 삭제할까요?`)) return false;
  it.deleted = true;
  // 반복 전체 삭제 시 따로 옮겨 둔 날들도 같이 삭제
  db.items.forEach(i => { if (i.seriesId === it.id && !i.deleted) { i.deleted = true; touch(i); } });
  touch(it);
  return true;
}
$('delBtn').addEventListener('click', () => {
  const scope = isSeriesEdit() ? editScope : 'all';
  if (scope === 'one') { editing.skipDates.push(editingDate); touch(editing); }
  else if (scope === 'after' && editingDate !== editing.date) endSeries(editing, editingDate);
  else if (!removeItem(editing)) return;
  editor.close();
  save();
});
$('dayNewBtn').addEventListener('click', () => openEditor(newItem({ date: selected, cat: prefs.cat || null }), selected));

// ---------- 설정: 화면 ----------
const UI_DEFAULT = { num: 19, chip: 14, list: 15, col: 290 };
const ui = () => ({ ...UI_DEFAULT, ...prefs.ui });
function applyUI() {
  const u = ui(), s = document.documentElement.style;
  s.setProperty('--num-size', `${u.num}px`);
  s.setProperty('--chip-font', `${u.chip}px`);
  s.setProperty('--list-font', `${u.list}px`);
  s.setProperty('--col-w', `${u.col}px`);
}

// ---------- 달력 화면 패널 크기 (경계를 마우스로 끌기) ----------
// prefs.layout = { sideW: 오른쪽 패널 너비, dayPanel / ddayPanel: 패널 높이 } (없으면 기본 크기)
function applyLayout() {
  const l = prefs.layout || {};
  $('layout').style.setProperty('--side-w', l.sideW ? `${l.sideW}px` : '');
  for (const id of ['dayPanel', 'ddayPanel']) $(id).style.flexBasis = l[id] ? `${l[id]}px` : '';
}
function dragHandle(handle, onMove) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    const move = ev => { onMove(ev); applyLayout(); };
    const up = () => {
      handle.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      savePrefs();
      renderGrid();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
// 달력 ↔ 오른쪽 패널 너비
dragHandle($('sideSplit'), e => {
  const right = $('layout').getBoundingClientRect().right - 24; // 오른쪽 여백
  const max = Math.max(300, (right - 24) * 0.6);
  prefs.layout = { ...prefs.layout, sideW: Math.round(Math.min(Math.max(right - e.clientX - 8, 260), max)) };
});
// 일정 / D-day 패널 높이 (할 일 패널은 남은 공간)
document.querySelectorAll('.splitter.h').forEach(s => dragHandle(s, e => {
  const top = $(s.dataset.panel).getBoundingClientRect().top;
  prefs.layout = { ...prefs.layout, [s.dataset.panel]: Math.round(Math.max(e.clientY - top - 8, 90)) };
}));
$('resetLayoutBtn').addEventListener('click', () => {
  delete prefs.layout;
  savePrefs();
  applyLayout();
  renderGrid();
});
function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;
  // 폰 상단 상태바 색을 지금 배경색에 맞춤
  $('themeColor').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
function syncUIControls() {
  const u = ui();
  document.querySelectorAll('[data-ui]').forEach(inp => {
    inp.value = u[inp.dataset.ui];
    inp.nextElementSibling.textContent = `${u[inp.dataset.ui]}px`;
  });
  $('themeSelect').value = prefs.theme || '';
  $('swipeFxSelect').value = prefs.swipeFx === 'none' ? 'none' : 'carousel';
}
document.querySelectorAll('[data-ui]').forEach(inp => inp.addEventListener('input', () => {
  prefs.ui = { ...ui(), [inp.dataset.ui]: +inp.value };
  savePrefs();
  applyUI();
  syncUIControls();
  renderGrid();
}));
$('resetUIBtn').addEventListener('click', () => {
  delete prefs.ui;
  savePrefs();
  applyUI();
  syncUIControls();
  renderGrid();
});
$('themeSelect').addEventListener('change', e => {
  if (e.target.value) prefs.theme = e.target.value; else delete prefs.theme;
  savePrefs();
  applyTheme();
});
$('swipeFxSelect').addEventListener('change', e => { prefs.swipeFx = e.target.value; savePrefs(); });
$('themeBtn').addEventListener('click', () => {
  const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  prefs.theme = dark ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});

// ---------- 설정: 카테고리 ----------
// 카테고리 색 고르기용 파스텔 팔레트 (마지막 + 는 색 추가)
const PASTELS = [
  '#F4978E', '#F8B88B', '#F5D27A', '#C5D98F', '#9FCB8E', '#7FCFB8', '#84CDE0', '#8DB6F2',
  '#A7A3F2', '#B99AF0', '#DDA0E5', '#F3A6C8', '#D2AE8E', '#A88B73', '#9AA5B1', '#C7C1B8',
];
// + 를 누르면 나오는 추천 색 (파스텔보다 차분한 중간 톤)
const MORE_COLORS = ['#5E7A99', '#6E9A84', '#C2785E', '#C9A24D', '#9A7AA0'];
// 내 팔레트 = db.palette (+ 로 추가, 길게 눌러 삭제, 계정에 동기화). 손댄 적 없으면 기본 파스텔
const paletteColors = () => db.palette || PASTELS;
// 길게 누르기 (폰·마우스 모두): 0.5초 누르고 있으면 fn.
// 손을 뗄 때 따라오는 클릭은 무시 (fn이 다시 그려서 그 자리에 다른 버튼이 와 있어도). 새로 누르면 다시 보통 클릭
function onLongPress(el, fn) {
  let timer = null;
  el.addEventListener('pointerdown', () => {
    timer = setTimeout(() => {
      const eat = e => { e.stopPropagation(); e.preventDefault(); };
      addEventListener('click', eat, { capture: true, once: true });
      addEventListener('pointerdown', () => removeEventListener('click', eat, true), { capture: true, once: true });
      fn();
    }, 500);
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, () => clearTimeout(timer));
  el.addEventListener('contextmenu', e => e.preventDefault());
}
let paletteFor = null, membersFor = null; // 팔레트·멤버 목록을 펼친 카테고리 id
function renderCatEditor() {
  $('shareHint').hidden = !window.me;
  $('catEditor').replaceChildren(...db.categories.flatMap(c => {
    const row = h('div', 'cat-row');
    const color = h('button', 'cat-swatch');
    color.type = 'button';
    color.title = '색 바꾸기';
    color.style.background = c.color;
    color.addEventListener('click', () => { paletteFor = paletteFor === c.id ? null : c.id; renderCatEditor(); });
    const pick = col => { c.color = col; paletteFor = null; save(); renderCatEditor(); };
    const name = h('input');
    name.value = c.name;
    name.addEventListener('change', () => { c.name = name.value.trim() || c.name; save(); });
    row.append(color, name);
    // 공유: 로그인했을 때만. 공유 캘린더는 멤버 수 버튼으로 멤버 목록 펼치기
    if (c.shared) {
      const mem = h('button', 'btn small', `공유 ${c.shared.emails.length}명`);
      mem.addEventListener('click', () => { membersFor = membersFor === c.id ? null : c.id; renderCatEditor(); });
      row.append(mem);
    } else if (window.me) {
      const share = h('button', 'btn small', '공유');
      share.title = '다른 구글 계정과 같이 쓰는 캘린더로 바꾸기';
      share.addEventListener('click', () => shareCat(c));
      row.append(share);
    }
    const owner = c.shared && window.me?.uid === c.shared.owner;
    const del = h('button', 'icon-btn small', '✕');
    del.title = !c.shared ? '카테고리 삭제' : owner ? '공유 캘린더 삭제' : '공유 캘린더에서 나가기';
    del.addEventListener('click', () => {
      if (c.shared) return leaveCat(c, owner);
      if (!confirm(`'${c.name}' 카테고리를 삭제할까요? 이 카테고리의 일정은 색이 없어져요.`)) return;
      db.categories = db.categories.filter(x => x !== c);
      db.items.forEach(i => { if (i.cat === c.id) { i.cat = null; touch(i); } });
      save();
      renderCatEditor();
    });
    row.append(del);
    if (c.shared && membersFor === c.id) return [row, memberPanel(c, owner)];
    if (paletteFor !== c.id) return [row];

    const palette = h('div', 'cat-palette');
    for (const col of paletteColors()) {
      const b = h('button', 'swatch' + (col.toLowerCase() === c.color.toLowerCase() ? ' on' : ''));
      b.type = 'button';
      b.title = '길게 누르면 삭제';
      b.style.background = col;
      b.addEventListener('click', () => pick(col));
      onLongPress(b, () => {
        if (!confirm('이 색을 팔레트에서 삭제할까요?')) return;
        db.palette = paletteColors().filter(p => p !== col);
        save();
        renderCatEditor();
      });
      palette.append(b);
    }
    const custom = h('button', 'swatch custom', '+');
    custom.type = 'button';
    custom.title = '색 추가';
    palette.append(custom);

    // + : 추천 색 또는 색 코드 → 팔레트에 추가하고 이 카테고리에 바로 적용
    const addColor = col => {
      if (!paletteColors().some(p => p.toLowerCase() === col.toLowerCase())) db.palette = [...paletteColors(), col];
      pick(col);
    };
    const adder = h('form', 'color-add');
    adder.hidden = true;
    custom.addEventListener('click', () => { adder.hidden = !adder.hidden; });
    const examples = h('div');
    for (const col of MORE_COLORS) {
      const b = h('button', 'swatch');
      b.type = 'button';
      b.title = col;
      b.style.background = col;
      b.addEventListener('click', () => addColor(col));
      examples.append(b);
    }
    const preview = h('span', 'swatch none');
    const code = h('input');
    code.required = true;
    code.pattern = '#?[0-9A-Fa-f]{6}';
    code.title = '색 코드 6자리 (예: #6E9A84)';
    code.placeholder = '#6E9A84';
    code.maxLength = 7;
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.setAttribute('autocapitalize', 'off');
    code.enterKeyHint = 'done';
    const hex = () => (code.validity.valid ? '#' + code.value.replace('#', '').toUpperCase() : null);
    code.addEventListener('input', () => {
      preview.classList.toggle('none', !hex());
      preview.style.background = hex() || '';
    });
    const typed = h('div');
    typed.append(preview, code, h('button', 'btn small', '추가'));
    adder.append(examples, typed);
    adder.addEventListener('submit', ev => { ev.preventDefault(); addColor(hex()); });
    return [row, palette, adder];
  }));
}

// ---------- 설정: 공유 캘린더 (저장은 sync.js 의 window.sharing) ----------
// 멤버 = 구글 이메일. 초대·내보내기는 만든 사람만, 일정은 멤버 모두 고침
function memberPanel(c, owner) {
  const box = h('div', 'cat-members');
  for (const e of c.shared.emails) {
    const row = h('div', 'member');
    row.append(h('span', 'member-email', e));
    if (e === c.shared.ownerEmail) row.append(h('span', 'hint', '만든 사람'));
    else if (owner) {
      const x = h('button', 'icon-btn small', '✕');
      x.title = '내보내기';
      x.addEventListener('click', () => {
        if (!confirm(`${e} 님을 '${c.name}'에서 내보낼까요?`)) return;
        c.shared.emails = c.shared.emails.filter(y => y !== e);
        save();
        renderCatEditor();
      });
      row.append(x);
    }
    box.append(row);
  }
  if (owner) {
    const f = h('form', 'member-add');
    const input = h('input');
    input.type = 'email';
    input.required = true;
    input.placeholder = '초대할 구글 이메일';
    f.append(input, h('button', 'btn', '초대'));
    f.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = input.value.trim().toLowerCase();
      if (!c.shared.emails.includes(v)) c.shared.emails = [...c.shared.emails, v];
      save();
      renderCatEditor();
    });
    box.append(f);
  }
  box.append(h('p', 'hint', `초대한 사람이 ${location.origin}${location.pathname} 에서 그 구글 계정으로 로그인하면 이 카테고리가 생겨요. 멤버는 모두 일정을 보고 고칠 수 있어요.`));
  return box;
}
async function shareCat(c) {
  const n = live().filter(i => i.cat === c.id).length;
  if (!confirm(`'${c.name}' 카테고리를 공유 캘린더로 바꿀까요?\n이 카테고리의 일정 ${n}개를 초대한 사람도 보고 고칠 수 있게 돼요.`)) return;
  try { await window.sharing.share(c); } catch (e) { alert(`공유하지 못했어요: ${e.code || e.message}`); }
  renderCatEditor();
}
async function leaveCat(c, owner) {
  if (!window.me) { alert('로그인한 뒤에 할 수 있어요.'); return; }
  const n = live().filter(i => i.cat === c.id).length;
  if (!confirm(owner
    ? `'${c.name}' 공유 캘린더를 삭제할까요?\n모든 멤버에게서 이 캘린더의 일정 ${n}개가 사라져요. 남길 일정은 먼저 다른 카테고리로 옮겨 주세요.`
    : `'${c.name}' 공유 캘린더에서 나갈까요?\n이 캘린더의 일정 ${n}개가 내 화면에서 사라져요. (다른 멤버에게는 그대로 있어요)`)) return;
  try { await (owner ? window.sharing.remove(c) : window.sharing.leave(c)); } catch (e) { alert(`하지 못했어요: ${e.code || e.message}`); }
  renderCatEditor();
}
// 공유 캘린더 멤버 목록은 설정을 열 때마다 접힌 채로 ('공유 n명'을 눌러야 펼침)
$('settingsBtn').addEventListener('click', () => { membersFor = null; renderCatEditor(); syncUIControls(); $('settings').showModal(); });
$('closeSettingsBtn').addEventListener('click', () => $('settings').close());
$('addCatBtn').addEventListener('click', () => {
  // 아직 안 쓴 팔레트 색부터
  const used = db.categories.map(c => c.color.toLowerCase());
  const id = uid(), pal = paletteColors();
  db.categories.push({ id, name: '새 카테고리', color: pal.find(p => !used.includes(p.toLowerCase())) || pal[0] || PASTELS[0] });
  paletteFor = id;
  save();
  renderCatEditor();
});

// ---------- 설정: 백업 ----------
$('exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  // 동기화 상태(sync)는 이 기기 것이라 백업에서 빼기
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ ...db, sync: undefined })], { type: 'application/json' }));
  a.download = `planner-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
// .ics: 같은 일정(id)은 내용만 갱신하고, 이 앱에서 정한 카테고리·완료 표시는 유지
function importICS(text) {
  const { items, cancelled } = fromICS(text);
  const gone = db.items.filter(i => cancelled.includes(i.id) && !i.deleted);
  if (!items.length && !gone.length) { alert('불러올 일정이 없어요.'); return; }
  const lines = items.slice(0, 8).map(i => `· ${fmtShort(i.date)} ${i.time || ''} ${i.title}`);
  if (items.length > 8) lines.push(`… 외 ${items.length - 8}개`);
  if (gone.length) lines.push(...gone.map(i => `✕ 취소됨: ${i.title}`));
  if (!confirm(`${items.length ? `일정 ${items.length}개를 추가할까요?` : '취소된 일정을 지울까요?'}\n\n${lines.join('\n')}`)) return;
  for (const it of items) {
    const old = db.items.find(i => i.id === it.id);
    if (old) Object.assign(old, it, { cat: old.cat, done: old.done, doneDates: old.doneDates, createdAt: old.createdAt, deleted: false });
    else db.items.push(it);
    // 반복 중 하루만 바뀐 초대가 따로 온 경우: 이미 있는 반복에서 그날 빼기
    const m = it.id.match(/^(.*)-(\d{4}-\d{2}-\d{2})$/);
    const master = m && db.items.find(i => i.id === m[1] && i.repeat);
    if (master && !master.skipDates.includes(m[2])) { master.skipDates.push(m[2]); touch(master); }
  }
  for (const i of gone) { i.deleted = true; touch(i); }
  if (items.length) { prefs.view = 'calendar'; select(items[0].date); } // 달력에서 그 날짜로 이동
  save();
}

async function importFile(file) {
  const text = await file.text();
  if (/\.ics$/i.test(file.name) || text.trimStart().startsWith('BEGIN:VCALENDAR')) return importICS(text);
  let data;
  try { data = JSON.parse(text); } catch { alert('읽을 수 없는 파일이에요. (.json 백업, DesktopCal, .ics 파일만 돼요)'); return; }
  if (data.source === 'desktopcal') {
    // 다시 가져오면 이전에 가져온 DesktopCal 항목을 새것으로 교체
    const items = fromDesktopCal(data);
    db.items = db.items.filter(i => !i.id.startsWith('dc-')).concat(items);
    save();
    alert(`DesktopCal에서 ${items.length}개 항목을 가져왔어요.`);
  } else if (Array.isArray(data.items) && Array.isArray(data.categories)) {
    if (!confirm('지금 데이터를 백업 파일 내용으로 바꿀까요?')) return;
    data.owner = db.owner; // 로그인 중이면 지금 계정 데이터로 취급
    db = data;
    save();
  } else alert('알 수 없는 파일 형식이에요.');
}
$('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) { $('settings').close(); importFile(file); }
});
// 메일에서 받은 .ics 등을 화면 아무 데나 끌어다 놓아도 불러오기
addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  importFile(e.dataTransfer.files[0]);
});

// ---------- 시작 ----------
$('prevBtn').addEventListener('click', () => shiftMonth(-1));
$('nextBtn').addEventListener('click', () => shiftMonth(1));
// 폰: 달력을 왼쪽으로 밀면 다음 달, 오른쪽으로 밀면 이전 달 (세로 스크롤은 그대로)
// 옆 달이 붙어서 같이 밀림. 설정 > 화면 > 달 넘기기에서 끄면 바로 바뀜 (prefs.swipeFx = 'none', 기기별)
let swipe = null;
// el을 x만큼 ms 동안 옮김 (0이면 바로). 앞 위치를 먼저 적용해야 움직임이 보여서 offsetWidth로 확정
const slideTo = (el, x, ms) => new Promise(done => {
  el.offsetWidth;
  el.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
  el.style.transform = x ? `translateX(${x}px)` : '';
  ms ? setTimeout(done, ms) : done();
});
// 옆 달(d = -1 / 1)을 달력 옆에 미리 그려 둠
function peekMonth(d) {
  const g = $('grid'), p = h('div', 'grid peek'), t = new Date(Date.UTC(view.y, view.m - 1 + d, 1));
  Object.assign(p.style, { position: 'absolute', left: 0, right: 0, top: `${g.offsetTop}px`, transform: `translateX(${d * g.offsetWidth}px)` });
  if (g.style.gridTemplateRows) p.style.height = `${g.offsetHeight}px`;
  g.after(p);
  renderGrid(p, { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 });
  return p;
}
let swipeBusy = false; // 넘기는 움직임이 끝나기 전에는 새로 밀기 무시
$('grid').addEventListener('touchstart', e => {
  if (swipe) return endSwipe(true); // 두 번째 손가락이 닿으면 제자리로
  if (e.touches.length !== 1 || swipeBusy) return;
  const t = e.touches[0];
  swipe = { x: t.clientX, y: t.clientY, dx: 0, side: null, anim: prefs.swipeFx !== 'none' };
  // 손가락을 뗄 때까지의 이벤트는 처음 닿은 칸으로 옴 → 중간에 달력을 다시 그려 그 칸이 빠져도 받도록 칸에 직접 붙임
  const el = e.target;
  const stop = cancel => () => {
    el.removeEventListener('touchmove', moveSwipe);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', cancelled);
    endSwipe(cancel);
  };
  const end = stop(false), cancelled = stop(true);
  el.addEventListener('touchmove', moveSwipe, { passive: true });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', cancelled);
}, { passive: true });
function moveSwipe(e) {
  if (!swipe) return;
  const t = e.touches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  // 처음 10px 움직인 방향으로 가로 밀기인지 세로 스크롤인지 정함
  if (swipe.side === null && Math.hypot(dx, dy) > 10) {
    swipe.side = Math.abs(dx) > Math.abs(dy) * 1.5;
    if (swipe.side && swipe.anim) swipe.peek = { '-1': peekMonth(-1), 1: peekMonth(1) };
  }
  if (!swipe.side) return;
  swipe.dx = dx;
  if (!swipe.peek) return;
  const g = $('grid'), w = g.offsetWidth;
  slideTo(g, dx, 0);
  for (const d of [-1, 1]) slideTo(swipe.peek[d], d * w + dx, 0);
}
const endSwipe = async cancel => {
  if (!swipe) return;
  const { dx, side, peek } = swipe;
  swipe = null;
  if (!side) return;
  swipeBusy = true;
  try { await finishSwipe(dx, peek, cancel); } finally { swipeBusy = false; }
};
async function finishSwipe(dx, peek, cancel) {
  const g = $('grid'), w = g.offsetWidth, go = !cancel && Math.abs(dx) >= 60, d = dx < 0 ? 1 : -1;
  if (!peek) { if (go) shiftMonth(d); return; } // 효과 끔
  // 옆 달이 마저 들어오거나(넘김), 조금만 밀었거나 끊기면 제자리로
  const ms = go ? 160 : 140, shift = go ? -d * w : 0;
  slideTo(peek[-1], -w + shift, ms);
  slideTo(peek[1], w + shift, ms);
  await slideTo(g, shift, ms);
  if (go) shiftMonth(d);
  slideTo(g, 0, 0);
  peek[-1].remove();
  peek[1].remove();
}
$('todayBtn').addEventListener('click', () => select(todayStr()));
// 공유 보기: 공유 캘린더가 둘 이상이면 캘린더마다 켜고 끄기 (예: 랩 / 가족)
function renderSharedPick() {
  const cats = db.categories.filter(c => c.shared), off = prefs.hideShared || [];
  $('sharedPick').hidden = $('scopeSeg').hidden || scope() !== 'shared' || cats.length < 2;
  if ($('sharedPick').hidden) return;
  $('sharedPick').replaceChildren(...cats.map(c => {
    const b = h('button', 'cat-pill' + (off.includes(c.id) ? '' : ' on'), c.name);
    b.type = 'button';
    b.title = off.includes(c.id) ? '눌러서 보이기' : '눌러서 숨기기';
    b.style.setProperty('--c', tone(c.color));
    b.addEventListener('click', () => {
      const cur = prefs.hideShared || [];
      prefs.hideShared = cur.includes(c.id) ? cur.filter(x => x !== c.id) : [...cur, c.id];
      savePrefs();
      render();
    });
    return b;
  }));
}
document.querySelectorAll('#scopeSeg [data-show]').forEach(b => b.addEventListener('click', () => {
  prefs.scope = b.dataset.show;
  savePrefs();
  render();
}));
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderGrid, 150); });

// ---------- 폰: 뒤로 가기 ----------
// 기록을 한 칸 더 쌓아 두고, 뒤로 가기로 그 칸이 빠지면(popstate) 앱 안에서 처리한 뒤 다시 쌓음.
// 닫을 게 없으면 안내만 띄우고 2초 동안 안 쌓음 → 그사이 또 뒤로 가면 앱이 닫힘.
// (크롬 계열은 화면을 한 번도 안 누른 채 쌓은 칸을 건너뛰어서, 열자마자 뒤로 가면 예전처럼 바로 닫힘)
if (matchMedia('(max-width: 900px)').matches) {
  const guard = () => history.pushState({ guard: true }, '');
  if (!history.state?.guard) guard();
  let exitTimer = null;
  const rearm = () => { clearTimeout(exitTimer); exitTimer = null; $('toast').classList.remove('show'); guard(); };
  addEventListener('pointerdown', () => { if (exitTimer) rearm(); }); // 안내 중에 화면을 누르면 바로 다시 쌓기
  addEventListener('popstate', () => {
    const dlg = document.querySelector('dialog[open]'), pop = document.querySelector(':popover-open');
    if (dlg) dlg.close();
    else if (pop) pop.hidePopover();
    else if (!$('searchResults').hidden) $('searchInput').blur();
    else if (!$('dayPalette').hidden) $('dayPalette').hidden = true;
    else if ((prefs.view || 'calendar') !== 'calendar') { prefs.view = 'calendar'; savePrefs(); render(); }
    else {
      $('toast').classList.add('show');
      exitTimer = setTimeout(rearm, 2000);
      return;
    }
    guard();
  });
}

applyTheme();
applyUI();
applyLayout();
addEventListener('DOMContentLoaded', () => dbReady.then(render)); // views.js 까지 읽고, 저장된 일정도 읽은 뒤 그리기

// 앱 설치(PWA)·오프라인용. 파일을 더블클릭해서 연 경우(file://)엔 동작 안 함
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
