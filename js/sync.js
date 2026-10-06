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
        writes.push([F.doc(fs, 'users', uid, 'items', it.id), clean(it)]);
        synced[it.id] = it.updatedAt;
      }
    }
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
    unsub.push(F.onSnapshot(F.collection(fs, 'users', uid, 'items'), META_CHANGES, snap => {
      let changed = false;
      for (const ch of snap.docChanges()) {
        const r = ch.doc.data();
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
      if (changed) { persist(); render(); }
      if (!ready.items && !snap.metadata.fromCache) { ready.items = true; push(); }
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
      persist();
      render();
    }
    subscribe();
  });
}
