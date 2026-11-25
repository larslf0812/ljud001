// Minimal QR-generator (byte-läge, felrättning M, version 1–10 ≈ upp till 213 tecken). Inga beroenden.
(function (root) {
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsEnc(data, n) {
    let g = [1];
    for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; }
    const res = new Array(n).fill(0);
    for (const d of data) { const f = d ^ res.shift(); res.push(0); if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f); }
    return res;
  }
  // version: [ecc-ord per block, [[antal block, dataord per block], ...]]  (nivå M)
  const T = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
  const AP = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  function make(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let v = 0, dataCw = 0;
    for (let i = 1; i <= 10; i++) {
      const d = T[i][1].reduce((s, b) => s + b[0] * b[1], 0);
      if (4 + (i < 10 ? 8 : 16) + bytes.length * 8 <= d * 8) { v = i; dataCw = d; break; }
    }
    if (!v) throw new Error('Länken är för lång för QR-koden');
    const bits = [], push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => push(b, 8));
    push(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; cw.length < dataCw; pad ^= 0xec ^ 0x11) cw.push(pad);

    const ec = T[v][0], blocks = []; let pos = 0;
    for (const [cnt, len] of T[v][1]) for (let k = 0; k < cnt; k++) { const d = cw.slice(pos, pos + len); pos += len; blocks.push({ d, e: rsEnc(d, ec) }); }
    const out = [], maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) blocks.forEach(b => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < ec; i++) blocks.forEach(b => out.push(b.e[i]));

    const size = 17 + 4 * v;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (mat, r, c, val, mark) => { mat[r][c] = !!val; if (mark) fn[r][c] = true; };
    const finder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr, c = c0 + dc; if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inb = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        setFn(m, r, c, inb && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)), true);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { setFn(m, 6, i, i % 2 === 0, true); setFn(m, i, 6, i % 2 === 0, true); }
    const ap = AP[v];
    for (const r of ap) for (const c of ap) {
      if ((r === ap[0] && c === ap[0]) || (r === ap[0] && c === ap[ap.length - 1]) || (r === ap[ap.length - 1] && c === ap[0])) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) setFn(m, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1, true);
    }
    const drawFormat = (mat, mask, mark) => {
      const data = (0 << 3) | mask; let rem = data; // nivå M = 00
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const f = ((data << 10) | rem) ^ 0x5412, bit = i => (f >>> i) & 1;
      for (let i = 0; i <= 5; i++) setFn(mat, i, 8, bit(i), mark);
      setFn(mat, 7, 8, bit(6), mark); setFn(mat, 8, 8, bit(7), mark); setFn(mat, 8, 7, bit(8), mark);
      for (let i = 9; i < 15; i++) setFn(mat, 8, 14 - i, bit(i), mark);
      for (let i = 0; i < 8; i++) setFn(mat, 8, size - 1 - i, bit(i), mark);
      for (let i = 8; i < 15; i++) setFn(mat, size - 15 + i, 8, bit(i), mark);
      setFn(mat, size - 8, 8, true, mark);
    };
    drawFormat(m, 0, true);
    if (v >= 7) {
      let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vb = (v << 12) | rem;
      for (let i = 0; i < 18; i++) { const b = (vb >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); setFn(m, a, c, b, true); setFn(m, c, a, b, true); }
    }
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && k < out.length * 8) { m[y][x] = ((out[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }
    const cond = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    function penalty(mm) {
      let p = 0;
      for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
        let run = 1, s = '';
        for (let b = 0; b < size; b++) {
          const c = pass ? mm[b][a] : mm[a][b]; s += c ? '1' : '0';
          if (b > 0) { const pc = pass ? mm[b - 1][a] : mm[a][b - 1]; if (c === pc) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
        }
        for (const pat of ['10111010000', '00001011101']) { let i = -1; while ((i = s.indexOf(pat, i + 1)) >= 0) p += 40; }
      }
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (mm[y][x]) dark++;
        if (y < size - 1 && x < size - 1 && mm[y][x] === mm[y][x + 1] && mm[y][x] === mm[y + 1][x] && mm[y][x] === mm[y + 1][x + 1]) p += 3;
      }
      return p + Math.max(0, Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
    }
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const mm = m.map(r => r.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && cond[mask](x, y)) mm[y][x] = !mm[y][x];
      drawFormat(mm, mask, false);
      const p = penalty(mm); if (p < bestP) { bestP = p; best = mm; }
    }
    return best; // 2D-array av true/false (true = mörk modul)
  }

  function toSVG(mat, quiet = 4) {
    const n = mat.length + quiet * 2; let d = '';
    mat.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  function toPNG(mat, scale = 10, quiet = 4) {
    const n = (mat.length + quiet * 2) * scale, c = document.createElement('canvas'); c.width = c.height = n;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, n, n); g.fillStyle = '#000';
    mat.forEach((row, y) => row.forEach((on, x) => { if (on) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale); }));
    return c.toDataURL('image/png');
  }
  root.QR = { make, toSVG, toPNG };
  if (typeof module !== 'undefined') module.exports = root.QR;
})(typeof window !== 'undefined' ? window : globalThis);
