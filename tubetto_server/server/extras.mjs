/**
 * Tubetto Server — funzioni allineate all'app Android:
 * radio web (Radio Browser), testi (LRCLIB), import da Spotify, accesso con account (cookie per yt-dlp).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { searchMusic } from './yt.mjs';

const UA = 'Tubetto/1.3 (Home Assistant add-on)';
export const COOKIES = '/share/tubetto/cookies.txt';

// ------------------------------------------------------------------ Radio web

const RADIO_SERVERS = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info', 'https://de2.api.radio-browser.info'];

function radioItem(o) {
  const url = o.url_resolved || o.url;
  if (!url) return null;
  const tags = String(o.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 2);
  const where = o.state || o.country || '';
  const quality = [o.codec, o.bitrate ? o.bitrate + ' kbps' : ''].filter(Boolean).join(' ');
  return {
    id: 'radio:' + o.stationuuid,
    title: String(o.name || '').trim(),
    author: [where, ...tags, quality].filter(Boolean).join(' · '),
    duration: 'LIVE',
    kind: 'RADIO',
    url,
    thumb: /^https?:/.test(o.favicon || '') ? o.favicon : '',
  };
}

async function radioQuery(params) {
  let last;
  for (const s of RADIO_SERVERS) {
    try {
      const r = await fetch(`${s}/json/stations/search?hidebroken=true&${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const seen = new Set();
      return (await r.json()).map(radioItem).filter((x) => x && x.title && !seen.has(x.title.toLowerCase()) && seen.add(x.title.toLowerCase()));
    } catch (e) { last = e; }
  }
  throw new Error('Elenco radio non raggiungibile: ' + (last && last.message));
}

/** mode: top | state | tag | search */
export async function radio(q) {
  const enc = encodeURIComponent;
  const it = q.get('world') === '1' ? '' : 'countrycode=IT&';
  const order = 'order=clickcount&reverse=true';
  switch (q.get('mode')) {
    case 'state': return { items: await radioQuery(`countrycode=IT&state=${enc(q.get('q') || '')}&${order}&limit=30`) };
    case 'tag': return { items: await radioQuery(`${it}tag=${enc(q.get('q') || '')}&${order}&limit=30`) };
    case 'search': return { items: await radioQuery(`name=${enc(q.get('q') || '')}&${order}&limit=50`) };
    default: return { items: await radioQuery(`countrycode=IT&${order}&limit=40`) };
  }
}

export function radioClick(uuid) {
  fetch(`${RADIO_SERVERS[0]}/json/url/${encodeURIComponent(uuid)}`, { headers: { 'User-Agent': UA } }).catch(() => null);
}

// ------------------------------------------------------------------ Testi (LRCLIB)

export async function lyrics(q) {
  const title = (q.get('title') || '').trim();
  const artist = (q.get('artist') || '').trim();
  const dur = Number(q.get('dur')) || 0;
  const get = async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    return r.ok ? r.json() : null;
  };
  let o = null;
  if (artist) o = await get(`https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}${dur ? '&duration=' + dur : ''}`).catch(() => null);
  if (!o || (!o.syncedLyrics && !o.plainLyrics)) {
    const list = (await get(`https://lrclib.net/api/search?q=${encodeURIComponent((title + ' ' + artist).trim())}`).catch(() => null)) || [];
    o = list.filter((x) => !dur || Math.abs((x.duration || 0) - dur) <= 8).sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0))[0] || null;
  }
  if (!o) return { synced: [], plain: '' };
  if (o.instrumental) return { synced: [], plain: '♪ Brano strumentale' };
  const synced = [];
  for (const line of String(o.syncedLyrics || '').split('\n')) {
    const tags = [...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?]/g)];
    if (!tags.length) continue;
    const text = line.slice(tags[tags.length - 1].index + tags[tags.length - 1][0].length).trim();
    for (const m of tags) {
      const frac = m[3] || '';
      const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac.slice(0, 3) || 0);
      synced.push({ t: Number(m[1]) * 60 + Number(m[2]) + ms / 1000, text });
    }
  }
  synced.sort((a, b) => a.t - b.t);
  return { synced, plain: o.plainLyrics || '' };
}

// ------------------------------------------------------------------ Import da Spotify (pagina pubblica, senza chiavi)

const SPOTIFY_LINK = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:embed\/)?|spotify:)(playlist|album|track)[/:]([A-Za-z0-9]{10,})/;

function findEntity(node) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    if (node.trackList) return node;
    if (node.entity && (node.entity.trackList || node.entity.artists || node.entity.subtitle)) return node.entity;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = findEntity(v);
    if (f) return f;
  }
  return null;
}

const toSec = (s) => String(s || '').split(':').map(Number).reduce((a, x) => a * 60 + x, 0);

export async function spotify(q) {
  const m = SPOTIFY_LINK.exec(q.get('url') || '');
  if (!m) throw new Error('Non è un link Spotify');
  const r = await fetch(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'it-IT,it;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) throw new Error('Playlist non trovata o privata (rendila pubblica in Spotify)');
  if (!r.ok) throw new Error('Spotify ha risposto HTTP ' + r.status);
  const html = await r.text();
  const jm = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!jm) throw new Error('Spotify ha cambiato la pagina: dati non trovati');
  const ent = findEntity(JSON.parse(jm[1]));
  if (!ent) throw new Error('Nessun brano trovato');
  const name = ent.name || ent.title || 'Spotify';
  const raw = ent.trackList || [ent];
  const tracks = raw.map((t) => ({
    title: t.title || t.name || '',
    artist: (t.subtitle || (t.artists || []).map((a) => a.name).join(', ') || '').replace(/ /g, ' '),
    ms: t.duration > 10000 ? t.duration : (t.duration || 0) * 1000,
  })).filter((t) => t.title);
  const found = [];
  const missing = [];
  // 4 ricerche alla volta, mantenendo l'ordine
  for (let i = 0; i < tracks.length; i += 4) {
    const chunk = tracks.slice(i, i + 4);
    const res = await Promise.all(chunk.map(async (t) => {
      const list = (await searchMusic(`${t.title} ${t.artist.split(',')[0]}`).catch(() => [])).filter((x) => x.kind === 'VIDEO').slice(0, 6);
      if (!list.length) return null;
      if (!t.ms) return list[0];
      const near = (lim) => list.find((x) => Math.abs(toSec(x.duration) * 1000 - t.ms) <= lim);
      return near(15000) || near(45000) || list[0];
    }));
    res.forEach((v, j) => (v ? found.push(v) : missing.push(chunk[j])));
  }
  const seen = new Set();
  return { name, total: tracks.length, items: found.filter((v) => !seen.has(v.id) && seen.add(v.id)), missing };
}

// ------------------------------------------------------------------ Accesso con account (cookie per yt-dlp)

/** Da "a=b; c=d" (intestazione Cookie dell'app) al formato cookies.txt di yt-dlp. */
function headerToNetscape(header) {
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const lines = ['# Netscape HTTP Cookie File', '# Creato da Tubetto Server'];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', String(exp), name, value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export function accountStatus() {
  try {
    const txt = fs.readFileSync(COOKIES, 'utf8');
    return { loggedIn: /\t(SAPISID|__Secure-3PAPISID)\t/.test(txt), updated: fs.statSync(COOKIES).mtimeMs };
  } catch (e) {
    return { loggedIn: false };
  }
}

export function accountSave(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Cookie mancanti');
  const netscape = /\t/.test(t) ? (t.startsWith('#') ? t : '# Netscape HTTP Cookie File\n' + t) + '\n' : headerToNetscape(t);
  if (!/\t(SAPISID|__Secure-3PAPISID)\t/.test(netscape)) throw new Error('Nei cookie manca la sessione YouTube (SAPISID): accedi a youtube.com e riprova');
  fs.mkdirSync('/share/tubetto', { recursive: true });
  fs.writeFileSync(COOKIES, netscape, { mode: 0o600 });
}

export function accountLogout() {
  try { fs.unlinkSync(COOKIES); } catch (e) { /* già assente */ }
}

/** Accesso arrivato cifrato dall'app (sincronizzazione), con il codice scelto dall'utente. */
export function accountImport(blob, code) {
  if (!blob || !blob.data) throw new Error("Nessun accesso nella sincronizzazione: fai l'accesso dall'app e scegli \"Salva e invia\"");
  try {
    const salt = Buffer.from(blob.salt, 'base64');
    const iv = Buffer.from(blob.iv, 'base64');
    const data = Buffer.from(blob.data, 'base64');
    const key = crypto.pbkdf2Sync(String(code || ''), salt, 20000, 32, 'sha1');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8');
    if (!plain.trim()) { accountLogout(); return { loggedIn: false }; }
    accountSave(plain);
    return accountStatus();
  } catch (e) {
    if (/SAPISID/.test(e.message)) throw e;
    throw new Error('Codice sbagliato: deve essere uguale a quello scelto nell\'app');
  }
}
