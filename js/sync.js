// 구글 계정 로그인 + 기기 간 동기화 (Firebase Auth + Firestore).
// firebase-config.js 가 비어 있으면 아무것도 하지 않음 → 이 브라우저에만 저장.
// 저장 위치: users/{uid}/items/{일정 id}, users/{uid}/meta/categories (카테고리), users/{uid}/meta/days (날짜 칠하기), users/{uid}/meta/also (추가 카테고리), users/{uid}/meta/palette (팔레트에서 뺀 색)
// 공유 캘린더: shared/{캘린더 id} = { name, color, buckets, owner, ownerEmail, emails }, 일정은 shared/{캘린더 id}/items/{일정 id}
//   emails 에 든 구글 계정만 읽고 씀 (firestore.rules). 앱에서는 카테고리 하나로 보임 (category.shared = { owner, ownerEmail, emails })
// app.js 의 db, save, persist, render 등을 그대로 사용.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

if (firebaseConfig) start();

async function start() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  await dbReady; // 기기에 저장된 일정을 다 읽은 뒤에 (그 전엔 db가 빈 값)
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });

  // 일정 말고 통째로 저장하는 값들 (마지막에 저장한 쪽이 이김). 공유 캘린더는 카테고리에 섞여 있지만 따로 저장
  const META = {
    categories: { get: () => db.categories.filter(c => !c.shared), set: v => { db.categories = [...v, ...db.categories.filter(c => c.shared)]; } },
    days: { get: () => db.dayColors || {}, set: v => { db.dayColors = v; } },
    also: { get: () => db.also || {}, set: v => { db.also = v; } }, // 추가 카테고리 (공유 일정에 붙인 것도 내 계정에만)
    palette: { get: () => db.paletteOff || [], set: v => { db.paletteOff = v; } }, // 카테고리 색 팔레트에서 뺀 색
  };
  let uid = null, email = '', unsub = [], calUnsub = {}, synced = {}, home = {}, metaJSON = {}, calJSON = {}, ready = {}, loaded = {};
  // 이 기기가 서버와 어디까지 맞췄는지. db 안에 같이 저장 → 로그아웃·계정 변경으로 db가 바뀌면 같이 없어짐
  // cols: '' (내 일정) 또는 공유 캘린더 id → { since: 서버에서 받은 마지막 변경 시각(syncedAt, 서버 시계) } / full: 마지막으로 전부 받은 때
  // synced: 일정 id → 서버에 있는 updatedAt / home: 일정 id → 서버에서 있는 곳 ('' 또는 공유 캘린더 id)
  let cols = {}, full = 0;
  const keep = () => { db.sync = { full, cols, synced, home }; persist(); };
  const clean = v => JSON.parse(JSON.stringify(v)); // Firestore는 undefined 값을 못 받음
  const sharedCats = () => db.categories.filter(c => c.shared);
  const itemsCol = key => (key ? F.collection(fs, 'shared', key, 'items') : F.collection(fs, 'users', uid, 'items'));
  const allReady = () => loaded[''] && ready.list && Object.keys(META).every(k => ready[k]) && sharedCats().every(c => loaded[c.id]);

  // ---------- 화면 ----------
  const accountBtn = $('accountBtn');
  $('accountSection').hidden = false;
  accountBtn.hidden = false;
  const login = () => A.signInWithPopup(auth, new A.GoogleAuthProvider()).catch(e => {
    if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') alert(`로그인하지 못했어요: ${e.code}`);
  });
  accountBtn.addEventListener('click', () => auth.currentUser ? $('settingsBtn').click() : login());
  $('loginBtn').addEventListener('click', login);
  $('logoutBtn').addEventListener('click', () => A.signOut(auth));

  function showAccount(user) {
    accountBtn.textContent = user ? (user.displayName || user.email || '?').slice(0, 1) : '로그인';
    accountBtn.className = user ? 'avatar' : 'btn';
    accountBtn.title = user ? user.email : 'Google 계정으로 로그인';
    $('accountInfo').textContent = user ? `${user.email} 으로 로그인됨 · 자동 동기화` : '로그인하면 PC와 폰에서 같은 일정을 볼 수 있어요.';
    $('loginBtn').hidden = !!user;
    $('logoutBtn').hidden = !user;
  }

  // ---------- 올리기: 마지막으로 맞춘 뒤 바뀐 것만 ----------
  // 공유 캘린더 정보 (멤버가 바꿀 수 있는 것 + 만든 사람)
  const calMeta = c => JSON.stringify({
    name: c.name, color: c.color, buckets: c.buckets || [],
    owner: c.shared.owner, ownerEmail: c.shared.ownerEmail, emails: c.shared.emails,
  });
  function push() {
    if (!uid || !allReady()) return;
    const writes = {}; // 저장할 곳별로 따로 묶음 → 공유 캘린더 쓰기가 막혀도 내 일정은 올라감
    const add = (k, ref, data, opts) => (writes[k] ||= []).push([ref, data, opts]);
    const at = F.serverTimestamp(), cals = new Set(sharedCats().map(c => c.id));
    let changed = false;
    for (const it of db.items) {
      if (it.updatedAt <= (synced[it.id] || 0)) continue;
      const to = cals.has(it.cat) ? it.cat : '', from = home[it.id];
      if (to && !it.by) it.by = { uid, name: window.me.name }; // 공유 일정에 넣은 사람
      add(to, F.doc(itemsCol(to), it.id), { ...clean(it), syncedAt: at });
      // 내 일정 ↔ 공유 캘린더로 옮겼으면 원래 자리엔 지운 표시. 1ms 이르게 해서 어느 쪽을 먼저 받아도 새 자리 것이 이김
      if (from !== undefined && from !== to && (!from || cals.has(from))) {
        add(from, F.doc(itemsCol(from), it.id), { ...clean(it), deleted: true, updatedAt: it.updatedAt - 1, syncedAt: at });
      }
      synced[it.id] = it.updatedAt;
      home[it.id] = to;
      changed = true;
    }
    if (changed) keep();
    for (const [name, m] of Object.entries(META)) {
      const json = JSON.stringify(m.get());
      if (json !== metaJSON[name]) {
        add('meta', F.doc(fs, 'users', uid, 'meta', name), { value: JSON.parse(json), updatedAt: Date.now() });
        metaJSON[name] = json;
      }
    }
    for (const c of sharedCats()) {
      const json = calMeta(c);
      if (json !== calJSON[c.id]) {
        // 멤버는 이름·색·그룹만 (멤버 목록은 만든 사람만 바꿈 → 오래된 목록으로 덮어쓰지 않게)
        const { name, color, buckets, emails } = JSON.parse(json);
        const data = { name, color, buckets, updatedAt: Date.now(), ...(c.shared.owner === uid ? { emails } : {}) };
        add(`cal:${c.id}`, F.doc(fs, 'shared', c.id), data, { merge: true });
        calJSON[c.id] = json;
      }
    }
    for (const list of Object.values(writes)) {
      for (let i = 0; i < list.length; i += 400) { // 한 번에 최대 500개 제한
        const batch = F.writeBatch(fs);
        for (const [ref, data, opts] of list.slice(i, i + 400)) opts ? batch.set(ref, data, opts) : batch.set(ref, data);
        batch.commit().catch(e => console.error('동기화 실패', e));
      }
    }
  }
  window.onSave = push;

  // ---------- 받기 ----------
  // 올리기(push)는 서버 값을 한 번 받은 뒤부터. 기기 캐시에만 있는 값(새 브라우저면 빈 값)을 보고 올리면
  // 계정의 카테고리를 이 기기의 기본 카테고리로 덮어씀 → fromCache 가 풀릴 때 알 수 있게 includeMetadataChanges
  const META_CHANGES = { includeMetadataChanges: true };
  // 일정 받기: key = '' (내 일정) 또는 공유 캘린더 id
  function listenItems(key) {
    // 열 때마다 일정을 전부 받으면 일정 수만큼 읽기가 듦 → 지난번 이후 바뀐 것(syncedAt)만
    const c = cols[key] ||= { since: 0 };
    const col = itemsCol(key);
    // 10분 겹쳐 받기: syncedAt은 요청 시각이라 늦게 끝난 저장이 더 이른 시각을 가질 수 있음
    const q = c.since ? F.query(col, F.where('syncedAt', '>', F.Timestamp.fromMillis(c.since - 10 * 60e3))) : col;
    return F.onSnapshot(q, META_CHANGES, snap => {
      let changed = false;
      const before = c.since;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue; // 내가 막 올린 일정이 서버 시각을 받기 전에 잠깐 빠지는 것
        const { syncedAt, ...r } = ch.doc.data();
        if (syncedAt?.toMillis && !snap.metadata.fromCache && !ch.doc.metadata.hasPendingWrites) c.since = Math.max(c.since, syncedAt.toMillis());
        if (r.updatedAt >= (synced[r.id] || 0)) home[r.id] = key; // 옮긴 일정은 더 새것이 있는 곳
        synced[r.id] = Math.max(synced[r.id] || 0, r.updatedAt);
        const local = db.items.find(x => x.id === r.id);
        if (!local) { db.items.push(r); changed = true; }
        else if (r.updatedAt > local.updatedAt) {
          // 편집 창이 같은 객체를 잡고 있을 수 있어서 바꿔 끼우지 않고 내용만 교체
          for (const k of Object.keys(local)) if (!(k in r)) delete local[k];
          Object.assign(local, r);
          changed = true;
        }
      }
      const first = !loaded[key] && !snap.metadata.fromCache;
      if (first) {
        loaded[key] = true;
        if (!key && !full) full = Date.now();
        if (!c.since) c.since = Date.now() - 864e5; // syncedAt 붙은 일정이 아직 하나도 없을 때 (이 기능 전에 올린 것들)
      }
      if (changed || first || c.since !== before) keep();
      if (changed) render();
      if (first) push();
    }, e => {
      console.error('동기화 실패', e);
      // 공유 캘린더를 못 읽어도 내 일정 올리기는 막히지 않게
      if (key && !loaded[key]) { loaded[key] = true; push(); }
    });
  }

  // 공유 캘린더 정보를 서버 값으로 (없으면 카테고리 맨 뒤에 추가)
  function upsertCal(id, d) {
    const fresh = { id, name: d.name, color: d.color, buckets: d.buckets || [], shared: { owner: d.owner, ownerEmail: d.ownerEmail, emails: d.emails } };
    const json = calMeta(fresh), c = db.categories.find(x => x.id === id);
    calJSON[id] = json;
    if (c && calMeta(c) === json) return false;
    if (c) Object.assign(c, fresh); else db.categories.push(fresh);
    return true;
  }
  // 나갔거나, 내보내졌거나, 삭제된 공유 캘린더: 이 기기에서만 빼기 (지운 표시 없이 — 다른 멤버에겐 그대로)
  function dropCal(id) {
    calUnsub[id]?.();
    delete calUnsub[id]; delete cols[id]; delete calJSON[id]; delete loaded[id];
    db.categories = db.categories.filter(c => c.id !== id);
    db.items = db.items.filter(i => i.cat !== id);
    for (const k of Object.keys(home)) if (home[k] === id) { delete home[k]; delete synced[k]; }
    keep();
    render();
  }

  function subscribe() {
    // 처음이거나 일주일 지났으면 혹시 놓친 게 없게 전부 받기 (home 없는 예전 상태도 — 옮긴 일정의 원래 자리를 알아야 해서)
    const st = db.sync || {};
    const all = !st.full || !st.home || Date.now() - st.full > 7 * 864e5;
    full = all ? 0 : st.full;
    cols = all ? {} : { ...st.cols };
    synced = all ? {} : { ...st.synced };
    home = all ? {} : { ...st.home };
    unsub.push(listenItems(''));

    for (const [name, m] of Object.entries(META)) {
      unsub.push(F.onSnapshot(F.doc(fs, 'users', uid, 'meta', name), META_CHANGES, snap => {
        if (snap.exists()) {
          const v = snap.data().value;
          metaJSON[name] = JSON.stringify(v);
          if (metaJSON[name] !== JSON.stringify(m.get())) { m.set(v); persist(); render(); }
        }
        if (!ready[name] && !snap.metadata.fromCache) { ready[name] = true; push(); }
      }, e => console.error('동기화 실패', e)));
    }

    // 내 이메일이 멤버로 들어간 공유 캘린더들
    const mine = F.query(F.collection(fs, 'shared'), F.where('emails', 'array-contains', email));
    unsub.push(F.onSnapshot(mine, META_CHANGES, snap => {
      let changed = false;
      for (const d of snap.docs) changed = upsertCal(d.id, d.data()) || changed;
      if (changed) { persist(); render(); }
      if (!snap.metadata.fromCache) {
        const ids = snap.docs.map(d => d.id);
        sharedCats().filter(c => !ids.includes(c.id)).forEach(c => dropCal(c.id));
        ready.list = true;
      }
      // 막 만든 캘린더는 서버에 생긴 뒤에 일정 구독 (그 전엔 규칙 검사에서 막혀 구독이 끊김)
      const pending = snap.docs.filter(d => d.metadata.hasPendingWrites).map(d => d.id);
      for (const c of sharedCats()) if (!pending.includes(c.id)) calUnsub[c.id] ||= listenItems(c.id);
      push();
    }, e => {
      console.error('동기화 실패', e); // 보안 규칙을 아직 안 바꿨을 때 등 — 내 일정은 그대로
      ready.list = true;
      for (const c of sharedCats()) calUnsub[c.id] ||= listenItems(c.id);
      push();
    }));
  }

  // ---------- 공유 캘린더 만들기·나가기·삭제 (설정 화면에서 부름) ----------
  window.sharing = {
    // 카테고리 c를 공유 캘린더로: 새 id로 만들고 일정을 옮김 (내 일정 쪽엔 지운 표시가 남음)
    async share(c) {
      const id = F.doc(F.collection(fs, 'shared')).id;
      const d = { name: c.name, color: c.color, buckets: c.buckets || [], owner: uid, ownerEmail: email, emails: [email] };
      await F.setDoc(F.doc(fs, 'shared', id), clean({ ...d, updatedAt: Date.now() }));
      upsertCal(id, d); // 목록 구독이 먼저 넣었으면 그대로
      db.categories = db.categories.filter(x => x.id !== c.id); // 서버에서 받은 값으로 객체가 바뀌었을 수 있어 id로
      db.items.forEach(i => { if (i.cat === c.id) { i.cat = id; touch(i); } });
      if (prefs.cat === c.id) prefs.cat = id;
      if (prefs.plan === c.id) prefs.plan = id;
      savePrefs();
      save();
      return id;
    },
    // 멤버에서 나 빼기 (규칙상 멤버는 자기 이메일만 뺄 수 있음)
    async leave(c) {
      await F.updateDoc(F.doc(fs, 'shared', c.id), { emails: F.arrayRemove(email) });
      dropCal(c.id);
    },
    // 만든 사람만: 일정까지 모두 지움
    async remove(c) {
      const snap = await F.getDocs(itemsCol(c.id));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = F.writeBatch(fs);
        snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      await F.deleteDoc(F.doc(fs, 'shared', c.id));
      dropCal(c.id);
    },
  };

  // ---------- 로그인 / 로그아웃 ----------
  A.onAuthStateChanged(auth, user => {
    unsub.forEach(f => f());
    Object.values(calUnsub).forEach(f => f());
    unsub = []; calUnsub = {}; synced = {}; home = {}; metaJSON = {}; calJSON = {}; ready = {}; loaded = {};
    uid = user ? user.uid : null;
    email = user ? (user.email || '').toLowerCase() : '';
    window.me = user ? { uid, email, name: user.displayName || email.split('@')[0] } : null;
    showAccount(user);

    if (!user) {
      // 로그아웃: 이 기기에 남은 계정 데이터는 지움 (계정에는 그대로 있음)
      if (db.owner) { db = { version: 1, categories: DEFAULT_CATS, items: [] }; persist(); render(); }
      return;
    }
    if (db.owner !== uid) {
      const n = live().length;
      const merge = !db.owner && n > 0 &&
        confirm(`이 기기에 저장된 일정 ${n}개를 ${user.email} 계정에 합칠까요?\n(취소하면 계정에 있는 일정만 보여요)`);
      if (!merge) db = { version: 1, categories: DEFAULT_CATS, items: [] };
      db.owner = uid;
      delete db.sync; // 다른 계정 기준이었던 동기화 상태로 이 계정을 받으면 빠지는 게 생김
      persist();
      render();
    }
    subscribe();
  });
}
