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
let db = readJSON(KEY) || { version: 1, categories: DEFAULT_CATS, items: [] };
let prefs = readJSON(PKEY) || {};
const savePrefs = () => localStorage.setItem(PKEY, JSON.stringify(prefs));
const persist = () => localStorage.setItem(KEY, JSON.stringify(db));
// 변경 저장 → 다시 그리기 → (로그인돼 있으면) sync.js가 계정에 올림
function save() { persist(); render(); if (window.onSave) window.onSave(); }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function newItem(fields) {
  const t = Date.now();
  return {
    id: uid(), title: '', date: null, endDate: null, time: null, cat: null, note: '', done: false, dday: false,
    repeat: null, doneDates: [], skipDates: [], createdAt: t, updatedAt: t, ...fields,
  };
}
const touch = it => { it.updatedAt = Date.now(); };
// 삭제는 표시만 해둠 (나중에 기기 간 동기화할 때 삭제도 전달하려고)
const live = () => db.items.filter(i => !i.deleted);
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || a.createdAt - b.createdAt;
const itemsOn = s => live().filter(i => occursOn(i, s)).sort(byTime);
const catColor = id => (db.categories.find(c => c.id === id) || {}).color || null;
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
    title: series.title, date: s, time: series.time, cat: series.cat, note: series.note,
    done: series.doneDates.includes(s), seriesId: series.id,
  });
  db.items.push(copy);
  return copy;
}
function moveTo(id, s) {
  const it = db.items.find(i => i.id === id);
  if (!it || it.repeat || it.date === s) return;
  if (it.endDate) it.endDate = toStr(toNum(it.endDate) + toNum(s) - toNum(it.date)); // 기간 유지
  it.date = s;
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
const setColor = (e, cat) => { const c = catColor(cat); if (c) e.style.setProperty('--c', c); };

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
function draggable(e, it, s) {
  e.draggable = true;
  e.addEventListener('dragstart', ev => ev.dataTransfer.setData('text/plain', `${it.id}|${s || ''}`));
}
function checkBox(it, s) {
  const box = h('span', 'box');
  box.addEventListener('click', ev => { ev.stopPropagation(); toggleDone(it, s); });
  return box;
}

function renderGrid() {
  const grid = $('grid'), today = todayStr();
  const first = toNum(`${view.y}-${pad(view.m)}-01`);
  const start = first - weekday(first);
  const weeks = Math.ceil((weekday(first) + new Date(Date.UTC(view.y, view.m, 0)).getUTCDate()) / 7);
  grid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;
  grid.replaceChildren();

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const s = toStr(start + i), [, m, d] = ymd(s), hol = HOLIDAYS[s];
    const cell = h('div', 'cell');
    cell.style.gridArea = `${Math.floor(i / 7) + 1} / ${i % 7 + 1}`; // 여러 날 막대를 같은 칸에 겹쳐 놓으려고 위치 고정
    if (m !== view.m) cell.classList.add('out');
    if (s === today) cell.classList.add('today');
    if (s === selected) cell.classList.add('sel');
    if (i % 7 === 0 || hol) cell.classList.add('sun'); else if (i % 7 === 6) cell.classList.add('sat');
    const hl = (db.dayColors || {})[s];
    if (hl) { cell.classList.add('hl'); cell.style.setProperty('--hl', hl); }

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
  const room = Math.max(1, Math.floor((cell0.clientHeight - top - 2) / lineH));

  // 여러 날 일정: 주(줄)마다 막대로 그리고, 겹치면 아래 줄로
  const spans = live().filter(isSpan);
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
  setColor(e, it.cat);
  e.append(checkBox(it, s));
  if (it.time) e.append(h('span', 't', it.time));
  e.append(it.title);
  e.title = (it.time ? it.time + ' ' : '') + it.title;
  e.addEventListener('click', ev => { ev.stopPropagation(); openEditor(it, s); });
  draggable(e, it, s);
  return e;
}

function spanBar(it, w, from, to, top, contLeft, contRight) {
  const e = h('div', 'span-bar' + (isDone(it) ? ' done' : '') + (contLeft ? ' cont-l' : '') + (contRight ? ' cont-r' : ''));
  e.style.gridArea = `${w + 1} / ${from + 1} / ${w + 2} / ${to + 2}`;
  e.style.marginTop = `${top}px`;
  setColor(e, it.cat);
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
  setColor(li, it.cat);
  const check = h('button', 'check');
  check.setAttribute('aria-label', '완료 표시');
  check.addEventListener('click', e => { e.stopPropagation(); toggleDone(it, s); });
  li.append(check);
  if (it.time) li.append(h('span', 'time', it.time));
  li.append(h('span', 'title', it.title));
  const p = clProgress(it);
  if (p) li.append(h('span', 'meta', `☑ ${p}`));
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
  if (cur) $('dayColorBtn').style.setProperty('--hl', cur);
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
  const rows = live().filter(i => i.dday && i.date)
    .map(it => ({ it, next: nextOccurrence(it, today) }))
    .filter(r => r.next)
    .sort((a, b) => a.next.localeCompare(b.next));
  $('ddayList').replaceChildren(...(rows.length ? rows.map(({ it, next }) => {
    const li = h('li');
    setColor(li, it.cat);
    const diff = toNum(next) - toNum(today);
    li.append(h('span', 'title', it.title), h('span', 'meta', fmtShort(next)), h('span', 'dd', diff ? `D-${diff}` : 'D-day'));
    li.addEventListener('click', () => openEditor(it, next));
    return li;
  }) : [emptyRow('일정 편집에서 D-day를 켜면 여기 나와요')]));
}

function renderTodo() {
  const items = live().filter(i => !i.date).sort((a, b) => a.done - b.done || a.createdAt - b.createdAt);
  $('todoList').replaceChildren(...(items.length ? items.map(it => {
    const li = itemRow(it, null);
    draggable(li, it, null);
    return li;
  }) : [emptyRow('할 일이 없어요')]));
}

function renderCatPick(box, current, onPick) {
  const opts = [{ id: null, name: '없음', color: null }, ...db.categories];
  box.replaceChildren(...opts.map(c => {
    const b = h('button', 'cat-pill' + (c.id === current ? ' on' : ''), c.name);
    b.type = 'button';
    if (c.color) b.style.setProperty('--c', c.color);
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
  const t = text.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
  db.items.push(newItem({
    title: t ? t[3] : text,
    time: t ? `${pad(t[1])}:${t[2]}` : null,
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
let editing = null, editingDate = null, editCat = null, editBucket = null, editDays = [], editScope = 'all', editChecklist = [];
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
  editBucket = it.bucket || null;
  const r = it.repeat;
  form.title.value = it.title;
  form.endDate.value = it.endDate || '';
  form.time.value = it.time || '';
  form.time.setCustomValidity('');
  form.date.setCustomValidity('');
  form.freq.value = freqOf(r);
  form.interval.value = (r && r.interval) || 1;
  form.until.value = (r && r.until) || '';
  form.dday.checked = it.dday;
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

// '이 날만'이면 날짜 칸에 그날, '모든 반복'이면 반복 시작일
function setScope(scope, presetDate) {
  editScope = scope;
  form.date.value = presetDate || (scope === 'one' ? editingDate : editing.date) || '';
  syncEditor();
}
document.querySelectorAll('#scopeRow [data-scope]').forEach(b => b.addEventListener('click', () => setScope(b.dataset.scope)));

const editBuckets = () => (db.categories.find(c => c.id === editCat) || {}).buckets || [];
function syncEditor() {
  renderCatPick($('editCats'), editCat, c => { editCat = c; syncEditor(); });
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
  $('delBtn').textContent = !series ? '삭제' : one ? '이 날만 삭제' : '반복 전체 삭제';
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
  e.preventDefault();
  const text = e.target.value.trim();
  if (!text) return;
  editChecklist.push({ id: uid(), text, done: false });
  e.target.value = '';
  renderChecklist();
});

// 시간 칸: 누르면 1시간 단위 목록, 직접 입력도 가능 (예: 14:15)
const timeMenu = $('timeMenu');
function showTimeMenu() {
  const values = ['', ...Array.from({ length: 24 }, (_, i) => `${pad(i)}:00`)];
  timeMenu.replaceChildren(...values.map(v => {
    const b = h('button', v && v === form.time.value ? 'on' : '', v || '시간 없음');
    b.type = 'button';
    b.addEventListener('mousedown', e => e.preventDefault()); // 입력칸 포커스 유지
    b.addEventListener('click', () => { form.time.value = v; form.time.setCustomValidity(''); timeMenu.hidden = true; });
    return b;
  }));
  timeMenu.hidden = false;
  const t = parseTime(form.time.value);
  timeMenu.scrollTop = timeMenu.children[t ? 1 + +t.slice(0, 2) : 10].offsetTop - 40; // 입력된 시각 근처, 없으면 09:00
}
form.time.addEventListener('focus', showTimeMenu);
form.time.addEventListener('click', () => { if (timeMenu.hidden) showTimeMenu(); });
form.time.addEventListener('input', () => { form.time.setCustomValidity(''); timeMenu.hidden = true; });
form.time.addEventListener('blur', () => {
  timeMenu.hidden = true;
  const t = parseTime(form.time.value);
  if (t) form.time.value = t;
});

form.addEventListener('submit', e => {
  e.preventDefault();
  const time = parseTime(form.time.value);
  if (time === null) {
    form.time.setCustomValidity('시간은 9, 14:30, 1415 처럼 입력해 주세요');
    form.time.reportValidity();
    return;
  }
  const one = isSeriesEdit() && editScope === 'one';
  if (!one && form.freq.value && !form.date.value) {
    form.date.setCustomValidity('반복하려면 시작 날짜가 필요해요');
    form.date.reportValidity();
    return;
  }
  const it = one ? detach(editing, editingDate) : editing, f = one ? '' : form.freq.value;
  it.title = form.title.value.trim();
  it.date = form.date.value || null;
  it.endDate = it.date && !f && form.endDate.value > it.date ? form.endDate.value : null;
  it.time = time || null;
  it.cat = editCat;
  it.bucket = editBuckets().some(b => b.id === editBucket) ? editBucket : null;
  it.dday = form.dday.checked;
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
  editor.close();
  save();
});
$('cancelBtn').addEventListener('click', () => editor.close());
$('delBtn').addEventListener('click', () => {
  if (isSeriesEdit() && editScope === 'one') editing.skipDates.push(editingDate);
  else {
    if (editing.repeat && !confirm(`'${editing.title}' 반복 일정을 전부 삭제할까요?`)) return;
    editing.deleted = true;
    // 반복 전체 삭제 시 따로 옮겨 둔 날들도 같이 삭제
    db.items.forEach(i => { if (i.seriesId === editing.id && !i.deleted) { i.deleted = true; touch(i); } });
  }
  touch(editing);
  editor.close();
  save();
});
$('dayNewBtn').addEventListener('click', () => openEditor(newItem({ date: selected, cat: prefs.cat || null }), selected));

// ---------- 설정: 화면 ----------
const UI_DEFAULT = { num: 19, chip: 14, list: 15 };
const ui = () => ({ ...UI_DEFAULT, ...prefs.ui });
function applyUI() {
  const u = ui(), s = document.documentElement.style;
  s.setProperty('--num-size', `${u.num}px`);
  s.setProperty('--chip-font', `${u.chip}px`);
  s.setProperty('--list-font', `${u.list}px`);
}
function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;
}
function syncUIControls() {
  const u = ui();
  document.querySelectorAll('[data-ui]').forEach(inp => {
    inp.value = u[inp.dataset.ui];
    inp.nextElementSibling.textContent = `${u[inp.dataset.ui]}px`;
  });
  $('themeSelect').value = prefs.theme || '';
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
$('themeBtn').addEventListener('click', () => {
  const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  prefs.theme = dark ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});

// ---------- 설정: 카테고리 ----------
function renderCatEditor() {
  $('catEditor').replaceChildren(...db.categories.map(c => {
    const row = h('div', 'cat-row');
    const color = h('input');
    color.type = 'color';
    color.value = c.color;
    color.addEventListener('input', () => { c.color = color.value; save(); });
    const name = h('input');
    name.value = c.name;
    name.addEventListener('change', () => { c.name = name.value.trim() || c.name; save(); });
    const del = h('button', 'icon-btn small', '✕');
    del.title = '카테고리 삭제';
    del.addEventListener('click', () => {
      if (!confirm(`'${c.name}' 카테고리를 삭제할까요? 이 카테고리의 일정은 색이 없어져요.`)) return;
      db.categories = db.categories.filter(x => x !== c);
      db.items.forEach(i => { if (i.cat === c.id) { i.cat = null; touch(i); } });
      save();
      renderCatEditor();
    });
    row.append(color, name, del);
    return row;
  }));
}
$('settingsBtn').addEventListener('click', () => { renderCatEditor(); syncUIControls(); $('settings').showModal(); });
$('closeSettingsBtn').addEventListener('click', () => $('settings').close());
$('addCatBtn').addEventListener('click', () => {
  db.categories.push({ id: uid(), name: '새 카테고리', color: '#7C8CF8' });
  save();
  renderCatEditor();
});

// ---------- 설정: 백업 ----------
$('exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db)], { type: 'application/json' }));
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
$('todayBtn').addEventListener('click', () => select(todayStr()));
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderGrid, 150); });

applyTheme();
applyUI();
addEventListener('DOMContentLoaded', render); // views.js 까지 읽은 뒤 그리기

// 앱 설치(PWA)·오프라인용. 파일을 더블클릭해서 연 경우(file://)엔 동작 안 함
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
