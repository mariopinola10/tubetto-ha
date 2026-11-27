/**
 * Tubetto Server — add-on Home Assistant.
 *  - interfaccia web (pannello laterale di HA, anche via Tailscale) senza pubblicità;
 *  - stream audio/video dal Raspberry (/stream, /video) per il browser e per Music Assistant;
 *  - API di ricerca (stesse operazioni del Worker di Tubetto Web);
 *  - "Suona in casa" verso i player di Music Assistant.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { OPS, TTL, related, dedupeSongs, setWebClients } from './yt.mjs';
import { resolve, applyConfig, getStats, setQuality, reportBroken, prefetch } from './resolver.mjs';
import * as house from './house.mjs';
import * as extras from './extras.mjs';

const VERSION = '1.5.3';
const PORT = 8099; // 8095 è di Music Assistant
const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../web');
const DATA = fs.existsSync('/data') ? '/data' : path.resolve('./data');

// ------------------------------------------------------------------ opzioni

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

const options = readJson(path.join(DATA, 'options.json'), {});
const state = readJson(path.join(DATA, 'tubetto.json'), {});
if (!state.secret) state.secret = crypto.randomBytes(24).toString('hex');
if (!state.key) state.key = crypto.randomBytes(9).toString('base64url');
try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'tubetto.json'), JSON.stringify(state)); } catch (e) { /* sola lettura */ }

const API_KEY = (options.api_key || '').trim() || state.key;
const REPO = (options.github_repo || 'mariopinola10/Tubetto').trim();
const TOKEN = (options.github_token || '').trim();
const STREAM_BASE = (options.stream_base_url || '').trim().replace(/\/+$/, '') || `http://${process.env.HOSTNAME || 'localhost'}:${PORT}`;
setQuality(options.audio_quality || 'high');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const sign = (id) => crypto.createHmac('sha256', state.secret).update(id).digest('hex').slice(0, 20);

// ------------------------------------------------------------------ configurazione remota

let configInfo = 'integrata';

async function refreshConfig() {
  if (!TOKEN) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/config/tubetto-config.json`, {
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const cfg = await r.json();
    if (applyConfig(cfg)) {
      setWebClients(cfg);
      if (configInfo !== cfg.updated) log('[config] client aggiornati:', cfg.updated);
      configInfo = cfg.updated || 'remota';
    }
  } catch (e) {
    log('[config] non letta:', e.message);
  }
}

function updateYtdlp() {
  execFile('/opt/ytdlp/bin/pip', ['install', '-q', '-U', 'yt-dlp[default]', 'bgutil-ytdlp-pot-provider'], { timeout: 300000 }, (err) => {
    log(err ? '[yt-dlp] aggiornamento non riuscito' : '[yt-dlp] aggiornato');
  });
}

// ------------------------------------------------------------------ utilità HTTP

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, status, data) {
  const b = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(b);
}

function readBody(req) {
  return new Promise((ok, ko) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ko(new Error('JSON non valido')); } });
    req.on('error', ko);
  });
}

/** Richiesta dal pannello di Home Assistant (ingress): già autenticata da HA. */
function fromIngress(req) {
  const ip = req.socket.remoteAddress || '';
  return ip.endsWith('172.30.32.2') || ip === '127.0.0.1' || ip === '::1';
}

function authorized(req, url) {
  return fromIngress(req) || req.headers['x-tubetto-key'] === API_KEY || url.searchParams.get('key') === API_KEY;
}

function serveStatic(req, res, p) {
  let file = path.normalize(path.join(WEB, p === '/' ? 'index.html' : p));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Non trovato'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': p === '/' || p.endsWith('.html') ? 'no-cache' : 'max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ------------------------------------------------------------------ proxy degli stream

function waitDrain(res) {
  return new Promise((ok) => {
    const done = () => { res.off('drain', done); res.off('close', done); ok(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** Stream HLS convertito da ffmpeg in un flusso continuo (AAC per l'audio, MP4 frammentato per il video). */
function proxyHls(req, res, src, kind, startAt) {
  const headers = {
    'Content-Type': kind === 'video' ? 'video/mp4' : 'audio/aac',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Tubetto-Duration, X-Tubetto-Offset',
    'X-Tubetto-Duration': String(src.lengthSeconds || 0),
    'X-Tubetto-Offset': String(startAt || 0),
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const args = ['-nostdin', '-loglevel', 'error', '-user_agent', src.ua, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  if (startAt > 0) args.push('-ss', String(startAt));
  args.push('-i', src.url);
  if (kind === 'video' && src.audioUrl) {
    // video e audio in due flussi separati: li unisco
    if (startAt > 0) args.push('-ss', String(startAt));
    args.push('-user_agent', src.ua, '-reconnect', '1', '-reconnect_streamed', '1', '-i', src.audioUrl, '-map', '0:v:0', '-map', '1:a:0');
  }
  if (kind === 'video') args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  else args.push('-vn', '-c:a', 'copy', '-f', 'adts', 'pipe:1');
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
  ff.on('close', (code) => {
    if (code && !res.destroyed) log('[stream] ffmpeg terminato con codice', code, err.trim().split('\n').pop());
    res.end();
  });
}

/** Radio web: inoltra lo stream (anche http, che il pannello in https non potrebbe aprire); HLS convertito da ffmpeg. */
async function proxyRadio(req, res, url) {
  if (!/^https?:\/\//.test(url)) return sendJson(res, 400, { error: 'Indirizzo radio non valido' });
  if (/\.m3u8($|\?)/i.test(url)) {
    res.writeHead(200, { 'Content-Type': 'audio/aac', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    if (req.method === 'HEAD') return res.end();
    const ff = spawn('ffmpeg', ['-nostdin', '-loglevel', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-i', url, '-vn', '-c:a', 'aac', '-b:a', '160k', '-f', 'adts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill('SIGKILL'));
    ff.on('close', () => res.end());
    return;
  }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Tubetto', 'Icy-MetaData': '0' }, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    return sendJson(res, 502, { error: 'Radio non raggiungibile: ' + e.message });
  }
  if (!r.ok || !r.body) return sendJson(res, 502, { error: 'Radio non raggiungibile (HTTP ' + r.status + ')' });
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'audio/mpeg', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  if (req.method === 'HEAD') return res.end();
  try {
    for await (const chunk of r.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await waitDrain(res);
    }
  } catch (e) { /* chiuso */ }
  res.end();
}

/** Video da due flussi YouTube separati (video H.264 + audio), uniti da ffmpeg in un MP4 continuo. */
function proxyMerged(req, res, videoId, startAt) {
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'Access-Control-Allow-Origin': '*' });
  if (req.method === 'HEAD') return res.end();
  const k = sign(videoId);
  const local = (kind) => `http://127.0.0.1:${PORT}/${kind}/${videoId}?k=${k}`;
  const ss = startAt > 0 ? ['-ss', String(startAt)] : [];
  const args = ['-nostdin', '-loglevel', 'error', ...ss, '-i', local('vraw'), ...ss, '-i', local('stream'),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  ff.stdout.pipe(res);
  res.on('close', () => ff.kill('SIGKILL'));
  ff.on('close', (code) => {
    if (code && !res.destroyed) log('[stream] unione video+audio terminata con codice', code, err.trim().split('\n').pop());
    res.end();
  });
}

/** Il video si può mostrare? (stream unico o video H.264 da unire all'audio) */
export async function videoPlayable(videoId) {
  try { await resolve(videoId, 'video', false); return true; } catch (e) { /* provo i flussi separati */ }
  try { await resolve(videoId, 'vonly', false); return true; } catch (e) { return false; }
}

async function proxy(req, res, videoId, kind, startAt = 0) {
  let src;
  try {
    src = await resolve(videoId, kind, false);
  } catch (e) {
    if (kind === 'video') {
      // niente stream unico: unisco video H.264 e audio
      try { const v = await resolve(videoId, 'vonly', false); log('[video]', videoId, 'video+audio separati via', v.via, 'itag', v.itag); return proxyMerged(req, res, videoId, startAt); } catch (e2) { /* niente */ }
      return sendJson(res, 404, { error: 'Video non disponibile: ' + e.message });
    }
    return sendJson(res, 502, { error: e.message });
  }
  if (kind === 'video') log('[video]', videoId, src.hls ? 'HLS' : 'diretto', 'via', src.via, src.itag ? 'itag ' + src.itag : '', src.audioUrl ? '(audio separato)' : '');
  if (src.hls) return proxyHls(req, res, src, kind, startAt);
  const total = src.clen;
  let start = 0, end = total - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    status = 206;
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, total - Number(m[2])); }
    else {
      start = Number(m[1] || 0);
      if (m[2] !== '') end = Math.min(Number(m[2]), total - 1);
    }
  }
  if (start >= total || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  // video: controllo il primo pezzo PRIMA di rispondere. Se YouTube rifiuta il link diretto
  // (risposta vuota = schermo nero) passo a video+audio separati uniti da ffmpeg.
  let first = null;
  if (kind === 'video' && req.method !== 'HEAD') {
    try {
      first = await fetch(`${src.url}&range=${start}-${Math.min(start + 1024 * 1024 - 1, end)}`, { headers: { 'User-Agent': src.ua }, signal: AbortSignal.timeout(15000) });
    } catch (e) { first = null; }
    if (!first || !first.ok) {
      if (first) await first.arrayBuffer().catch(() => null);
      log('[video]', videoId, 'link diretto rifiutato', first ? 'HTTP ' + first.status : '', ': unisco video e audio separati');
      reportBroken(videoId, 'video', src.via);
      try { await resolve(videoId, 'vonly', false); return proxyMerged(req, res, videoId, startAt); } catch (e) {
        return sendJson(res, 404, { error: 'Video non disponibile: ' + e.message });
      }
    }
  }
  const headers = {
    'Content-Type': src.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Tubetto-Duration': String(src.lengthSeconds || 0),
  };
  // per i lettori DLNA delle TV: si può saltare avanti e indietro
  if (kind === 'video') Object.assign(headers, { 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' });
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const CHUNK = 1024 * 1024;
  let pos = start;
  let retries = 0;
  while (pos <= end && !res.destroyed) {
    const to = Math.min(pos + CHUNK - 1, end);
    let r;
    if (first) { r = first; first = null; } else try {
      r = await fetch(`${src.url}&range=${pos}-${to}`, { headers: { 'User-Agent': src.ua }, signal: ac.signal });
    } catch (e) {
      break;
    }
    if (!r.ok) {
      await r.arrayBuffer().catch(() => null);
      // link interrotto: escludo quel client e riprendo dallo stesso punto con un altro
      reportBroken(videoId, kind, src.via);
      if (++retries > 3) { log('[stream] interrotto', videoId, 'HTTP', r.status, 'via', src.via); break; }
      try { src = await resolve(videoId, kind, true, src.itag); } catch (e) { log('[stream] nessun altro metodo per', videoId, e.message); break; }
      if (src.hls) { log('[stream] il resto del brano', videoId, 'arriva solo in HLS: ricarica per continuare'); break; }
      if (src.clen !== total) { log('[stream] formato diverso da', src.via, ', interrompo', videoId); break; }
      log('[stream] riprendo', videoId, 'da', pos, 'via', src.via);
      continue;
    }
    retries = 0;
    try {
      for await (const chunk of r.body) {
        if (res.destroyed) break;
        pos += chunk.length;
        if (!res.write(chunk)) await waitDrain(res);
      }
    } catch (e) {
      break;
    }
  }
  res.end();
}

// ------------------------------------------------------------------ cache API

const apiCache = new Map();
const EXTRA_OPS = { radio: extras.radio, lyrics: extras.lyrics, films: extras.films, filmurl: extras.filmUrl };
TTL.films = 3600;
TTL.filmurl = 3600;
TTL.radio = 3600;
TTL.lyrics = 86400;
let houseIds = [];

async function runOp(op, params) {
  const key = op + '?' + params.toString();
  const ttl = (TTL[op] || 0) * 1000;
  const c = apiCache.get(key);
  if (ttl && c && Date.now() - c.t < ttl) return c.d;
  const d = await (OPS[op] || EXTRA_OPS[op])(params);
  if (ttl) {
    apiCache.set(key, { t: Date.now(), d });
    if (apiCache.size > 800) apiCache.delete(apiCache.keys().next().value);
  }
  return d;
}

/** Nome leggibile nell'URL: Music Assistant lo mostra come titolo (niente "%20"). */
function urlName(it) {
  // niente emoji/simboli fuori dal piano base: tagliati a metà rompono il link ("URI malformed")
  const raw = `${it.author ? it.author + ' - ' : ''}${it.title || it.id}`.replace(/[\u{10000}-\u{10FFFF}]/gu, ' ').replace(/[\uD800-\uDFFF]/g, ' ');
  const name = Array.from(raw.replace(/[\\/?#%"<>|:*&+=]+/g, ' ').trim()).slice(0, 90).join('').trim() || it.id;
  return encodeURIComponent(name.replace(/\s+/g, '_')).replace(/%E2%80%93/g, '-');
}

function streamUrl(it) {
  return `${STREAM_BASE}/stream/${it.id}/${urlName(it)}.m4a?k=${sign(it.id)}`;
}

/** Link del video per la TV: deve essere un indirizzo della rete di casa (IP:porta), non il nome interno del container. */
async function videoUrl(it, audio = false) {
  const base = (options.stream_base_url || '').trim().replace(/\/+$/, '') || await house.lanBase(PORT);
  return audio ? `${base}/stream/${it.id}/${urlName(it)}.m4a?k=${sign(it.id)}` : `${base}/video/${it.id}/${urlName(it)}.mp4?k=${sign(it.id)}`;
}

// ------------------------------------------------------------------ HLS per le TV
// La TV (Google Cast) legge bene l'HLS H.264+AAC: per i video si rimpacchetta lo stream di YouTube;
// per la musica si crea un video "badge" con copertina e titolo, così sulla TV c'è sempre un'immagine.

const HLS_DIR = '/tmp/tubetto-hls';
const tvSessions = new Map(); // sid → { ff, dir, entity, at }

function killTvSession(sid) {
  const t = tvSessions.get(sid);
  if (!t) return;
  try { t.ff.kill('SIGKILL'); } catch (e) { /* già chiuso */ }
  setTimeout(() => fs.rm(t.dir, { recursive: true, force: true }, () => null), 60000);
  tvSessions.delete(sid);
}

function killTvSessions(entities) {
  for (const [sid, t] of tvSessions) if (!entities || entities.some((e) => String(t.entity).split(',').includes(e))) killTvSession(sid);
}

setInterval(() => { for (const [sid, t] of tvSessions) if (Date.now() - t.at > 4 * 3600000) killTvSession(sid); }, 600000);
try { fs.rmSync(HLS_DIR, { recursive: true, force: true }); } catch (e) { /* niente */ }

const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));

/** Avvia l'HLS per una TV e aspetta il primo pezzo. mode: 'video' | 'badge'. */
/** Ingressi e codifica per la TV: 'video' = video di YouTube rimpacchettato, 'badge' = copertina + titolo + audio. */
function tvInputArgs(it, mode, dir) {
  const k = sign(it.id);
  const local = (kind) => `http://127.0.0.1:${PORT}/${kind}/${it.id}?k=${k}`;
  const args = ['-nostdin', '-loglevel', 'error'];
  if (mode === 'video') {
    args.push('-i', local('video'), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't1.txt'), String(it.title || '').slice(0, 60));
    fs.writeFileSync(path.join(dir, 't2.txt'), String(it.author || '').slice(0, 60));
    const thumb = `https://i.ytimg.com/vi/${it.id}/hqdefault.jpg`;
    const txt = FONT
      ? `,drawtext=fontfile=${FONT}:textfile=${dir}/t1.txt:expansion=none:fontcolor=white:fontsize=40:x=(w-tw)/2:y=560,drawtext=fontfile=${FONT}:textfile=${dir}/t2.txt:expansion=none:fontcolor=0xdddddd:fontsize=30:x=(w-tw)/2:y=620`
      : '';
    const fc = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=20:2,eq=brightness=-0.3[bg];`
      + `[0:v]crop=iw:iw*9/16,scale=-2:440[fg];[bg][fg]overlay=(W-w)/2:70${txt},format=yuv420p[v]`;
    // l'audio: dal brano; se il brano non si apre, dal video (stesso suono)
    args.push('-loop', '1', '-framerate', '10', '-i', thumb, '-i', local(it.audioFrom || 'stream'), '-filter_complex', fc,
      '-map', '[v]', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-profile:v', 'main', '-level', '4.0', '-r', '10', '-g', '20',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest');
  }
  return args;
}

// ------------------------------------------------------------------ TV DLNA (Sony, LG…): flusso MPEG-TS continuo
// Il lettore DLNA non apre l'HLS: riceve un unico flusso .ts (come la TV digitale), creato a ogni richiesta.
const tsSessions = new Map(); // sid → { it, mode, entity, at, ff }

function tvTsUrlSession(it, mode, entity) {
  const sid = crypto.randomBytes(8).toString('hex');
  tsSessions.set(sid, { it, mode, entity, at: Date.now(), ff: null });
  for (const [k, t] of tsSessions) if (Date.now() - t.at > 4 * 3600000) { try { t.ff && t.ff.kill('SIGKILL'); } catch (e) { /* */ } tsSessions.delete(k); }
  return sid;
}

function killTsSessions(entities) {
  for (const [sid, t] of tsSessions) {
    if (entities && !entities.some((e) => String(t.entity).split(',').includes(e))) continue;
    try { t.ff && t.ff.kill('SIGKILL'); } catch (e) { /* */ }
    tsSessions.delete(sid);
  }
}

const DLNA_HEADERS = {
  'transferMode.dlna.org': 'Streaming',
  'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
};

function serveTvTs(req, res, sid) {
  const t = tsSessions.get(sid);
  if (!t) return sendJson(res, 404, { error: 'Sessione finita' });
  res.writeHead(200, { 'Content-Type': 'video/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'Access-Control-Allow-Origin': '*', ...DLNA_HEADERS });
  if (req.method === 'HEAD') return res.end();
  // la TV a volte riapre il flusso: chiudo quello vecchio
  try { t.ff && t.ff.kill('SIGKILL'); } catch (e) { /* */ }
  const args = [...tvInputArgs(t.it, t.mode, path.join(HLS_DIR, 'ts-' + sid)), '-f', 'mpegts', '-mpegts_flags', 'resend_headers', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  t.ff = ff;
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-600); });
  ff.stdout.pipe(res);
  res.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) { /* */ } });
  ff.on('close', (code) => {
    if (code && !res.destroyed) log('[tv]', t.mode, t.it.id, 'flusso TS ffmpeg codice', code, err.trim().split('\n').pop());
    res.end();
  });
}

async function startTvHls(it, mode, entity) {
  const sid = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_DIR, sid);
  fs.mkdirSync(dir, { recursive: true });
  const args = tvInputArgs(it, mode, dir);
  args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(dir, 's%05d.ts'), path.join(dir, 'index.m3u8'));
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-800); });
  ff.on('close', (code) => { if (code) log('[tv]', mode, it.id, 'ffmpeg codice', code, err.trim().split('\n').pop()); });
  tvSessions.set(sid, { ff, dir, entity, at: Date.now() });
  // aspetto che ci sia la playlist con almeno un pezzo
  const idx = path.join(dir, 'index.m3u8');
  for (let i = 0; i < 60; i++) {
    await new Promise((ok) => setTimeout(ok, 500));
    if (ff.exitCode !== null && ff.exitCode !== 0) throw new Error('preparazione per la TV non riuscita: ' + (err.trim().split('\n').pop() || 'ffmpeg'));
    try { if (/\.ts/.test(fs.readFileSync(idx, 'utf8'))) break; } catch (e) { /* non ancora */ }
  }
  if (ff.exitCode !== null && ff.exitCode !== 0) throw new Error('preparazione per la TV non riuscita: ' + (err.trim().split('\n').pop() || 'ffmpeg'));
  const u = `${await lanBaseUrl()}/hls/${sid}/index.m3u8`;
  log('[tv]', mode === 'video' ? 'video' : 'badge', it.id, '→', entity, u);
  return u;
}

async function lanBaseUrl() {
  return (options.stream_base_url || '').trim().replace(/\/+$/, '') || await house.lanBase(PORT);
}

function serveHls(req, res, sid, file) {
  const t = tvSessions.get(sid);
  if (!t || !/^(index\.m3u8|s\d{5}\.ts)$/.test(file)) return sendJson(res, 404, { error: 'Sessione finita' });
  const f = path.join(t.dir, file);
  fs.stat(f, (err, st) => {
    if (err) return sendJson(res, 404, { error: 'Non ancora pronto' });
    res.writeHead(200, {
      'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Content-Length': st.size, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

// video in corso sulle TV: coda per avanti/indietro e passaggio automatico al successivo
let houseVideo = null;

async function playHouseVideo(idx) {
  const hv = houseVideo;
  if (!hv || idx < 0 || idx >= hv.items.length) throw new Error(idx < 0 ? 'Sei già al primo video' : 'Coda finita');
  const it = hv.items[idx];
  // TV: video per i video; per la musica la copertina (o il video se scelto nelle impostazioni).
  let audio = hv.music && !hv.tvVideo;
  const vOk = await videoPlayable(it.id);
  if (!audio && !vOk) { audio = true; log('[casa] video non disponibile per', it.id, ': mando copertina e audio'); }
  const itx = { ...it };
  if (audio) {
    // copertina: l'audio viene dal brano, o dal video se il brano non si apre
    try { await resolve(it.id, 'audio', false); } catch (e) { if (vOk) itx.audioFrom = 'video'; }
  }
  const mode = audio ? 'badge' : 'video';
  const thumb = `https://i.ytimg.com/vi/${it.id}/hqdefault.jpg`;
  const ents = hv.tv.map((p) => hv.vmap[p]);
  // fermo il trasferimento precedente sulle TV (video, brano o Music Assistant sulla stessa TV)
  await house.stopDirect(hv.tv.flatMap((p) => [hv.vmap[p], p !== hv.vmap[p] ? p : null]));
  killTvSessions(ents);
  killTsSessions(ents);
  await house.refreshUrlPlayers();
  const base = await lanBaseUrl();
  let hls = null;
  const title = [it.author, it.title].filter(Boolean).join(' - ') || it.id;
  const fallback = [];
  for (const p of hv.tv) {
    const ent = hv.vmap[p];
    let url = null, type = null;
    try {
      if (house.isCast(ent)) {
        // Google Cast: HLS
        if (!hls) hls = await startTvHls(itx, mode, ents.filter((e) => house.isCast(e)).join(','));
        url = hls; type = 'application/x-mpegURL';
      } else {
        // DLNA: MP4 con lunghezza se c'è lo stream unico, altrimenti flusso MPEG-TS continuo
        if (mode === 'video') {
          try { const src = await resolve(it.id, 'video', false); if (!src.hls) { url = await videoUrl(it); type = 'video/mp4'; } } catch (e) { /* uso il TS */ }
        }
        if (!url) { url = `${base}/tvts/${tvTsUrlSession(itx, mode, ent)}.ts`; type = 'video/mpeg'; }
      }
      log('[tv]', mode, it.id, '→', ent, house.isCast(ent) ? '(Cast)' : '(DLNA)', type, url);
      await house.playVideo(ent, url, title, thumb, type);
      house.routeVideo(p, ent);
    } catch (e) {
      // l'entità non accetta link (es. integrazione Sony Bravia): la escludo e la stanza riceve via Music Assistant
      if (!/Invalid media type|does not support|not supported/i.test(e.message)) throw e;
      house.noUrl.add(ent);
      log('[casa]', ent, 'non accetta link video:', e.message);
      if (p !== ent) fallback.push(p); else throw new Error(`${p} non può ricevere video da un link: scegli un'altra uscita`);
    }
  }
  if (fallback.length) {
    hv.tv = hv.tv.filter((p) => !fallback.includes(p));
    hv.rest = [...hv.rest, ...fallback];
  }
  if (hv.rest.length) await house.play(hv.rest, [streamUrl(it)]);
  hv.idx = idx;
  hv.seenPlaying = false;
  hv.at = Date.now();
  houseIds = [it.id];
  prefetch(it.id);
  if (hv.items[idx + 1]) prefetch(hv.items[idx + 1].id);
  log('[casa]', audio ? 'audio' : 'video', it.id, '→', hv.tv.map((p) => hv.vmap[p]).join(', '));
}

/** Entità rifiutate da Music Assistant: le segno e da lì in poi passano via Cast. */
function markNotMa(e) {
  const m = /Entity (media_player\.[\w]+) does not support action music_assistant/.exec(e.message || '');
  if (!m) return false;
  house.notMa.add(m[1]);
  log('[casa]', m[1], 'non è di Music Assistant: uso Cast');
  return true;
}

/** Stanze → TV (Cast) e stanze di Music Assistant. Le TV ricevono sempre direttamente via Cast. */
async function splitPlayers(players, video) {
  const ma = await house.maSet();
  const vmap = {};
  for (const p of players) {
    if (video && video[p]) vmap[p] = video[p];
    else if (house.notMa.has(p) || (ma.size && !ma.has(p))) vmap[p] = p;
  }
  return { vmap, tv: players.filter((p) => vmap[p]), rest: players.filter((p) => !vmap[p]) };
}

async function houseRadio(players, radioIt, video) {
  const { vmap, tv, rest } = await splitPlayers(players, video);
  houseIds = [];
  houseVideo = null;
  await house.stopDirect(tv.flatMap((p) => [vmap[p], p]));
  for (const p of tv) { await house.playVideo(vmap[p], radioIt.url, radioIt.title || '', radioIt.thumb || '', 'audio/mpeg'); house.routeVideo(p, vmap[p]); }
  return rest.length ? await house.play(rest, [radioIt.url]) : { grouped: false };
}

async function houseItems(players, items, music, tvVideo, video) {
  const { vmap, tv, rest } = await splitPlayers(players, video);
  if (tv.length) {
    houseVideo = { players, tv, vmap, rest, items, idx: 0, music, tvVideo };
    await playHouseVideo(0);
    return { video: true };
  }
  houseVideo = null;
  house.clearVideo(players);
  houseIds = items.map((x) => x.id);
  prefetch(houseIds[0]);
  const r = await house.play(players, items.map(streamUrl));
  log('[casa]', players.join(', '), '←', items.length, 'brani');
  return r;
}

/** Riprova una volta se Home Assistant rifiuta una stanza che non è di Music Assistant. */
async function withMaRetry(fn) {
  try { return await fn(); } catch (e) {
    if (!markNotMa(e)) throw e;
    return await fn();
  }
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-tubetto-key, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      return res.end();
    }

    // Stream: dal pannello, con chiave, o con firma (link inviati a Music Assistant)
    const sm = /^\/(stream|video|vraw)\/([A-Za-z0-9_-]{11})(\/[^/]*)?$/.exec(p);
    if (sm) {
      const [, kind, id] = sm;
      if (!authorized(req, url) && url.searchParams.get('k') !== sign(id)) return sendJson(res, 401, { error: 'Non autorizzato' });
      // coda mandata in casa: preparo già il brano dopo
      const qi = houseIds.indexOf(id);
      if (qi >= 0 && houseIds[qi + 1]) prefetch(houseIds[qi + 1]);
      return await proxy(req, res, id, kind === 'video' ? 'video' : kind === 'vraw' ? 'vonly' : 'audio', Math.max(0, Number(url.searchParams.get('t')) || 0));
    }

    // prova di raggiungibilità dalla rete di casa (per capire se la TV arriva al server)
    if (p === '/ping') return sendJson(res, 200, { ok: true, server: 'Tubetto Server', version: VERSION });

    // HLS preparato per le TV (link con codice casuale, valido finché dura la riproduzione)
    const hm = /^\/hls\/([0-9a-f]{16})\/([^/]+)$/.exec(p);
    if (hm) return serveHls(req, res, hm[1], hm[2]);
    const tm = /^\/tvts\/([0-9a-f]{16})\.ts$/.exec(p);
    if (tm) return serveTvTs(req, res, tm[1]);

    // Radio web (dal pannello o con chiave)
    if (p === '/radiostream') {
      if (!authorized(req, url)) return sendJson(res, 401, { error: 'Non autorizzato' });
      return await proxyRadio(req, res, url.searchParams.get('u') || '');
    }

    if (p.startsWith('/api/')) {
      if (!authorized(req, url)) return sendJson(res, 401, { error: 'Chiave non valida' });
      const op = p.slice(5);

      if (op === 'config') {
        return sendJson(res, 200, { server: true, version: VERSION, repo: REPO, token: fromIngress(req) ? TOKEN : '', key: fromIngress(req) ? API_KEY : undefined, port: PORT });
      }
      if (op === 'ping') return sendJson(res, 200, { ok: true, version: VERSION });
      if (op === 'prefetch') { prefetch(url.searchParams.get('id')); return sendJson(res, 200, { ok: true }); }
      if (op === 'status') {
        let tvBase = '';
        try { tvBase = await lanBaseUrl(); } catch (e) { tvBase = '❌ ' + e.message; }
        return sendJson(res, 200, { version: VERSION, config: configInfo, stream: getStats(), streamBase: STREAM_BASE, tvBase });
      }

      // ---- allineamento con l'app: radio, testi, Spotify, accesso con account
      if (op === 'radio') return sendJson(res, 200, await runOp('radio', url.searchParams));
      if (op === 'radio/click') { extras.radioClick(url.searchParams.get('id') || ''); return sendJson(res, 200, { ok: true }); }
      if (op === 'lyrics') return sendJson(res, 200, await runOp('lyrics', url.searchParams));
      if (op === 'films') return sendJson(res, 200, await runOp('films', url.searchParams));
      if (op === 'filmurl') return sendJson(res, 200, await runOp('filmurl', url.searchParams));
      if (op === 'spotify') return sendJson(res, 200, await extras.spotify(url.searchParams));
      if (op === 'account' && req.method === 'GET') return sendJson(res, 200, extras.accountStatus());
      if (op === 'account' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.logout) extras.accountLogout();
        else if (b.blob) return sendJson(res, 200, extras.accountImport(b.blob, b.code));
        else extras.accountSave(b.cookies);
        log('[account]', b.logout ? 'uscito' : 'accesso salvato');
        return sendJson(res, 200, extras.accountStatus());
      }

      if (op === 'house/players') return sendJson(res, 200, await house.players());
      if (op === 'house/state') {
        const pls = (url.searchParams.get('players') || '').split(',').filter(Boolean);
        const st = await house.state(pls);
        // video finito sulla TV: passo al successivo (come la coda di Music Assistant)
        if (st && st.video && houseVideo && pls[0] === houseVideo.players[0]) {
          if (st.state === 'playing') houseVideo.seenPlaying = true;
          else if (houseVideo.seenPlaying && st.state === 'idle' && Date.now() - houseVideo.at > 15000 && houseVideo.idx + 1 < houseVideo.items.length) {
            playHouseVideo(houseVideo.idx + 1).catch((e) => log('[casa] video successivo non riuscito:', e.message));
          }
          const cur = houseVideo.items[houseVideo.idx];
          if (cur) { st.videoId = cur.id; if (!st.title) st.title = cur.title || ''; }
        }
        return sendJson(res, 200, st);
      }
      if (op === 'house/play' && req.method === 'POST') {
        const b = await readBody(req);
        // radio web: Music Assistant apre direttamente lo stream della stazione
        const radioIt = (b.items || []).find((x) => x && String(x.id || '').startsWith('radio:') && /^https?:\/\//.test(x.url || ''));
        if (radioIt) {
          const playersR = (b.players || []).filter((x) => typeof x === 'string' && x.startsWith('media_player.'));
          const rr = await withMaRetry(() => houseRadio(playersR, radioIt, b.video || {}));
          extras.radioClick(String(radioIt.id).slice(6));
          log('[casa]', playersR.join(', '), '← radio', radioIt.title);
          return sendJson(res, 200, { ok: true, count: 1, items: [radioIt], ...rr });
        }
        // film di Internet Archive verso una TV
        const film = (b.items || []).find((x) => x && String(x.id || '').startsWith('film:') && /^https:\/\/archive\.org\//.test(x.url || ''));
        if (film) {
          const { vmap, tv } = await splitPlayers((b.players || []).filter((x) => typeof x === 'string' && x.startsWith('media_player.')), b.video || {});
          if (!tv.length) return sendJson(res, 400, { error: 'Scegli una TV (📺) per guardare il film in casa' });
          await house.stopDirect(tv.flatMap((p) => [vmap[p], p]));
          for (const p of tv) { await house.playVideo(vmap[p], film.url, film.title || '', film.thumb || ''); house.routeVideo(p, vmap[p]); }
          houseIds = [];
          houseVideo = null;
          return sendJson(res, 200, { ok: true, count: 1, items: [film], video: true });
        }
        let items = (b.items || []).filter((x) => x && /^[A-Za-z0-9_-]{11}$/.test(x.id)).slice(0, 80);
        if (!items.length) return sendJson(res, 400, { error: 'Coda vuota' });
        // coda corta: aggiungo brani simili, come la radio dell'app
        if (items.length < 25) {
          try {
            const more = await related(items[items.length - 1].id, b.music !== false);
            const have = new Set(items.map((x) => x.id));
            items = dedupeSongs([...items, ...more.filter((x) => !have.has(x.id))]).slice(0, 40);
          } catch (e) { /* va bene così */ }
        }
        const players = (b.players || []).filter((x) => typeof x === 'string' && x.startsWith('media_player.'));
        const r = await withMaRetry(() => houseItems(players, items, b.music !== false, !!b.tvVideo, b.video || {}));
        return sendJson(res, 200, { ok: true, count: items.length, items, ...r });
      }
      if (op === 'house/cmd' && req.method === 'POST') {
        const b = await readBody(req);
        const pls = (b.players || []).filter(Boolean);
        // video sulle TV: la TV non ha una coda, avanti/indietro li gestisco io
        if (houseVideo && pls[0] && house.videoOf(pls[0]) && (b.cmd === 'next' || b.cmd === 'previous')) {
          await playHouseVideo(houseVideo.idx + (b.cmd === 'next' ? 1 : -1));
          return sendJson(res, 200, { ok: true });
        }
        if (b.cmd === 'stop') { houseVideo = null; killTvSessions(null); killTsSessions(null); }
        let r = null;
        try {
          r = await house.command(pls, b.cmd, b.value);
        } catch (e) {
          if (!/queue is empty/i.test(e.message)) throw e;
        }
        // "play" non supportato dalla TV o coda svuotata: rimando il brano da dove eravamo
        if (b.cmd === 'play' && (!r || r.unsupported)) {
          if (houseVideo) await playHouseVideo(houseVideo.idx);
          else if (houseIds.length) await house.play(pls, houseIds.map((id) => streamUrl({ id })));
        }
        return sendJson(res, 200, { ok: true });
      }

      if (OPS[op]) return sendJson(res, 200, await runOp(op, url.searchParams));
      return sendJson(res, 404, { error: 'Operazione sconosciuta: ' + op });
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    res.writeHead(405);
    res.end();
  } catch (e) {
    log('[errore]', p, e.message);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  log(`Tubetto Server ${VERSION} in ascolto sulla porta ${PORT}`);
  log(`Stream per Music Assistant: ${STREAM_BASE}`);
  log(`Chiave per le app Tubetto in rete di casa: ${API_KEY}`);
  if (!TOKEN) log('ATTENZIONE: token GitHub non impostato: niente libreria sincronizzata né configurazione aggiornata');
});

refreshConfig();
setInterval(refreshConfig, 3 * 3600 * 1000);
updateYtdlp();
setInterval(updateYtdlp, 24 * 3600 * 1000);

// arresto pulito (Home Assistant manda SIGTERM all'aggiornamento/riavvio)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killTvSessions(null);
    killTsSessions(null);
    server.close();
    process.exit(0);
  });
}
