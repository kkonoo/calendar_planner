'use strict';
// DesktopCal(바탕화면 달력) 데이터 → 플래너 항목 변환.
// 입력은 tools/export-desktopcal.ps1 이 만든 JSON. (app.js 의 newItem, occursOn 등을 사용)

// DesktopCal에서 쓰던 글자색 → 카테고리
const DC_COLOR_CAT = {
  '#90949D': 'work', '#6C6E75': 'work', '#879AB8': 'work',
  '#61D2BA': 'lab', '#489D8B': 'lab', '#31AC9A': 'lab',
  '#D7B1F9': 'research', '#A184BA': 'research', '#9F99B3': 'research',
  '#FF9595': 'social', '#BF6F6F': 'social', '#F12424': 'social', '#E14141': 'social', '#B41A1A': 'social',
  '#F5D107': 'personal', '#B79C05': 'personal',
  '#B5CEF6': 'teach', '#D9E8FF': 'teach', '#609FDB': 'teach', '#6170D1': 'teach',
};
const DC_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DC_ENTITIES = { lt: '<', gt: '>', quot: '"', amp: '&', apos: "'", nbsp: ' ' };

// DesktopCal은 특수문자를 |&lt;| 처럼 저장함
const dcDecode = s => (s || '').replace(/\|&(lt|gt|quot|amp|apos|nbsp);\|/g, (_, e) => DC_ENTITIES[e]);
const dcDate = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; // 20261013 → 2026-10-13

// 한 줄 예: <font color="#90949D">[+]14:00 제목</font>   ([+] = 완료)
function dcLine(line) {
  const m = line.match(/<font color="(#[0-9a-f]{6})">([\s\S]*?)<\/font>/i);
  let text = (m ? m[2] : line).replace(/<[^>]*>/g, '').trim();
  const done = text.startsWith('[+]');
  if (done) text = text.slice(3).trim();
  const t = text.match(/^(\d{1,2}):(\d{2})\s*(.+)$/);
  return {
    title: t ? t[3] : text,
    time: t ? `${pad(t[1])}:${t[2]}` : null,
    cat: m ? DC_COLOR_CAT[m[1].toUpperCase()] || null : null,
    done,
  };
}

function dcRepeat(R, start) {
  const until = R.UNTIL ? dcDate(R.UNTIL) : null;
  const days = R.BYWEEK ? R.BYWEEK.split(',').map(d => DC_DAYS[d]).sort() : [weekday(toNum(start))];
  const n = +R.CUSTOMCOUNT || 1;
  switch (R.FREQ) {
    case 'DAILY': return { freq: 'daily', interval: 1, until };
    case 'WEEKLY': return { freq: 'weekly', interval: 1, days, until };
    case 'CUSTOMWEEK': return { freq: 'weekly', interval: n, days, until };
    case 'MONTHLY': return { freq: 'monthly', interval: 1, until };
    case 'CUSTOMMONTH': return R.BYDAY ? { freq: 'monthly', interval: n, nth: true, until } : { freq: 'monthly', interval: n, until };
    case 'YEARLY': return { freq: 'yearly', interval: 1, until };
  }
  return null;
}

function fromDesktopCal(raw) {
  const out = [];

  // 날짜 칸 메모: 한 줄 = 항목 하나
  for (const r of raw.items || []) {
    const d = (r.unique_id || '').match(/^dkcal_mdays_(\d{8})$/);
    if (!d) continue;
    dcDecode(r.content).split(/\r?\n/).forEach((line, i) => {
      const p = dcLine(line);
      if (p.title) out.push(newItem({ id: `dc-${d[1]}-${i}`, date: dcDate(d[1]), ...p }));
    });
  }

  // 반복 일정
  for (const e of raw.events || []) {
    if (+e.status !== 1 || !e.start) continue; // status 2 = DesktopCal에서 삭제된 일정
    const p = dcLine(dcDecode(e.content).split(/\r?\n/).find(l => l.trim()) || '');
    if (!p.title) continue;
    let R = {}, info = {};
    try { R = JSON.parse(e.rrule).RRULE || {}; } catch { }
    try { info = JSON.parse(dcDecode(e.info)); } catch { }
    const it = newItem({ id: `dc-${e.unique_id}`, date: e.start.slice(0, 10), title: p.title, time: p.time, cat: p.cat });
    it.repeat = +R.COUNT === 1 ? null : dcRepeat(R, it.date);
    if (it.repeat && +R.COUNT > 1 && !it.repeat.until) it.repeat.until = untilFromCount(it, +R.COUNT);
    const dates = k => String(info[k] || '').split(',').filter(Boolean).map(dcDate);
    const r = it.repeat;
    if (r && r.freq === 'daily' && r.interval === 1 && r.until) {
      // 끝나는 날이 있는 '매일' = 며칠짜리 일정 (DesktopCal은 이렇게 저장함)
      it.repeat = null;
      if (r.until > it.date) it.endDate = r.until;
      it.done = dates('CMPEDATE').includes(r.until);
    } else if (it.repeat) {
      it.doneDates = dates('CMPEDATE');
      it.skipDates = dates('DELDATE');
    } else it.done = dates('CMPEDATE').includes(it.date);
    out.push(it);
  }
  return out;
}
