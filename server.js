// Ljudarkiv – server utan externa beroenden. Starta: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = __dirname;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
// Miljövariabler (t.ex. på Render) har företräde framför config.json
if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) cfg.users = { ...(cfg.users || {}), [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD };
const AUDIO = path.resolve(ROOT, process.env.AUDIO_DIR || cfg.audioDir || 'audio');
const TRASH = path.join(AUDIO, cfg.deletedDir || 'raderade');
const META = path.join(path.resolve(ROOT, process.env.DATA_DIR || 'data'), 'metadata.json');
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT || cfg.port || 3000;
const EXT = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const CACHE = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1 };
if (!Object.keys(cfg.users || {}).length) console.warn('VARNING: inga användare konfigurerade – ingen kan logga in. Sätt ADMIN_USER och ADMIN_PASSWORD.');
const lastPlay = new Map(), THROTTLE = process.env.PLAY_THROTTLE_MS !== undefined ? +process.env.PLAY_THROTTLE_MS : 10000;
const sessions = new Map(); // token -> användarnamn
fs.mkdirSync(TRASH, { recursive: true });
fs.mkdirSync(path.dirname(META), { recursive: true });

const readMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return {}; } };
const writeMeta = m => { fs.writeFileSync(META + '.tmp', JSON.stringify(m, null, 2)); fs.renameSync(META + '.tmp', META); };
const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1.5e6) { req.destroy(); no(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { no(); } }); });
const user = req => { const m = /(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m && sessions.get(m[1]); };
const safeName = n => { n = path.basename(String(n)); return EXT[path.extname(n).toLowerCase()] && fs.existsSync(path.join(AUDIO, n)) ? n : null; };
const str = (v, max) => String(v || '').slice(0, max);

function listFiles() {
  const meta = readMeta(); let dirty = false;
  const out = fs.readdirSync(AUDIO, { withFileTypes: true })
    .filter(f => f.isFile() && EXT[path.extname(f.name).toLowerCase()])
    .map(f => {
      const e = meta[f.name] || (meta[f.name] = {});
      if (!e.created) { e.created = new Date().toISOString(); dirty = true; } // datum då posten först skapades
      return { file: f.name, title: '', story: '', author: '', narrator: '', image: '', link: '', plays: 0, ...e };
    })
    .sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file, 'sv'));
  if (dirty) writeMeta(meta);
  return out;
}

function serveAudio(req, res, name) {
  const file = path.join(AUDIO, name), size = fs.statSync(file).size, type = EXT[path.extname(name).toLowerCase()];
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' }); return fs.createReadStream(file).pipe(res); }
  let s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : size - 1;
  if (!m[1] && m[2]) { s = Math.max(0, size - +m[2]); e = size - 1; }
  if (s >= size || e >= size) e = size - 1;
  res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file, { start: s, end: e }).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/files' && req.method === 'GET') return json(res, 200, listFiles());
    if (p === '/api/me') return json(res, 200, { admin: !!user(req) });
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await body(req);
      const expected = (cfg.users || {})[username];
      const ok = expected && crypto.timingSafeEqual(crypto.createHash('sha256').update(String(password)).digest(), crypto.createHash('sha256').update(String(expected)).digest());
      if (!ok) return json(res, 401, { error: 'Fel användarnamn eller lösenord' });
      const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, username);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (p.startsWith('/audio/')) { const n = safeName(p.slice(7)); if (!n) return json(res, 404, { error: 'Hittas inte' }); return serveAudio(req, res, n); }

    if (p === '/api/upload' && req.method === 'POST') {
      if (!user(req)) return json(res, 401, { error: 'Inte inloggad' });
      let n = path.basename(url.searchParams.get('name') || '').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^\.+/, '');
      const ext = path.extname(n).toLowerCase();
      if (!n || !EXT[ext]) return json(res, 400, { error: 'Filtypen stöds inte (mp3, wav, ogg, m4a, aac, flac, opus)' });
      const max = (+process.env.MAX_UPLOAD_MB || cfg.maxUploadMb || 200) * 1048576;
      if (+req.headers['content-length'] > max) return json(res, 413, { error: 'Filen är för stor' });
      let dest = path.join(AUDIO, n);
      if (fs.existsSync(dest)) dest = path.join(AUDIO, path.basename(n, ext) + '_' + Date.now() + ext);
      const tmp = dest + '.part';
      return new Promise(resolve => {
        const out = fs.createWriteStream(tmp); let size = 0, failed = false;
        const fail = (code, msg) => { if (failed) return; failed = true; req.unpipe(out); out.destroy(); fs.rm(tmp, { force: true }, () => {}); if (!res.headersSent) json(res, code, { error: msg }); req.resume(); resolve(); };
        req.on('data', c => { size += c.length; if (size > max) fail(413, 'Filen är för stor'); });
        req.on('error', () => fail(400, 'Uppladdningen avbröts'));
        req.on('aborted', () => fail(400, 'Uppladdningen avbröts'));
        out.on('error', () => fail(500, 'Kunde inte spara filen'));
        out.on('finish', () => { if (failed) return; fs.renameSync(tmp, dest); { const mm = readMeta(); mm[path.basename(dest)] = { created: new Date().toISOString(), plays: 0 }; writeMeta(mm); } json(res, 200, { ok: true, file: path.basename(dest) }); resolve(); });
        req.pipe(out);
      });
    }

    if (p.startsWith('/api/played/') && req.method === 'POST') {
      const n = safeName(p.slice(12)); if (!n) return json(res, 404, { error: 'Filen finns inte' });
      const m = readMeta(), e = m[n] || (m[n] = {});
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress, key = ip + '|' + n, now = Date.now();
      if (!(now - (lastPlay.get(key) || 0) < THROTTLE)) {
        e.plays = (e.plays || 0) + 1; if (!e.created) e.created = new Date().toISOString();
        writeMeta(m); lastPlay.set(key, now); if (lastPlay.size > 5000) lastPlay.clear();
      }
      return json(res, 200, { plays: e.plays || 0 });
    }

    if (p.startsWith('/api/files/') && (req.method === 'PUT' || req.method === 'DELETE')) {
      if (!user(req)) return json(res, 401, { error: 'Inte inloggad' });
      const n = safeName(p.slice(11)); if (!n) return json(res, 404, { error: 'Filen finns inte' });
      if (req.method === 'PUT') {
        const b = await body(req), m = readMeta();
        const img = str(b.image, 400000);
        m[n] = { ...(m[n] || {}), title: str(b.title, 200), story: str(b.story, 20000), author: str(b.author, 200), narrator: str(b.narrator, 200), image: img.startsWith('data:image/') ? img : '', link: str(b.link, 500) };
        writeMeta(m); return json(res, 200, { ok: true });
      }
      let dest = path.join(TRASH, n);
      if (fs.existsSync(dest)) dest = path.join(TRASH, Date.now() + '_' + n);
      fs.renameSync(path.join(AUDIO, n), dest);
      return json(res, 200, { ok: true });
    }

    // Statiska sidor
    const clean = p.length > 1 ? p.replace(/\/+$/, '') : p;
    const page = clean === '/' || clean === '/index' ? 'index.html' : clean === '/admin' ? 'admin.html' : clean.slice(1);
    const f = path.join(PUBLIC, path.basename(page));
    if (STATIC[path.extname(f)] && fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': STATIC[path.extname(f)], ...(CACHE[path.extname(f)] ? { 'Cache-Control': 'public, max-age=86400' } : {}) }); return fs.createReadStream(f).pipe(res); }
    if (STATIC[path.extname(f)]) console.error('Saknar fil: ' + f + ' (kontrollera att mappen public/ finns i repot)');
    json(res, 404, { error: 'Hittas inte' });
  } catch (e) { json(res, 400, { error: 'Felaktig förfrågan' }); }
}).listen(PORT, () => console.log(`Ljudarkiv: publik sida http://localhost:${PORT}/  –  admin http://localhost:${PORT}/admin`));
