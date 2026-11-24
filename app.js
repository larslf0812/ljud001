const ADMIN = window.MODE === 'admin', PER_PAGE = 10;
const app = document.getElementById('app');
let uploadMsg = '', files = [], q = '', page = 1, isAdmin = false, editing = null, current = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { t = Math.floor(t || 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const api = async (url, opt = {}) => { const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opt }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Fel'); return d; };
const safeLink = u => /^https?:\/\//i.test(u) ? u : '';

async function load() { files = await api('/api/files'); render(); }

function filtered() {
  const s = q.trim().toLowerCase();
  if (!s) return files;
  return files.filter(f => [f.file, f.title, f.author, f.narrator].some(v => (v || '').toLowerCase().includes(s)));
}

function render() {
  if (ADMIN && !isAdmin) return renderLogin();
  const list = filtered(), pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  page = Math.min(page, pages);
  const items = list.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const focus = document.activeElement && document.activeElement.id === 'q';
  app.innerHTML = `
    <header><h1>${ADMIN ? 'Ljudarkiv – redigering' : 'Ljudarkiv'}</h1>
      <div>${ADMIN ? '<a href="/">Publik sida</a> · <button id="logout">Logga ut</button>' : '<a href="/admin">Admin</a>'}</div></header>
    <input id="q" type="search" placeholder="Sök ljudfil, upphovsperson eller berättare…" value="${esc(q)}">
    ${ADMIN ? `<div class="ctrl"><button class="primary" id="upbtn">⬆ Ladda upp ljudfil</button><input type="file" id="upfile" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus" multiple hidden><span class="meta" id="upl">${esc(uploadMsg)}</span></div>` : ''}
    <p class="meta">${list.length} ljudfil(er)</p>
    ${items.map(card).join('') || '<p>Inga ljudfiler hittades.</p>'}
    <div class="pager"><button id="prev" ${page <= 1 ? 'disabled' : ''}>← Föregående</button><span>Sida ${page} av ${pages}</span><button id="next" ${page >= pages ? 'disabled' : ''}>Nästa →</button></div>`;
  const qi = document.getElementById('q');
  if (focus) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
  qi.oninput = e => { q = e.target.value; page = 1; render(); };
  document.getElementById('prev').onclick = () => { page--; render(); scrollTo(0, 0); };
  document.getElementById('next').onclick = () => { page++; render(); scrollTo(0, 0); };
  if (ADMIN) {
    const inp = document.getElementById('upfile');
    document.getElementById('upbtn').onclick = () => inp.click();
    inp.onchange = () => { uploadFiles([...inp.files]); inp.value = ''; };
  }
  if (ADMIN) document.getElementById('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); isAdmin = false; render(); };
  items.forEach(bind);
}

const idOf = f => 'c' + btoa(unescape(encodeURIComponent(f.file))).replace(/[^a-z0-9]/gi, '');

function card(f) {
  const id = idOf(f);
  if (editing === f.file) return editForm(f, id);
  const link = safeLink(f.link);
  return `<div class="card" id="${id}">
    ${f.image ? `<img class="thumb" src="${esc(f.image)}" alt="">` : '<div class="thumb"></div>'}
    <div class="main">
      <h2>${esc(f.title || f.file)}</h2>
      <div class="meta">${f.title ? esc(f.file) + '<br>' : ''}${f.author ? 'Upphov: ' + esc(f.author) : ''}${f.author && f.narrator ? ' · ' : ''}${f.narrator ? 'Berättare: ' + esc(f.narrator) : ''}</div>
      ${f.story ? `<div class="story">${esc(f.story)}</div>` : ''}
      ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a>` : ''}
      <div class="ctrl">
        <button data-a="play" title="Spela">▶ Spela</button><button data-a="pause" title="Pausa">⏸ Pausa</button>
        <button data-a="stop" title="Stopp">⏹ Stopp</button><button data-a="rew" title="Spola tillbaka 10 s">⏪ 10 s</button>
        <input type="range" data-a="seek" min="0" max="0" value="0" step="1" aria-label="Position"><span class="time">0:00 / 0:00</span>
      </div>
      ${ADMIN ? `<div class="ctrl"><button data-a="edit">✎ Redigera</button><span data-slot="del"><button data-a="del">🗑 Radera</button></span></div>` : ''}
      <audio preload="none" src="/audio/${encodeURIComponent(f.file)}"></audio>
    </div></div>`;
}

function editForm(f, id) {
  return `<div class="card" id="${id}"><div class="main">
    <h2>Redigera: ${esc(f.file)}</h2>
    <label>Ljudfilens namn</label><input data-f="title" value="${esc(f.title)}">
    <label>Berättelse</label><textarea data-f="story" rows="5">${esc(f.story)}</textarea>
    <label>Upphovsperson</label><input data-f="author" value="${esc(f.author)}">
    <label>Berättare</label><input data-f="narrator" value="${esc(f.narrator)}">
    <label>Länk (https://…)</label><input data-f="link" value="${esc(f.link)}">
    <label>Liten bild</label>
    <div class="ctrl"><img class="thumb" data-r="preview" ${f.image ? `src="${esc(f.image)}"` : ''} alt=""><input type="file" accept="image/*" data-r="file" style="width:auto"><button data-a="rmimg">Ta bort bild</button></div>
    <div class="ctrl"><button class="primary" data-a="save">Spara</button><button data-a="cancel">Avbryt</button></div>
  </div></div>`;
}

function bind(f) {
  const el = document.getElementById(idOf(f)); if (!el) return;
  if (editing === f.file) return bindEdit(f, el);
  const au = el.querySelector('audio'), seek = el.querySelector('[data-a=seek]'), time = el.querySelector('.time');
  const tick = () => { seek.max = au.duration || 0; seek.value = au.currentTime; time.textContent = fmt(au.currentTime) + ' / ' + fmt(au.duration); };
  au.ontimeupdate = au.onloadedmetadata = tick;
  au.onplay = () => { if (current && current !== au) current.pause(); current = au; };
  seek.oninput = () => { au.currentTime = seek.value; };
  const act = {
    play: () => au.play(), pause: () => au.pause(),
    stop: () => { au.pause(); au.currentTime = 0; tick(); },
    rew: () => { au.currentTime = Math.max(0, au.currentTime - 10); },
    edit: () => { editing = f.file; render(); },
    del: () => {
      const slot = el.querySelector('[data-slot=del]');
      slot.innerHTML = '<span class="confirm">Är du säker på att filen ska raderas? </span><button class="danger" data-a="yes">Ja, radera</button> <button data-a="no">Avbryt</button>';
      slot.querySelector('[data-a=yes]').onclick = async () => { try { au.pause(); await api('/api/files/' + encodeURIComponent(f.file), { method: 'DELETE' }); await load(); } catch (e) { alert(e.message); } };
      slot.querySelector('[data-a=no]').onclick = () => { slot.innerHTML = '<button data-a="del">🗑 Radera</button>'; slot.firstChild.onclick = act.del; };
    }
  };
  el.querySelectorAll('button[data-a]').forEach(b => { if (act[b.dataset.a]) b.onclick = act[b.dataset.a]; });
}

function bindEdit(f, el) {
  let image = f.image;
  const prev = el.querySelector('[data-r=preview]');
  el.querySelector('[data-r=file]').onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const img = new Image(); img.onload = () => {
      const s = 200 / Math.max(img.width, img.height, 200) , c = document.createElement('canvas');
      c.width = Math.round(img.width * Math.min(s, 1)); c.height = Math.round(img.height * Math.min(s, 1));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      image = c.toDataURL('image/jpeg', 0.8); prev.src = image;
    }; img.src = URL.createObjectURL(file);
  };
  el.querySelector('[data-a=rmimg]').onclick = () => { image = ''; prev.removeAttribute('src'); };
  el.querySelector('[data-a=cancel]').onclick = () => { editing = null; render(); };
  el.querySelector('[data-a=save]').onclick = async () => {
    const data = { image }; el.querySelectorAll('[data-f]').forEach(i => data[i.dataset.f] = i.value);
    try { await api('/api/files/' + encodeURIComponent(f.file), { method: 'PUT', body: JSON.stringify(data) }); editing = null; await load(); } catch (e) { alert(e.message); }
  };
}

const setMsg = m => { uploadMsg = m; const e = document.getElementById('upl'); if (e) e.textContent = m; };
function sendOne(file, label) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    x.upload.onprogress = e => { if (e.lengthComputable) setMsg(label + ' ' + Math.round(e.loaded / e.total * 100) + ' %'); };
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status === 200 ? ok() : no(new Error(d.error || 'Fel ' + x.status)); };
    x.onerror = () => no(new Error('Nätverksfel'));
    x.send(file);
  });
}
async function uploadFiles(list) {
  const errs = [];
  for (let i = 0; i < list.length; i++) {
    try { await sendOne(list[i], `Laddar upp ${list[i].name} (${i + 1}/${list.length})`); }
    catch (e) { errs.push(list[i].name + ': ' + e.message); }
  }
  await load();
  setMsg(errs.length ? 'Misslyckades – ' + errs.join('; ') : '✓ ' + list.length + ' fil(er) uppladdade');
}

function renderLogin() {
  app.innerHTML = `<div class="login"><h1>Logga in</h1>
    <label>Användarnamn</label><input id="u" autocomplete="username">
    <label>Lösenord</label><input id="p" type="password" autocomplete="current-password">
    <p class="err" id="err"></p><button class="primary" id="go">Logga in</button> <a href="/">Till publika sidan</a></div>`;
  const go = async () => {
    try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: u.value, password: p.value }) }); isAdmin = true; await load(); }
    catch (e) { document.getElementById('err').textContent = e.message; }
  };
  document.getElementById('go').onclick = go; p.onkeydown = e => { if (e.key === 'Enter') go(); };
}

(async () => { isAdmin = (await api('/api/me')).admin; if (!ADMIN || isAdmin) await load(); else render(); })();
