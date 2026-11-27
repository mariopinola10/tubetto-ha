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

const VERSION = '1.4.1';
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
  if (kind === 'video') args.push('-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
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

async function proxy(req, res, videoId, kind, startAt = 0) {
  let src;
  try {
    src = await resolve(videoId, kind, false);
  } catch (e) {
    if (kind === 'video') return sendJson(res, 404, { error: 'Video non disponibile: ' + e.message });
    return sendJson(res, 502, { error: e.message });
  }
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
  const headers = {
    'Content-Type': src.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Tubetto-Duration': String(src.lengthSeconds || 0),
  };
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
    try {
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
  const name = `${it.author ? it.author + ' - ' : ''}${it.title || it.id}`.replace(/[\\/?#%"<>|:*&+=]+/g, ' ').trim().slice(0, 90) || it.id;
  return encodeURIComponent(name.replace(/\s+/g, '_')).replace(/%E2%80%93/g, '-');
}

function streamUrl(it) {
  return `${STREAM_BASE}/stream/${it.id}/${urlName(it)}.m4a?k=${sign(it.id)}`;
}

function videoUrl(it) {
  return `${STREAM_BASE}/video/${it.id}/${urlName(it)}.mp4?k=${sign(it.id)}`;
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
    const sm = /^\/(stream|video)\/([A-Za-z0-9_-]{11})(\/[^/]*)?$/.exec(p);
    if (sm) {
      const [, kind, id] = sm;
      if (!authorized(req, url) && url.searchParams.get('k') !== sign(id)) return sendJson(res, 401, { error: 'Non autorizzato' });
      // coda mandata in casa: preparo già il brano dopo
      const qi = houseIds.indexOf(id);
      if (qi >= 0 && houseIds[qi + 1]) prefetch(houseIds[qi + 1]);
      return await proxy(req, res, id, kind === 'video' ? 'video' : 'audio', Math.max(0, Number(url.searchParams.get('t')) || 0));
    }

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
      if (op === 'status') return sendJson(res, 200, { version: VERSION, config: configInfo, stream: getStats(), streamBase: STREAM_BASE });

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
      if (op === 'house/state') return sendJson(res, 200, await house.state((url.searchParams.get('players') || '').split(',').filter(Boolean)));
      if (op === 'house/play' && req.method === 'POST') {
        const b = await readBody(req);
        // radio web: Music Assistant apre direttamente lo stream della stazione
        const radioIt = (b.items || []).find((x) => x && String(x.id || '').startsWith('radio:') && /^https?:\/\//.test(x.url || ''));
        if (radioIt) {
          const playersR = (b.players || []).filter((x) => typeof x === 'string' && x.startsWith('media_player.'));
          houseIds = [];
          const rr = await house.play(playersR, [radioIt.url]);
          extras.radioClick(String(radioIt.id).slice(6));
          log('[casa]', playersR.join(', '), '← radio', radioIt.title);
          return sendJson(res, 200, { ok: true, count: 1, items: [radioIt], ...rr });
        }
        // film di Internet Archive verso una TV
        const film = (b.items || []).find((x) => x && String(x.id || '').startsWith('film:') && /^https:\/\/archive\.org\//.test(x.url || ''));
        if (film) {
          const vmap = b.video || {};
          const tv = (b.players || []).filter((p) => vmap[p]);
          if (!tv.length) return sendJson(res, 400, { error: 'Scegli una TV (📺) per guardare il film in casa' });
          for (const p of tv) await house.playVideo(vmap[p], film.url, film.title || '', film.thumb || '');
          houseIds = [];
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
        // Video verso una TV: si manda il video (Cast) alle stanze che lo supportano, l'audio alle altre
        if (b.music === false) {
          const vmap = b.video || {};
          const tv = players.filter((p) => vmap[p]);
          if (tv.length) {
            const it0 = items[0];
            const thumb = `https://i.ytimg.com/vi/${it0.id}/hqdefault.jpg`;
            for (const p of tv) await house.playVideo(vmap[p], videoUrl(it0), it0.title || '', thumb);
            const rest = players.filter((p) => !vmap[p]);
            if (rest.length) await house.play(rest, [streamUrl(it0)]);
            log('[casa] video', it0.id, '→', tv.map((p) => vmap[p]).join(', '));
            houseIds = [it0.id];
            return sendJson(res, 200, { ok: true, count: 1, items: [it0], video: true });
          }
        }
        houseIds = items.map((x) => x.id);
        prefetch(houseIds[0]);
        const r = await house.play(players, items.map(streamUrl));
        log('[casa]', players.join(', '), '←', items.length, 'brani');
        return sendJson(res, 200, { ok: true, count: items.length, items, ...r });
      }
      if (op === 'house/cmd' && req.method === 'POST') {
        const b = await readBody(req);
        await house.command((b.players || []).filter(Boolean), b.cmd, b.value);
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
