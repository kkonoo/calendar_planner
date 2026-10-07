// 구글 계정 로그인 + 기기 간 동기화 (Firebase Auth + Firestore).
// firebase-config.js 가 비어 있으면 아무것도 하지 않음 → 이 브라우저에만 저장.
// 저장 위치: users/{uid}/items/{일정 id}, users/{uid}/meta/categories (카테고리), users/{uid}/meta/days (날짜 칠하기)
// app.js 의 db, save, persist, render 등을 그대로 사용.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

if (firebaseConfig) start();

async function start() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });

  // 일정 말고 통째로 저장하는 값들 (마지막에 저장한 쪽이 이김)
  const META = {
    categories: { get: () => db.categories, set: v => { db.categories = v; } },
    days: { get: () => db.dayColors || {}, set: v => { db.dayColors = v; } },
  };
  let uid = null, unsub = [], synced = {}, metaJSON = {}, ready = {};
  // 이 기기가 서버와 어디까지 맞췄는지. db 안에 같이 저장 → 로그아웃·계정 변경으로 db가 바뀌면 같이 없어짐
  // since: 서버에서 받은 마지막 변경 시각(syncedAt, 서버 시계) / full: 마지막으로 전부 받은 때 / synced: 일정 id → 서버에 있는 updatedAt
  let since = 0, full = 0;
  const keep = () => { db.sync = { since, full, synced }; persist(); };
  const clean = v => JSON.parse(JSON.stringify(v)); // Firestore는 undefined 값을 못 받음
  const allReady = () => ready.items && Object.keys(META).every(k => ready[k]);

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
  function push() {
    if (!uid || !allReady()) return;
    const writes = [];
    for (const it of db.items) {
      if (it.updatedAt > (synced[it.id] || 0)) {
        writes.push([F.doc(fs, 'users', uid, 'items', it.id), { ...clean(it), syncedAt: F.serverTimestamp() }]);
        synced[it.id] = it.updatedAt;
      }
    }
    if (writes.length) keep();
    for (const [name, m] of Object.entries(META)) {
      const json = JSON.stringify(m.get());
      if (json !== metaJSON[name]) {
        writes.push([F.doc(fs, 'users', uid, 'meta', name), { value: JSON.parse(json), updatedAt: Date.now() }]);
        metaJSON[name] = json;
      }
    }
    for (let i = 0; i < writes.length; i += 400) { // 한 번에 최대 500개 제한
      const batch = F.writeBatch(fs);
      for (const [ref, data] of writes.slice(i, i + 400)) batch.set(ref, data);
      batch.commit().catch(e => console.error('동기화 실패', e));
    }
  }
  window.onSave = push;

  // ---------- 받기 ----------
  // 올리기(push)는 서버 값을 한 번 받은 뒤부터. 기기 캐시에만 있는 값(새 브라우저면 빈 값)을 보고 올리면
  // 계정의 카테고리를 이 기기의 기본 카테고리로 덮어씀 → fromCache 가 풀릴 때 알 수 있게 includeMetadataChanges
  const META_CHANGES = { includeMetadataChanges: true };
  function subscribe() {
    // 열 때마다 일정을 전부 받으면 일정 수만큼 읽기가 듦 → 지난번 이후 바뀐 것(syncedAt)만.
    // 처음이거나 일주일 지났으면 혹시 놓친 게 없게 전부 받기
    const st = db.sync || {};
    const all = !st.since || Date.now() - (st.full || 0) > 7 * 864e5;
    since = all ? 0 : st.since;
    full = all ? 0 : st.full;
    synced = all ? {} : { ...st.synced };
    const col = F.collection(fs, 'users', uid, 'items');
    // 10분 겹쳐 받기: syncedAt은 요청 시각이라 늦게 끝난 저장이 더 이른 시각을 가질 수 있음
    const q = all ? col : F.query(col, F.where('syncedAt', '>', F.Timestamp.fromMillis(since - 10 * 60e3)));
    unsub.push(F.onSnapshot(q, META_CHANGES, snap => {
      let changed = false;
      const before = since;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue; // 내가 막 올린 일정이 서버 시각을 받기 전에 잠깐 빠지는 것
        const { syncedAt, ...r } = ch.doc.data();
        if (syncedAt?.toMillis && !snap.metadata.fromCache && !ch.doc.metadata.hasPendingWrites) since = Math.max(since, syncedAt.toMillis());
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
      const first = !ready.items && !snap.metadata.fromCache;
      if (first) {
        ready.items = true;
        if (all) full = Date.now();
        if (!since) since = Date.now() - 864e5; // syncedAt 붙은 일정이 아직 하나도 없을 때 (이 기능 전에 올린 것들)
      }
      if (changed || first || since !== before) keep();
      if (changed) render();
      if (first) push();
    }, e => console.error('동기화 실패', e)));

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
  }

  // ---------- 로그인 / 로그아웃 ----------
  A.onAuthStateChanged(auth, user => {
    unsub.forEach(f => f());
    unsub = []; synced = {}; metaJSON = {}; ready = {};
    uid = user ? user.uid : null;
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
