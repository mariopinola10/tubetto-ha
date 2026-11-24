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
import { execFile } from 'node:child_process';
import { OPS, TTL, related, dedupeSongs, setWebClients } from './yt.mjs';
import { resolve, applyConfig, getStats, setQuality } from './resolver.mjs';
import * as house from './house.mjs';

const VERSION = '1.0.3';
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
  execFile('/opt/ytdlp/bin/pip', ['install', '-q', '-U', 'yt-dlp'], { timeout: 180000 }, (err) => {
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

async function proxy(req, res, videoId, kind) {
  let src;
  try {
    src = await resolve(videoId, kind, false);
  } catch (e) {
    if (kind === 'video') return sendJson(res, 404, { error: 'Video non disponibile: ' + e.message });
    return sendJson(res, 502, { error: e.message });
  }
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
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const CHUNK = 1024 * 1024;
  let pos = start;
  let retried = false;
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
      if (retried) { log('[stream] interrotto', videoId, 'HTTP', r.status); break; }
      retried = true;
      try { src = await resolve(videoId, kind, true, src.itag); } catch (e) { break; }
      if (src.clen !== total) { log('[stream] formato cambiato, interrompo', videoId); break; }
      continue;
    }
    retried = false;
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

async function runOp(op, params) {
  const key = op + '?' + params.toString();
  const ttl = (TTL[op] || 0) * 1000;
  const c = apiCache.get(key);
  if (ttl && c && Date.now() - c.t < ttl) return c.d;
  const d = await OPS[op](params);
  if (ttl) {
    apiCache.set(key, { t: Date.now(), d });
    if (apiCache.size > 800) apiCache.delete(apiCache.keys().next().value);
  }
  return d;
}

function streamUrl(it) {
  const name = `${it.author ? it.author + ' - ' : ''}${it.title || it.id}`.replace(/[\\/?#%"<>|:*]+/g, ' ').trim().slice(0, 90) || it.id;
  return `${STREAM_BASE}/stream/${it.id}/${encodeURIComponent(name)}.m4a?k=${sign(it.id)}`;
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
      return await proxy(req, res, id, kind === 'video' ? 'video' : 'audio');
    }

    if (p.startsWith('/api/')) {
      if (!authorized(req, url)) return sendJson(res, 401, { error: 'Chiave non valida' });
      const op = p.slice(5);

      if (op === 'config') {
        return sendJson(res, 200, { server: true, version: VERSION, repo: REPO, token: fromIngress(req) ? TOKEN : '', key: fromIngress(req) ? API_KEY : undefined, port: PORT });
      }
      if (op === 'ping') return sendJson(res, 200, { ok: true, version: VERSION });
      if (op === 'status') return sendJson(res, 200, { version: VERSION, config: configInfo, stream: getStats(), streamBase: STREAM_BASE });

      if (op === 'house/players') return sendJson(res, 200, await house.players());
      if (op === 'house/state') return sendJson(res, 200, await house.state((url.searchParams.get('players') || '').split(',').filter(Boolean)));
      if (op === 'house/play' && req.method === 'POST') {
        const b = await readBody(req);
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
