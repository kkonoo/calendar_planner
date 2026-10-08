'use strict';
// .ics (Outlook·구글 캘린더 초대/일정 파일) → 플래너 일정.
// 같은 일정(UID)을 다시 불러오면 새로 만들지 않고 갱신, 취소 메일이면 삭제. (app.js 의 newItem 등을 사용)

// Outlook은 시간대를 Windows 이름으로 적음 → 브라우저가 아는 이름으로
const ICS_WIN_TZ = {
  'Korea Standard Time': 'Asia/Seoul', 'Tokyo Standard Time': 'Asia/Tokyo', 'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei', 'Singapore Standard Time': 'Asia/Singapore', 'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
};
const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// 'DTSTART;TZID="Asia/Seoul":20261013T150000' → { name, params, value }
function icsProp(line) {
  let quoted = false, i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {};
  for (const p of ps) {
    const k = p.indexOf('=');
    params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}
const icsText = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

// 어떤 시간대의 벽시계 시각 → UTC 밀리초 (모르는 시간대면 null)
function zonedToUTC(y, mo, d, hh, mm, tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  } catch { return null; }
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const p = Object.fromEntries(f.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  return guess - (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - guess);
}

// 날짜 값 → 이 기기 시간대 기준 { date, time } (종일 일정이면 time: null)
function icsDate(prop) {
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z?))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, z] = m;
  if (!hh) return { date: `${y}-${mo}-${d}`, time: null };
  const tz = z ? 'UTC' : ICS_WIN_TZ[prop.params.TZID] || prop.params.TZID;
  const utc = tz ? zonedToUTC(+y, +mo, +d, +hh, +mm, tz) : null;
  if (utc == null) return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` }; // 시간대를 모르면 적힌 시각 그대로
  const t = new Date(utc);
  return { date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, time: `${pad(t.getHours())}:${pad(t.getMinutes())}` };
}

function icsRepeat(rule, it) {
  const R = Object.fromEntries(rule.split(';').map(kv => kv.split('=')));
  const n = +R.INTERVAL || 1;
  const until = R.UNTIL ? icsDate({ value: R.UNTIL, params: {} }).date : null;
  let rep;
  switch (R.FREQ) {
    case 'DAILY': rep = { freq: 'daily', interval: n, until }; break;
    case 'WEEKLY': {
      const days = R.BYDAY ? R.BYDAY.split(',').map(d => ICS_DAYS[d.slice(-2)]).sort() : [weekday(toNum(it.date))];
      rep = { freq: 'weekly', interval: n, days, until };
      break;
    }
    case 'MONTHLY': rep = R.BYDAY ? { freq: 'monthly', interval: n, nth: true, until } : { freq: 'monthly', interval: n, until }; break;
    case 'YEARLY': rep = { freq: 'yearly', interval: n, until }; break;
    default: return null;
  }
  if (+R.COUNT && !until) {
    it.repeat = rep;
    rep.until = untilFromCount(it, +R.COUNT);
  }
  return rep;
}

// 반환: { items: 추가/갱신할 일정, cancelled: 지울 일정 id }
function fromICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); // 접힌 줄 펴기
  const events = [];
  let cur = null, method = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const p = icsProp(line);
      if (p.name === 'EXDATE') (cur.EXDATE = cur.EXDATE || []).push(p);
      else cur[p.name] = p;
    } else if (line.startsWith('METHOD:')) method = line.slice(7).trim();
  }

  const items = [], cancelled = [];
  for (const ev of events) {
    if (!ev.DTSTART || !ev.UID) continue;
    const start = icsDate(ev.DTSTART);
    if (!start) continue;
    const recur = ev['RECURRENCE-ID'] ? icsDate(ev['RECURRENCE-ID']).date : null;
    const id = `ics-${ev.UID.value.replace(/[^\w.@-]/g, '_')}${recur ? `-${recur}` : ''}`;
    const status = ev.STATUS ? ev.STATUS.value.toUpperCase() : '';
    if (method === 'CANCEL' || status === 'CANCELLED') { cancelled.push(id); continue; }

    const it = newItem({ id, title: ev.SUMMARY ? icsText(ev.SUMMARY.value) : '(제목 없음)', date: start.date, time: start.time });
    const end = ev.DTEND ? icsDate(ev.DTEND) : null;
    if (end) {
      // 종일 일정의 끝 날짜는 '다음 날 0시'로 적혀 있음
      const last = start.time ? end.date : toStr(toNum(end.date) - 1);
      if (last > it.date) it.endDate = last;
    }
    if (start.time && end && end.time && (end.date > start.date || end.time > start.time)) it.endTime = end.time;
    const note = [];
    if (ev.LOCATION) it.place = icsText(ev.LOCATION.value);
    if (ev.DESCRIPTION && icsText(ev.DESCRIPTION.value)) note.push(icsText(ev.DESCRIPTION.value));
    it.note = note.join('\n\n');

    if (ev.RRULE && !recur) {
      it.repeat = icsRepeat(ev.RRULE.value, it);
      if (it.repeat) {
        it.endDate = null;
        it.skipDates = (ev.EXDATE || []).flatMap(p => p.value.split(',').map(v => icsDate({ value: v, params: p.params }).date));
      }
    }
    items.push(it);
  }

  // 반복 중 하루만 바뀐 일정: 원래 반복에서 그날을 빼고 따로 추가
  for (const it of items) {
    const m = it.id.match(/^(.*)-(\d{4}-\d{2}-\d{2})$/);
    const master = m && items.find(x => x.id === m[1] && x.repeat);
    if (master) { master.skipDates.push(m[2]); it.seriesId = master.id; }
  }
  return { items, cancelled };
}
