'use strict';
// 루틴: 습관을 루틴(아침·출근길 같은 묶음)으로 나눠 날마다 체크. (app.js 의 함수·데이터를 사용)
// 습관 = 일정 항목 + routine(루틴 id). 반복(매일 또는 요일)과 날짜별 체크(doneDates)는 반복 일정과 같음 → 동기화·백업도 그대로.
// 시작일(date) 전은 '해야 하는 날'로 안 침. 습관은 달력·보드·목록·검색엔 안 나옴 (app.js assigned, search.js)
// 루틴은 db.routines = [{ id, name, cue(언제: '눈 뜨면' 등), color }] — 배열 순서 = 화면 순서. 루틴 안 순서는 item.order
const HABIT_DRAG = 'application/x-planner-habit', ROUTINE_DRAG = 'application/x-planner-routine';
const habits = () => db.items.filter(it => it.routine && !it.deleted);
const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.createdAt - b.createdAt;
const habitsIn = rid => habits().filter(it => it.routine === rid).sort(byOrder);
const routineById = id => (db.routines || []).find(g => g.id === id);
let routineDay = todayStr(); // 보고 있는 날 (기기별, 저장 안 함)
let routineFocus = null; // 습관 추가 후 다시 커서 줄 루틴 id

// 🔥 연속: 오늘부터 거꾸로, 해야 하는 날만 세다가 안 한 날에서 멈춤 (오늘 아직 안 한 건 끊긴 게 아님)
function streak(it) {
  const done = new Set(it.doneDates), today = toNum(todayStr());
  let n = 0;
  for (let b = today; b >= toNum(it.date); b--) {
    const s = toStr(b);
    if (!occursOn(it, s)) continue;
    if (done.has(s)) n++;
    else if (b < today) break;
  }
  return n;
}

// 끌어서 순서 바꾸기: 놓는 곳의 위·아래 반쪽에 따라 앞·뒤
function sortable(e, type, onDrop) {
  const before = ev => ev.clientY < e.getBoundingClientRect().top + e.offsetHeight / 2;
  e.addEventListener('dragover', ev => {
    if (!ev.dataTransfer.types.includes(type)) return;
    ev.preventDefault();
    ev.stopPropagation();
    e.classList.toggle('drop-before', before(ev));
    e.classList.toggle('drop-after', !before(ev));
  });
  e.addEventListener('dragleave', () => e.classList.remove('drop-before', 'drop-after'));
  e.addEventListener('drop', ev => {
    if (!ev.dataTransfer.types.includes(type)) return;
    ev.preventDefault();
    ev.stopPropagation();
    e.classList.remove('drop-before', 'drop-after');
    onDrop(ev.dataTransfer.getData(type), before(ev));
  });
}
// 습관을 루틴 rid의 target 앞/뒤(target 없으면 맨 뒤)로, 그 루틴 순서를 0,1,2…로 다시 매김
function placeHabit(id, rid, target, before) {
  const it = db.items.find(i => i.id === id);
  if (!it || it === target) return;
  const list = habitsIn(rid).filter(x => x !== it);
  list.splice(target ? list.indexOf(target) + (before ? 0 : 1) : list.length, 0, it);
  it.routine = rid;
  list.forEach((x, k) => { if (x.order !== k) { x.order = k; touch(x); } });
  touch(it);
  save();
}
function moveRoutine(id, target, before) {
  const list = db.routines || [], g = routineById(id);
  if (!g || g === target) return;
  const rest = list.filter(x => x !== g);
  rest.splice(rest.indexOf(target) + (before ? 0 : 1), 0, g);
  db.routines = rest;
  save();
}

// ---------- 그리기 ----------
// 기록 / 통계 (prefs.routineTab, 기기별) — 위의 한 주는 둘 다
function renderRoutine() {
  renderWeek();
  const stats = prefs.routineTab === 'stats';
  document.querySelectorAll('#routineSeg [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === (stats ? 'stats' : '')));
  $('routineList').hidden = $('addRoutineBtn').hidden = stats;
  $('routineStats').hidden = !stats;
  if (stats) return renderStats();
  const groups = db.routines || [];
  // 루틴이 없어진 습관 (예: 다른 기기에서 루틴을 받기 전) → 안 보이게 두지 않고 '루틴 없음'에
  const loose = habits().filter(it => !routineById(it.routine)).sort(byOrder);
  const cards = groups.map(g => routineCard(g, habitsIn(g.id)));
  if (loose.length) cards.push(routineCard(null, loose));
  if (!cards.length) cards.push(h('p', 'hint', '아침·출근길처럼 루틴을 만들고, 그 안에 날마다 할 습관을 넣어 보세요.'));
  $('routineList').replaceChildren(...cards);
  if (routineFocus) {
    $('routineList').querySelector(`[data-rid="${routineFocus}"] .add-input`)?.focus();
    routineFocus = null;
  }
}

// 위쪽 한 주 (일~토): 동그라미 둘레 = 그날 한 비율, 다 하면 꽉 참. 누르면 그날 기록 보기·고치기
function renderWeek() {
  const today = todayStr(), sel = toNum(routineDay), start = sel - weekday(sel), all = habits();
  $('routineDate').textContent = fmtDay(routineDay);
  $('routineToday').hidden = routineDay === today;
  $('weekStrip').replaceChildren(...WD.map((w, k) => {
    const s = toStr(start + k), due = all.filter(it => occursOn(it, s)), n = due.filter(it => it.doneDates.includes(s)).length;
    const b = h('button', 'wday' + (s === routineDay ? ' sel' : '') + (s === today ? ' today' : '') + (s > today ? ' future' : '')
      + (due.length && n === due.length ? ' full' : ''));
    b.type = 'button';
    b.style.setProperty('--p', `${due.length ? (n / due.length) * 100 : 0}%`);
    if (due.length) b.title = `${n}/${due.length}`;
    const ring = h('span', 'ring');
    ring.append(h('span', '', ymd(s)[2]));
    b.append(h('span', 'wd', w), ring);
    b.addEventListener('click', () => { routineDay = s; renderRoutine(); });
    return b;
  }));
}
document.querySelectorAll('#routineSeg [data-tab]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tab) prefs.routineTab = b.dataset.tab; else delete prefs.routineTab;
  savePrefs();
  renderRoutine();
}));
const shiftRoutineDay = d => { routineDay = toStr(toNum(routineDay) + d); renderRoutine(); };
$('routinePrev').addEventListener('click', () => shiftRoutineDay(-7));
$('routineNext').addEventListener('click', () => shiftRoutineDay(7));
$('routineToday').addEventListener('click', () => { routineDay = todayStr(); renderRoutine(); });

// g = 루틴 (null이면 '루틴 없음'). 그날 할 습관 먼저(정한 순서), 쉬는 날인 습관은 흐리게 아래로
function routineCard(g, list) {
  const s = routineDay;
  const card = h('section', 'panel routine');
  if (g) {
    card.dataset.rid = g.id;
    card.style.setProperty('--c', tone(g.color));
  }
  const due = list.filter(it => occursOn(it, s));
  const head = h('div', 'panel-head');
  head.append(h('h2', '', g ? g.name : '루틴 없음'));
  if (g?.cue) head.append(h('span', 'hint', g.cue));
  head.append(h('span', 'count', due.length ? `${due.filter(it => it.doneDates.includes(s)).length}/${due.length}` : ''));
  const ul = h('ul', 'list');
  const rows = [...due, ...list.filter(it => !due.includes(it))].map(it => habitRow(it, s, g));
  ul.append(...(rows.length ? rows : [emptyRow('아래에 습관을 추가해 보세요')]));
  card.append(head, ul);
  if (!g) return card;

  const edit = h('button', 'icon-btn small', '✎');
  edit.title = '루틴 고치기';
  edit.addEventListener('click', () => openRoutine(g));
  head.append(edit);
  head.draggable = true;
  head.title = '끌어서 루틴 순서 바꾸기';
  head.addEventListener('dragstart', ev => { ev.dataTransfer.setData(ROUTINE_DRAG, g.id); card.classList.add('dragging'); });
  head.addEventListener('dragend', () => card.classList.remove('dragging'));
  sortable(card, ROUTINE_DRAG, (id, before) => moveRoutine(id, g, before));
  // 습관을 카드의 빈 곳에 놓으면 이 루틴 맨 뒤로
  card.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes(HABIT_DRAG)) { ev.preventDefault(); card.classList.add('drop'); } });
  card.addEventListener('dragleave', ev => { if (!card.contains(ev.relatedTarget)) card.classList.remove('drop'); });
  card.addEventListener('drop', ev => {
    card.classList.remove('drop');
    if (!ev.dataTransfer.types.includes(HABIT_DRAG)) return;
    ev.preventDefault();
    placeHabit(ev.dataTransfer.getData(HABIT_DRAG), g.id, null);
  });

  const add = h('form');
  const input = h('input', 'add-input');
  input.placeholder = '+ 습관 추가';
  input.autocomplete = 'off';
  add.append(input);
  add.addEventListener('submit', e => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    // 지난 날을 보면서 추가하면 그날부터 (기록을 바로 남길 수 있게)
    const today = todayStr();
    db.items.push(newItem({ title, date: s < today ? s : today, repeat: { freq: 'daily', interval: 1 }, routine: g.id, order: list.length }));
    routineFocus = g.id;
    save();
  });
  card.append(add);
  return card;
}

function habitRow(it, s, g) {
  const due = occursOn(it, s), done = it.doneDates.includes(s);
  const li = h('li', 'task' + (done ? ' done' : '') + (due ? '' : ' off'));
  if (due && s <= todayStr()) {
    const check = h('button', 'check');
    check.setAttribute('aria-label', '했어요');
    check.addEventListener('click', e => { e.stopPropagation(); toggleDone(it, s); });
    li.append(check);
  } else li.append(h('span', 'check')); // 쉬는 날·앞으로 올 날은 체크 못 함
  li.append(h('span', 'title', it.title));
  const n = streak(it);
  if (n) li.append(h('span', 'meta', `🔥 ${n}`));
  if (!due) li.append(h('span', 'meta', s < it.date ? '시작 전' : '쉬는 날'));
  li.addEventListener('click', () => openHabit(it));
  if (g) {
    li.draggable = true;
    li.addEventListener('dragstart', ev => ev.dataTransfer.setData(HABIT_DRAG, it.id));
    sortable(li, HABIT_DRAG, (id, before) => placeHabit(id, g.id, it, before));
  }
  return li;
}

// ---------- 통계: 보고 있는 날의 한 주 표 + 한 달 칸 ----------
// 칸: done = 한 날(루틴 색), miss = 해야 했는데 안 한 날(옅게), later = 앞으로 할 날(테두리), '' = 쉬는 날·시작 전
function dayMark(it, s, today) {
  if (!occursOn(it, s)) return '';
  if (it.doneDates.includes(s)) return 'done';
  return s > today ? 'later' : 'miss';
}
// 달성률·횟수: 오늘까지 해야 했던 날 중 한 날
function tally(it, from, to, today) {
  let due = 0, done = 0;
  for (let b = from; b <= to; b++) {
    const m = dayMark(it, toStr(b), today);
    if (m === 'done') done++;
    if (m === 'done' || m === 'miss') due++;
  }
  return { due, done };
}
function renderStats() {
  const today = todayStr(), sel = toNum(routineDay), start = sel - weekday(sel);
  // 루틴 순서대로 (루틴 없는 습관은 뒤에), 색은 루틴 색
  const rows = [...(db.routines || []).flatMap(g => habitsIn(g.id).map(it => [it, g])),
    ...habits().filter(it => !routineById(it.routine)).sort(byOrder).map(it => [it, null])];
  const paint = (e, g) => { if (g) e.style.setProperty('--c', tone(g.color)); };
  if (!rows.length) return $('routineStats').replaceChildren(h('p', 'hint', '기록 탭에서 루틴과 습관을 만들면 여기에 모아서 보여요.'));

  const week = h('section', 'panel'), weekHead = h('div', 'panel-head'), table = h('table', 'week-table'), headRow = h('tr');
  weekHead.append(h('h2', '', '한 주'));
  week.append(weekHead, table);
  headRow.append(h('th'), ...WD.map(w => h('th', 'd', w)), h('th', 'n'));
  table.append(headRow);
  for (const [it, g] of rows) {
    const tr = h('tr'), name = h('td', 'wt-title', it.title);
    paint(tr, g);
    name.title = it.title;
    tr.append(name);
    for (let k = 0; k < 7; k++) {
      const td = h('td', 'd');
      td.append(h('span', `sq ${dayMark(it, toStr(start + k), today)}`));
      tr.append(td);
    }
    const t = tally(it, start, start + 6, today);
    tr.append(h('td', 'n', t.due ? `${t.done}/${t.due}` : ''));
    table.append(tr);
  }

  const [y, m] = ymd(routineDay), first = toNum(`${y}-${pad(m)}-01`), last = first + new Date(Date.UTC(y, m, 0)).getUTCDate() - 1;
  const month = h('section', 'panel'), head = h('div', 'panel-head'), cards = h('div', 'month-cards');
  const nav = (text, d) => {
    const b = h('button', 'icon-btn small', text);
    b.setAttribute('aria-label', d < 0 ? '지난달' : '다음 달');
    b.addEventListener('click', () => shiftRoutineMonth(d));
    return b;
  };
  head.append(nav('‹', -1), h('h2', '', `${y}년 ${m}월`), nav('›', 1));
  month.append(head, cards);
  for (const [it, g] of rows) {
    const c = h('div', 'mcard'), cal = h('div', 'mini-cal'), t = tally(it, first, last, today), foot = h('div', 'mcard-foot');
    paint(c, g);
    cal.append(...Array.from({ length: weekday(first) }, () => h('span')));
    for (let b = first; b <= last; b++) cal.append(h('span', `sq ${dayMark(it, toStr(b), today)}`, b - first + 1));
    foot.append(h('span', '', t.due ? `달성률 ${Math.round((t.done / t.due) * 100)}%` : '달성률 –'), h('span', '', `✔ ${t.done}회`));
    c.append(h('div', 'mcard-title', it.title), cal, foot);
    cards.append(c);
  }
  $('routineStats').replaceChildren(week, month);
}
// 달 넘기기: 그달 1일로 (이번 달이면 오늘) — 위의 한 주도 같이 바뀜
function shiftRoutineMonth(d) {
  let [y, m] = ymd(routineDay);
  m += d;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  const s = `${y}-${pad(m)}-01`, today = todayStr();
  routineDay = s.slice(0, 7) === today.slice(0, 7) ? today : s;
  renderRoutine();
}

// ---------- 습관 편집 창: 이름, 루틴, 요일(다 켜면 매일), 시작일 ----------
const habitForm = $('habitForm');
let habitEditing = null, habitDays = [];
function openHabit(it) {
  habitEditing = it;
  habitDays = it.repeat.freq === 'weekly' ? it.repeat.days.slice() : [0, 1, 2, 3, 4, 5, 6];
  habitForm.title.value = it.title;
  habitForm.date.value = it.date;
  const opts = (db.routines || []).map(g => [g.id, g.name]);
  if (!routineById(it.routine)) opts.push([it.routine, '루틴 없음']);
  habitForm.routine.replaceChildren(...opts.map(([id, name]) => { const o = h('option', '', name); o.value = id; return o; }));
  habitForm.routine.value = it.routine;
  renderHabitDays();
  $('habitEditor').showModal();
}
function renderHabitDays() {
  $('habitDaysHint').textContent = habitDays.length === 7 ? '매일' : `주 ${habitDays.length}일`;
  $('habitDays').replaceChildren(...WD.map((w, i) => {
    const b = h('button', habitDays.includes(i) ? 'on' : '', w);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (habitDays.includes(i)) { if (habitDays.length > 1) habitDays = habitDays.filter(x => x !== i); } // 하루는 남김
      else habitDays = [...habitDays, i].sort();
      renderHabitDays();
    });
    return b;
  }));
}
habitForm.addEventListener('submit', e => {
  e.preventDefault();
  const it = habitEditing, rid = habitForm.routine.value;
  it.title = habitForm.title.value.trim();
  it.date = habitForm.date.value;
  it.repeat = habitDays.length === 7 ? { freq: 'daily', interval: 1 } : { freq: 'weekly', interval: 1, days: habitDays.slice() };
  if (rid !== it.routine) { it.routine = rid; it.order = habitsIn(rid).length; } // 다른 루틴으로 옮기면 맨 뒤
  touch(it);
  $('habitEditor').close();
  save();
});
$('habitCancel').addEventListener('click', () => $('habitEditor').close());
$('habitDel').addEventListener('click', () => {
  if (!confirm(`'${habitEditing.title}' 습관을 삭제할까요? 지금까지의 기록도 같이 지워져요.`)) return;
  habitEditing.deleted = true;
  touch(habitEditing);
  $('habitEditor').close();
  save();
});

// ---------- 루틴 편집 창: 이름, 언제, 색 ----------
const routineForm = $('routineForm');
let routineEditing = null, routineColor = null;
function openRoutine(g) {
  routineEditing = g;
  routineForm.name.value = g ? g.name : '';
  routineForm.cue.value = g ? g.cue || '' : '';
  routineColor = g ? g.color : PASTELS[((db.routines || []).length * 3) % PASTELS.length];
  $('routineDel').hidden = !g;
  renderRoutineColors();
  $('routineEditor').showModal();
}
function renderRoutineColors() {
  $('routineColors').replaceChildren(...PASTELS.map(c => {
    const b = h('button', 'swatch' + (c === routineColor ? ' on' : ''));
    b.type = 'button';
    b.style.background = c;
    b.addEventListener('click', () => { routineColor = c; renderRoutineColors(); });
    return b;
  }));
}
// 저장할 때는 id로 찾아서 바꿈 (그사이 동기화로 db.routines 가 새 배열로 바뀌었을 수 있어서)
routineForm.addEventListener('submit', e => {
  e.preventDefault();
  const id = routineEditing ? routineEditing.id : uid(), list = db.routines || [];
  const g = { id, name: routineForm.name.value.trim(), cue: routineForm.cue.value.trim(), color: routineColor };
  db.routines = list.some(x => x.id === id) ? list.map(x => (x.id === id ? g : x)) : [...list, g];
  if (!routineEditing) routineFocus = id; // 새 루틴은 바로 습관 추가 칸으로
  $('routineEditor').close();
  save();
});
$('routineCancel').addEventListener('click', () => $('routineEditor').close());
$('routineDel').addEventListener('click', () => {
  const g = routineEditing, list = habitsIn(g.id);
  if (list.length && !confirm(`'${g.name}' 루틴과 안의 습관 ${list.length}개를 삭제할까요? 습관 기록도 같이 지워져요.`)) return;
  list.forEach(it => { it.deleted = true; touch(it); });
  db.routines = (db.routines || []).filter(x => x.id !== g.id);
  $('routineEditor').close();
  save();
});
$('addRoutineBtn').addEventListener('click', () => openRoutine(null));
