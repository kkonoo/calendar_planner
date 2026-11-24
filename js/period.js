'use strict';
// 생리 기록 (설정 → 생리 기록 켜기). app.js·routine.js 의 함수·데이터를 사용
// db.period = { on, color: 생리 색, fert: 가임기·배란일 색, list: [{ start, end }] (시작일 순) }
//   → 내 계정에만 저장 (sync.js: users/{uid}/meta/period). 공유 캘린더와 별개라 멤버에게는 안 보임
// 예상: 최근 6번 주기·생리 기간의 평균 (기록이 한 번뿐이면 주기 28일)
//   다음 생리 = 마지막 시작일 + 평균 주기 (앞으로 3번까지), 배란일 = 다음 생리 시작 14일 전, 가임기 = 배란일 5일 전 ~ 1일 뒤
// 달력: 날짜 숫자에 동그라미 (생리 = 채움, 예상 생리 = 점선, 가임기 = 옅은 바탕, 배란일 = 채움)
// 기록: 루틴 → 기록의 '생리 주기' 카드 (위에서 고른 날), 통계: 루틴 → 통계 맨 아래
const PERIOD_COLOR = '#D6336C', FERT_COLOR = '#1D8A83';
const periodOn = () => !!db.period?.on;
const periods = () => (db.period?.list || []).slice().sort((a, b) => a.start.localeCompare(b.start));
const setPeriods = list => { db.period = { ...db.period, list: list.sort((a, b) => a.start.localeCompare(b.start)) }; save(); };

function periodStats() {
  const list = periods();
  if (!list.length) return null;
  const recent = list.slice(-7);
  const cycles = recent.slice(1).map((r, i) => toNum(r.start) - toNum(recent[i].start));
  const lens = list.slice(-6).map(r => toNum(r.end) - toNum(r.start) + 1);
  const mean = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const cycle = cycles.length ? mean(cycles) : 28, last = list[list.length - 1];
  return { list, cycles, lens, cycle, len: mean(lens), last, next: toNum(last.start) + cycle };
}

// 달력 칸 표시: 일 번호 → 'period' | 'predict' | 'fertile' | 'ovul' (꺼져 있거나 기록이 없으면 null)
function periodMarks(from, to) {
  const st = periodOn() && periodStats();
  if (!st) return null;
  const m = new Map();
  const put = (a, b, k) => { for (let x = Math.max(a, from); x <= Math.min(b, to); x++) if (!m.has(x)) m.set(x, k); };
  for (const r of st.list) put(toNum(r.start), toNum(r.end), 'period');
  // 각 주기의 배란일·가임기 (지난 주기는 실제 다음 시작일, 앞으로는 예상한 날 기준)
  const ahead = [0, 1, 2].map(k => st.next + k * st.cycle);
  const starts = [...st.list.map(r => toNum(r.start)), ...ahead];
  for (const s of starts.slice(1)) put(s - 14, s - 14, 'ovul');
  for (const s of starts.slice(1)) put(s - 19, s - 13, 'fertile');
  for (const s of ahead) put(s, s + st.len - 1, 'predict');
  return m;
}

// 색: 다크 모드에선 카테고리처럼 밝게(tone). 채운 동그라미 위 글씨는 색이 밝으면 짙게 (다크 모드는 CSS에서 늘 짙게)
const inkOn = hex => {
  const L = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2] > 0.22 ? '#262626' : '#FFFFFF';
};
function applyPeriodColors() {
  const s = document.documentElement.style, c = db.period?.color || PERIOD_COLOR, f = db.period?.fert || FERT_COLOR;
  s.setProperty('--period', tone(c));
  s.setProperty('--fert', tone(f));
  s.setProperty('--period-ink-l', inkOn(c));
  s.setProperty('--fert-ink-l', inkOn(f));
}

// ---------- 루틴 → 기록: 고른 날(routineDay) 기록하기 + 예상 ----------
function startPeriod(s) {
  const list = periods(), st = periodStats(), nx = list.find(r => r.start > s);
  // 평균 기간만큼 채움 (다음 기록과 겹치지 않게)
  const end = Math.min(toNum(s) + (st ? st.len : 5) - 1, nx ? toNum(nx.start) - 1 : Infinity);
  setPeriods([...list, { start: s, end: toStr(end) }]);
}
const endPeriod = (r, s) => setPeriods(periods().map(x => (x.start === r.start ? { ...x, end: s } : x)));
function dropPeriod(r) {
  if (!confirm(`${fmtMD(r.start)}~${fmtMD(r.end)} 생리 기록을 지울까요?`)) return;
  setPeriods(periods().filter(x => x.start !== r.start));
}

function renderPeriodCard() {
  const s = routineDay, d = toNum(s), list = periods(), st = periodStats();
  const rec = list.find(r => r.start <= s && s <= r.end);
  const prev = list.filter(r => r.start <= s).pop(); // 이날 또는 그 전에 시작한 마지막 기록
  // 생리가 길어졌으면: 시작 2주 안의 날에서 '이날 끝'으로 늘리기
  const longer = !rec && prev && d - toNum(prev.start) < 14 ? prev : null;
  const btn = (text, fn) => { const b = h('button', 'btn small', text); b.addEventListener('click', fn); return b; };

  const head = h('div', 'panel-head');
  head.append(h('h2', '', '생리 주기'), h('span', 'hint', st?.cycles.length ? `최근 ${st.cycles.length}번 평균으로 예상해요` : '기록이 쌓이면 평균으로 예상해요'));
  const day = h('div', 'period-day');
  day.append(h('span', 'd', fmtShort(s)));
  if (rec) day.append(h('span', 'state on', `생리 ${d - toNum(rec.start) + 1}일째`));
  else if (prev) day.append(h('span', 'state', `주기 ${d - toNum(prev.start) + 1}일째`));
  const acts = h('div', 'period-acts');
  if (rec) {
    if (s !== rec.end) acts.append(btn('이날 끝', () => endPeriod(rec, s)));
    acts.append(btn('기록 지우기', () => dropPeriod(rec)));
  } else {
    acts.append(btn('🩸 이날 생리 시작', () => startPeriod(s)));
    if (longer) acts.append(btn('이날 끝', () => endPeriod(longer, s)));
  }
  const row = h('div', 'period-row');
  row.append(day);
  if (st) row.append(periodNext(st));
  row.append(acts);
  $('periodCard').replaceChildren(head, row);
}
// 평균 주기 · 다음 생리 · 가임기 · 배란일 (오늘 기준 — 이번 주기 가임기가 지났으면 다음 주기)
function periodNext(st) {
  const T = toNum(todayStr()), sh = n => fmtShort(toStr(n));
  let ov = st.next - 14;
  if (ov + 1 < T) ov += st.cycle;
  const until = n => (n === T ? '오늘' : n > T ? `${n - T}일 뒤` : `${T - n}일 지났어요`);
  const cell = (k, v, cls, sub) => { const c = h('div'); c.append(h('span', 'k', k), h('span', 'v ' + cls, v), h('span', 's', sub)); return c; };
  const grid = h('div', 'period-grid');
  grid.append(
    cell('평균 주기', `${st.cycle}일`, '', st.cycles.length ? `${Math.min(...st.cycles)}~${Math.max(...st.cycles)}일` : '기본값이에요'),
    cell('다음 생리', sh(st.next), 'period', `${until(st.next)} · ${st.len}일간`),
    cell('가임기', `${fmtMD(toStr(ov - 5))}~${ymd(toStr(ov + 1))[2]}`, 'fert', T >= ov - 5 && T <= ov + 1 ? '지금 가임기예요' : until(ov - 5)),
    cell('배란일', sh(ov), 'fert', until(ov)),
  );
  return grid;
}

// ---------- 루틴 → 통계: 평균 주기·기간, 규칙성, 최근 주기 ----------
function periodStatsPanel() {
  const st = periodStats(), box = h('section', 'panel period-card'), head = h('div', 'panel-head');
  head.append(h('h2', '', '생리 주기'));
  box.append(head);
  if (!st?.cycles.length) {
    box.append(h('p', 'hint', '생리 기록이 두 번 이상 쌓이면 주기를 보여 줘요.'));
    return box;
  }
  const { cycles, lens, last } = st, range = a => `${Math.min(...a)}~${Math.max(...a)}일`;
  const spread = Math.max(...cycles) - Math.min(...cycles);
  head.append(h('span', 'hint', `최근 ${cycles.length}번`));
  const cell = (k, v, sub) => { const c = h('div'); c.append(h('span', 'k', k), h('span', 'v', v), h('span', 's', sub)); return c; };
  const grid = h('div', 'period-grid');
  grid.append(
    cell('평균 주기', `${st.cycle}일`, range(cycles)),
    cell('평균 생리 기간', `${st.len}일`, range(lens)),
    // 가장 긴 주기와 짧은 주기의 차이가 7일 이내면 규칙적
    cycles.length > 1 ? cell('규칙성', spread <= 7 ? '규칙적' : '불규칙', `주기 차이 ${spread}일`) : cell('규칙성', '–', '기록이 더 필요해요'),
  );
  // 최근 주기: 지금 주기(며칠째) + 지난 주기 6번. 막대 = 주기 길이
  const list = st.list, now = toNum(todayStr()) - toNum(last.start) + 1;
  const rows = list.slice(-7, -1).map((r, i, a) => ({ r, c: toNum((a[i + 1] || last).start) - toNum(r.start) })).reverse();
  const max = Math.max(now, ...rows.map(x => x.c));
  const table = h('table', 'period-cycles');
  const tr = (r, n, text, cur) => {
    const t = h('tr'), bar = h('div', 'bar' + (cur ? ' now' : ''));
    bar.style.width = `${Math.round((Math.max(n, 0) / max) * 100)}%`;
    const td = h('td');
    td.append(bar);
    t.append(h('td', '', `${fmtMD(r.start)}~`), td, h('td', 'n' + (cur ? ' m' : ''), text), h('td', 'n m', `${toNum(r.end) - toNum(r.start) + 1}일`));
    return t;
  };
  table.append(tr(last, now, now > 0 ? `${now}일째` : '', true), ...rows.map(x => tr(x.r, x.c, `${x.c}일`)));
  const sec = h('div', 'period-sec');
  sec.append(h('h3', '', '최근 주기'), table);
  if (cycles.length > 1) {
    const diff = cycles[cycles.length - 1] - cycles[cycles.length - 2];
    sec.append(h('p', 'hint', `지난 주기 ${cycles[cycles.length - 1]}일 · ${diff ? `그 전보다 ${Math.abs(diff)}일 ${diff < 0 ? '짧아요' : '길어요'}` : '그 전과 같아요'}`));
  }
  box.append(grid, sec);
  return box;
}

// ---------- 설정: 켜기·끄기, 색 (카테고리와 같은 팔레트) ----------
let periodPaletteFor = null; // 팔레트를 펼친 색 ('color' | 'fert')
function renderPeriodSettings() {
  const p = db.period || {};
  $('periodSelect').value = p.on ? 'on' : '';
  $('periodColors').hidden = !p.on;
  $('periodColors').replaceChildren(...[['color', '생리', PERIOD_COLOR], ['fert', '가임기·배란일', FERT_COLOR]].flatMap(([k, name, def]) => {
    const cur = p[k] || def, row = h('div', 'cat-row'), sw = h('button', 'cat-swatch');
    sw.type = 'button';
    sw.title = '색 바꾸기';
    sw.style.background = cur;
    sw.addEventListener('click', () => { periodPaletteFor = periodPaletteFor === k ? null : k; renderPeriodSettings(); });
    row.append(sw, h('span', '', name));
    if (periodPaletteFor !== k) return [row];
    const palette = h('div', 'cat-palette');
    palette.append(...paletteSwatches(cur, c => { db.period = { ...db.period, [k]: c }; periodPaletteFor = null; save(); renderPeriodSettings(); }));
    return [row, palette];
  }));
}
$('periodSelect').addEventListener('change', e => { db.period = { ...db.period, on: !!e.target.value }; save(); renderPeriodSettings(); });
$('settingsBtn').addEventListener('click', () => { periodPaletteFor = null; renderPeriodSettings(); });
