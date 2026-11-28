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
const HOST = process.env.HOST || cfg.host || '0.0.0.0'; // sätt HOST=127.0.0.1 när servern ligger bakom nginx/Caddy
const EXT = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const CACHE = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1 };
if (!Object.keys(cfg.users || {}).length) console.warn('VARNING: inga användare konfigurerade – ingen kan logga in. Sätt ADMIN_USER och ADMIN_PASSWORD.');
const lastPlay = new Map(), THROTTLE = process.env.PLAY_THROTTLE_MS !== undefined ? +process.env.PLAY_THROTTLE_MS : 10000;
const QRlib = require('./public/qr.js');
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

// ---------- System: ZIP-skrivare, backup och export (endast administratör) ----------
const BACKUP_DIR = path.resolve(ROOT, process.env.BACKUP_DIR || cfg.backupDir || 'backups');
const BACKUP_KEEP = +(process.env.BACKUP_KEEP || cfg.backupKeep || 14), BACKUP_HOUR = +(process.env.BACKUP_HOUR || cfg.backupHour || 3);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const state = { last: null, autoDay: '' }; let busy = false;
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crcUp = (c, b) => { for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return c; };
const hashFile = f => new Promise((ok, no) => { let c = 0xffffffff, size = 0; const h = crypto.createHash('sha256');
  fs.createReadStream(f).on('data', b => { c = crcUp(c, b); h.update(b); size += b.length; }).on('end', () => ok({ crc: (c ^ 0xffffffff) >>> 0, size, sha: h.digest('hex') })).on('error', no); });

class Zip { // okomprimerad ZIP (store), strömmas till utfilen. Gräns 4 GB.
  constructor(out) { this.out = out; this.off = 0; this.list = []; const d = new Date(); this.t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); this.d = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); }
  async w(b) { this.off += b.length; if (this.off > 0xfffffff0) throw new Error('Arkivet är för stort för ZIP (över 4 GB)'); if (!this.out.write(b)) await new Promise(r => { this.out.once('drain', r); this.out.once('close', r); }); if (this.out.destroyed) throw new Error('Mottagaren avbröt'); }
  head(name, r) { const n = Buffer.from(name), h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8); h.writeUInt16LE(this.t, 10); h.writeUInt16LE(this.d, 12);
    h.writeUInt32LE(r.crc, 14); h.writeUInt32LE(r.size, 18); h.writeUInt32LE(r.size, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28); this.list.push({ n, r, o: this.off }); return Buffer.concat([h, n]); }
  async addBuffer(name, buf) { buf = Buffer.from(buf); const c = crcUp(0xffffffff, buf); const r = { crc: (c ^ 0xffffffff) >>> 0, size: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') }; await this.w(this.head(name, r)); await this.w(buf); return r; }
  async addFile(name, f) { const r = await hashFile(f); await this.w(this.head(name, r)); let n = 0; for await (const ch of fs.createReadStream(f)) { n += ch.length; await this.w(ch); } if (n !== r.size) throw new Error('Filen ändrades under körningen: ' + name); return r; }
  async finish() { const cd = []; for (const e of this.list) { const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(this.t, 12); c.writeUInt16LE(this.d, 14);
      c.writeUInt32LE(e.r.crc, 16); c.writeUInt32LE(e.r.size, 20); c.writeUInt32LE(e.r.size, 24); c.writeUInt16LE(e.n.length, 28); c.writeUInt32LE(e.o, 42); cd.push(c, e.n); }
    const cdb = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.list.length, 8); end.writeUInt16LE(this.list.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(this.off, 16); await this.w(cdb); await this.w(end); } }

const audioIn = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(f => f.isFile() && EXT[path.extname(f.name).toLowerCase()]).map(f => f.name) : [];
async function writeBackup(out) {
  const z = new Zip(out), files = [], add = async (n, f) => { const r = await z.addFile(n, f); files.push({ path: n, size: r.size, sha256: r.sha }); };
  for (const n of audioIn(AUDIO)) await add('audio/' + n, path.join(AUDIO, n));
  for (const n of audioIn(TRASH)) await add('audio/' + path.basename(TRASH) + '/' + n, path.join(TRASH, n));
  if (fs.existsSync(META)) await add('data/metadata.json', META);
  await z.addBuffer('manifest.json', JSON.stringify({ program: 'Ljudarkiv', manifestVersion: 1, created: new Date().toISOString(), fileCount: files.length, totalBytes: files.reduce((s, f) => s + f.size, 0), files }, null, 2));
  await z.finish(); await new Promise(r => out.end(r)); return files.length;
}
const listBackups = () => fs.readdirSync(BACKUP_DIR).filter(n => /^ljudarkiv-backup-[0-9-]+\.zip$/.test(n)).sort().reverse().map(n => { const s = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: s.size, at: s.mtime.toISOString() }; });
async function createBackup(kind = 'manual') {
  if (busy) return { ok: false, error: 'En annan körning pågår' };
  busy = true; const name = 'ljudarkiv-backup-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.zip', fin = path.join(BACKUP_DIR, name), tmp = fin + '.part';
  try {
    const n = await writeBackup(fs.createWriteStream(tmp)); fs.renameSync(tmp, fin);
    listBackups().slice(BACKUP_KEEP).forEach(b => fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true }));
    state.last = { ok: true, kind, name, files: n, size: fs.statSync(fin).size, at: new Date().toISOString() };
  } catch (e) { fs.rmSync(tmp, { force: true }); state.last = { ok: false, kind, error: e.message, at: new Date().toISOString() }; console.error('Backup misslyckades:', e.message); }
  finally { busy = false; } return state.last;
}
function systemStatus() { let free = null; try { const s = fs.statfsSync(BACKUP_DIR); free = s.bavail * s.bsize; } catch {}
  return { backups: listBackups(), last: state.last, busy, keep: BACKUP_KEEP, hour: BACKUP_HOUR, auto: process.env.BACKUP_AUTO !== '0', free, dir: BACKUP_DIR }; }
if (process.env.BACKUP_AUTO !== '0') setInterval(() => { const d = new Date(), day = d.toISOString().slice(0, 10); if (d.getHours() === BACKUP_HOUR && state.autoDay !== day && !busy) { state.autoDay = day; createBackup('auto'); } }, 60000).unref();

const slug = s => String(s || '').toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'post';
const csv = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
async function writeExport(out, o) {
  const z = new Zip(out), posts = listFiles(), reg = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i], ext = path.extname(p.file).toLowerCase(), mapp = 'poster/' + String(i + 1).padStart(4, '0') + '-' + slug(p.title || path.basename(p.file, ext)), im = /^data:image\/(jpeg|png|gif|webp);base64,(.+)$/.exec(p.image || '');
    await z.addFile(mapp + '/ljud' + ext, path.join(AUDIO, p.file));
    const bild = im ? 'bild.' + (im[1] === 'jpeg' ? 'jpg' : im[1]) : ''; if (im) await z.addBuffer(mapp + '/' + bild, Buffer.from(im[2], 'base64'));
    const post = { nr: i + 1, mapp, titel: p.title, filnamn: p.file, ljud: 'ljud' + ext, bild, upphovsperson: p.author, berattare: p.narrator, lank: p.link, tillagd: p.created, spelad: p.plays || 0, berattelse: p.story };
    reg.push(post);
    await z.addBuffer(mapp + '/metadata.json', JSON.stringify(post, null, 2));
    await z.addBuffer(mapp + '/berattelse.md', '# ' + (p.title || p.file) + '\n\n' + [p.author && '**Upphovsperson:** ' + p.author, p.narrator && '**Berättare:** ' + p.narrator, p.link && '**Länk:** ' + p.link, '**Tillagd:** ' + (p.created || '').slice(0, 10), '**Spelad:** ' + (p.plays || 0) + ' gånger'].filter(Boolean).join('  \n') + '\n\n' + (p.story || '') + '\n');
    if (o.qr) { try { await z.addBuffer(mapp + '/qr.svg', QRlib.toSVG(QRlib.make(o.base + '/?fil=' + encodeURIComponent(p.file)))); } catch {} }
  }
  if (o.deleted) for (const n of audioIn(TRASH)) await z.addFile('raderade/' + n, path.join(TRASH, n));
  const now = new Date().toISOString();
  await z.addBuffer('register.json', JSON.stringify({ schema: 1, program: 'Ljudarkiv', skapad: now, antal: reg.length, poster: reg }, null, 2));
  const cols = ['nr', 'mapp', 'titel', 'filnamn', 'upphovsperson', 'berattare', 'lank', 'tillagd', 'spelad', 'berattelse'];
  await z.addBuffer('register.csv', '\ufeff' + cols.join(';') + '\r\n' + reg.map(r => cols.map(c => csv(r[c])).join(';')).join('\r\n') + '\r\n');
  await z.addBuffer('LASMIG.txt', 'LJUDARKIV – EXPORT\nSkapad: ' + now + '\nAntal poster: ' + reg.length + '\n\nINNEHÅLL\n  index.html     Öppna i webbläsare: sök och spela upp utan server\n  register.csv   Alla poster (semikolonavgränsad, öppnas i Excel)\n  register.json  Alla poster med fullständig data (schemaversion 1)\n  poster/        En mapp per post: ljud, bild, berattelse.md, metadata.json' + (o.qr ? ', qr.svg' : '') + '\n' + (o.deleted ? '  raderade/      Filer som raderats ur arkivet\n' : '') + '\nDatan kan läsas utan Ljudarkivet.\n');
  const data = JSON.stringify({ poster: reg }).replace(/</g, '\\u003c');
  await z.addBuffer('index.html', '<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ljudarkiv – export</title><style>body{font:16px system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px}.p{border:1px solid #ccc;border-radius:10px;padding:12px;margin:10px 0;overflow:hidden}img{float:left;width:72px;height:72px;object-fit:cover;margin-right:12px;border-radius:6px}input{width:100%;padding:8px;font:inherit;box-sizing:border-box}small{color:#555}audio{width:100%;margin-top:8px}</style><h1>Ljudarkiv</h1><input id="q" placeholder="Sök titel, upphovsperson, berättare…"><div id="l"></div><script id="d" type="application/json">' + data + '</script><script>var D=JSON.parse(document.getElementById("d").textContent),q=document.getElementById("q"),l=document.getElementById("l");function e(s){return String(s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]})}function r(){var s=q.value.toLowerCase();l.innerHTML=D.poster.filter(function(p){return[p.titel,p.filnamn,p.upphovsperson,p.berattare].join(" ").toLowerCase().indexOf(s)>-1}).map(function(p){return\'<div class="p">\'+(p.bild?\'<img src="\'+e(p.mapp+"/"+p.bild)+\'" alt="">\':"")+"<b>"+e(p.titel||p.filnamn)+"</b><br><small>"+e(p.upphovsperson)+(p.berattare?" · "+e(p.berattare):"")+"</small><p>"+e(p.berattelse)+\'</p><audio controls preload="none" src="\'+e(p.mapp+"/"+p.ljud)+\'"></audio></div>\'}).join("")||"Inga träffar"}q.oninput=r;r()</script></html>');
  await z.finish(); await new Promise(r => out.end(r));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/files' && req.method === 'GET') return json(res, 200, listFiles());
    if (p === '/api/me') { const s = user(req); return json(res, 200, { admin: !!s, role: s ? s.role : '', user: s ? s.user : '' }); }
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await body(req);
      const rec = (cfg.users || {})[username], expected = rec && (typeof rec === 'string' ? rec : rec.password);
      const ok = expected && crypto.timingSafeEqual(crypto.createHash('sha256').update(String(password)).digest(), crypto.createHash('sha256').update(String(expected)).digest());
      if (!ok) return json(res, 401, { error: 'Fel användarnamn eller lösenord' });
      const t = crypto.randomBytes(24).toString('hex'); const role = rec && typeof rec === 'object' && rec.role ? (/^admin/i.test(rec.role) ? 'admin' : 'redigerare') : (username === process.env.ADMIN_USER || username === 'admin' ? 'admin' : 'redigerare'); sessions.set(t, { user: username, role });
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

    if (p.startsWith('/api/system/')) {
      const s = user(req); if (!s) return json(res, 401, { error: 'Inte inloggad' });
      if (s.role !== 'admin') return json(res, 403, { error: 'Kräver administratör' });
      const sub = p.slice(12);
      if (sub === 'status' && req.method === 'GET') return json(res, 200, systemStatus());
      if (sub === 'backup' && req.method === 'POST') return json(res, 200, await createBackup());
      if (sub === 'export' && req.method === 'GET') {
        if (busy) return json(res, 409, { error: 'En annan körning pågår' });
        busy = true; const base = (cfg.publicUrl || process.env.PUBLIC_URL || ((req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')) + '://' + (req.headers['x-forwarded-host'] || req.headers.host))).replace(/\/$/, '');
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="ljudarkiv-export-${new Date().toISOString().slice(0, 10)}.zip"` });
        try { await writeExport(res, { deleted: url.searchParams.get('deleted') === '1', qr: url.searchParams.get('qr') !== '0', base }); } catch (e) { console.error('Export misslyckades:', e.message); res.destroy(); } finally { busy = false; }
        return;
      }
      const bm = /^backups\/(ljudarkiv-backup-[0-9-]+\.zip)$/.exec(sub);
      if (bm) {
        const f = path.join(BACKUP_DIR, bm[1]); if (!fs.existsSync(f)) return json(res, 404, { error: 'Backupen finns inte' });
        if (req.method === 'DELETE') { fs.unlinkSync(f); return json(res, 200, { ok: true }); }
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(f).size, 'Content-Disposition': `attachment; filename="${bm[1]}"` }); return fs.createReadStream(f).pipe(res);
      }
      return json(res, 404, { error: 'Hittas inte' });
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
}).listen(PORT, HOST, () => console.log(`Ljudarkiv lyssnar på ${HOST}:${PORT}  –  publik sida http://localhost:${PORT}/  –  admin http://localhost:${PORT}/admin`));
