/**
 * Tubetto Server — trova lo stream audio/video di un brano, dal Raspberry (IP di casa).
 * Prima InnerTube /player con i client della configurazione (IOS, ANDROID_VR, ANDROID),
 * poi yt-dlp come riserva. Risultati in cache finché il link non scade.
 */
import { execFile } from 'node:child_process';

const YT = 'https://www.youtube.com';

let clients = {
  IOS: {
    clientName: 'IOS', nameId: 5, version: '20.10.4',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', platform: 'MOBILE' },
  },
  ANDROID_VR: {
    clientName: 'ANDROID_VR', nameId: 28, version: '1.65.10',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: { deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', platform: 'MOBILE' },
  },
  ANDROID: {
    clientName: 'ANDROID', nameId: 3, version: '20.10.38',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    context: { osName: 'Android', osVersion: '14', platform: 'MOBILE' },
  },
};
let order = ['IOS', 'ANDROID_VR', 'ANDROID'];
let preferred = null;
let audioMaxKbps = 320;

const cache = new Map();
/** Client che danno link "a metà" (403 dopo i primi byte, es. IOS senza PO token): esclusi per un po'. */
const bad = new Map();
const BAD_MS = 6 * 3600 * 1000;
const stats = { ok: 0, fail: 0, consecutiveFail: 0, lastError: '', lastOk: '', via: {} };

export function getStats() {
  const now = Date.now();
  const excluded = [...bad.entries()].filter(([, t]) => t > now).map(([k]) => k);
  return { ...stats, order: [...order], excluded, versions: Object.fromEntries(Object.entries(clients).map(([k, c]) => [k, c.version])) };
}

export function setQuality(q) {
  audioMaxKbps = q === 'medium' ? 140 : 320;
}

/** Applica config/tubetto-config.json (aggiornata e testata dal workflow "Salute Tubetto"). */
export function applyConfig(cfg) {
  if (!cfg || !cfg.clients) return false;
  const next = { ...clients };
  for (const k of Object.keys(next)) {
    const c = cfg.clients[k];
    if (c && c.clientName && c.version && c.nameId) {
      next[k] = { clientName: c.clientName, nameId: c.nameId, version: c.version, userAgent: c.userAgent || next[k].userAgent, context: c.context || next[k].context };
    }
  }
  clients = next;
  if (Array.isArray(cfg.playerOrder)) {
    const o = cfg.playerOrder.filter((k) => clients[k]);
    if (o.length) order = o;
  }
  return true;
}

// ---------------- visitorData: identità anonima come un browser vero (meno controlli "bot") ----------------
let visitor = { id: '', at: 0 };

async function visitorData() {
  if (visitor.id && Date.now() - visitor.at < 12 * 3600 * 1000) return visitor.id;
  try {
    const r = await fetch(`${YT}/youtubei/v1/visitor_id?prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251110.01.00', hl: 'it', gl: 'IT' } } }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const id = (j.responseContext && j.responseContext.visitorData) || '';
    if (id) visitor = { id, at: Date.now() };
  } catch (e) { /* senza visitorData si va avanti lo stesso */ }
  return visitor.id;
}

async function playerCall(client, videoId) {
  const vd = await visitorData();
  const body = {
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    context: {
      client: { clientName: client.clientName, clientVersion: client.version, hl: 'it', gl: 'IT', ...(vd ? { visitorData: vd } : {}), ...client.context },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  };
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': client.userAgent,
    'X-YouTube-Client-Name': String(client.nameId),
    'X-YouTube-Client-Version': client.version,
  };
  if (vd) headers['X-Goog-Visitor-Id'] = vd;
  const r = await fetch(`${YT}/youtubei/v1/player?prettyPrint=false`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`player HTTP ${r.status}`);
  return r.json();
}

// ---------------- HLS (formato che YouTube dà ancora senza token: lo converte ffmpeg) ----------------

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/** Dal manifest principale sceglie la traccia: solo audio (la migliore) o video fino a 480p. */
async function pickHls(masterUrl, ua, kind) {
  const r = await fetch(masterUrl, { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HLS HTTP ${r.status}`);
  const text = await r.text();
  const lines = text.split('\n').map((l) => l.trim());
  const abs = (u) => new URL(u, masterUrl).toString();
  if (kind === 'audio') {
    const audio = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l)).map(parseAttrs).filter((a) => a.URI);
    if (audio.length) {
      const best = audio.find((a) => /234/.test(a['GROUP-ID'] || '')) || audio.find((a) => a.DEFAULT === 'YES') || audio[audio.length - 1];
      return abs(best.URI);
    }
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(lines[i]);
      const uri = lines[i + 1];
      if (uri && !uri.startsWith('#')) variants.push({ bw: Number(a.BANDWIDTH) || 0, h: Number((a.RESOLUTION || 'x0').split('x')[1]) || 0, uri: abs(uri) });
    }
  }
  if (!variants.length) return null;
  variants.sort((x, y) => x.h - y.h || x.bw - y.bw);
  // audio: le varianti 360p hanno AAC 128k; video: la migliore fino a 480p
  const target = kind === 'audio' ? 360 : 480;
  const fit = variants.filter((v) => v.h <= target);
  return (fit.length ? fit[fit.length - 1] : variants[0]).uri;
}

const kbps = (f) => (f.averageBitrate || f.bitrate || 0) / 1000;

function pickAudio(formats, preferItag) {
  const audio = formats.filter((f) => f.url && /^audio\//.test(f.mimeType || ''));
  if (!audio.length) return null;
  if (preferItag) {
    const same = audio.find((f) => f.itag === preferItag);
    if (same) return same;
  }
  // AAC (m4a) per primo: lo leggono tutti i browser e Music Assistant
  const pool = audio.filter((f) => kbps(f) <= audioMaxKbps + 8);
  const list = pool.length ? pool : audio;
  const mp4 = list.filter((f) => f.mimeType.startsWith('audio/mp4'));
  const best = (l) => l.slice().sort((a, b) => kbps(b) - kbps(a))[0];
  return best(mp4.length ? mp4 : list);
}

function pickMuxed(formats, preferItag) {
  const muxed = formats.filter((f) => f.url && /^video\//.test(f.mimeType || '') && /mp4a|opus|vorbis/.test(f.mimeType));
  if (!muxed.length) return null;
  if (preferItag) {
    const same = muxed.find((f) => f.itag === preferItag);
    if (same) return same;
  }
  return muxed.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

async function contentLength(url, ua) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'range=0-0', { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`stream HTTP ${r.status}`);
  const cr = r.headers.get('content-range');
  await r.arrayBuffer().catch(() => null);
  const m = cr && /\/(\d+)/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(r.headers.get('content-length'));
  if (cl > 1) return cl;
  throw new Error('lunghezza sconosciuta');
}

async function fromInnertube(videoId, kind, preferItag) {
  const errors = [];
  const now = Date.now();
  const list = [...order].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  for (const key of list) {
    const client = clients[key];
    if (!client) continue;
    try {
      const j = await playerCall(client, videoId);
      const ps = j.playabilityStatus || {};
      if (ps.status !== 'OK') {
        errors.push(`${key}: ${ps.status} ${ps.reason || ''}`.trim());
        continue;
      }
      const sd = j.streamingData || {};
      const vd = j.videoDetails || {};
      const meta = { title: vd.title || '', author: vd.author || '', lengthSeconds: Number(vd.lengthSeconds) || 0 };

      // 1) link diretti (si possono saltare avanti e indietro), se questo client non li dà "a metà"
      if (!(bad.get(key) > now)) {
        const f = kind === 'video' ? pickMuxed(sd.formats || [], preferItag) : pickAudio(sd.adaptiveFormats || [], preferItag);
        if (f) {
          const clen = Number(f.contentLength) || (await contentLength(f.url, client.userAgent));
          const points = [0, Math.floor(clen / 2), Math.max(0, clen - 4096)].filter((v, i, a) => a.indexOf(v) === i);
          let failed = 0;
          for (const at of points) {
            const probe = await fetch(`${f.url}&range=${at}-${at + 1023}`, { headers: { 'User-Agent': client.userAgent }, signal: AbortSignal.timeout(10000) });
            await probe.arrayBuffer().catch(() => null);
            if (!probe.ok) { failed = probe.status; break; }
          }
          if (!failed) {
            preferred = key;
            return { url: f.url, ua: client.userAgent, clen, itag: f.itag, mime: (f.mimeType || 'audio/mp4').split(';')[0], via: 'innertube:' + key, ...meta };
          }
          errors.push(`${key}: link diretto HTTP ${failed}`);
          markBad(key);
        }
      }

      // 2) HLS (es. client IOS): convertito al volo da ffmpeg
      if (sd.hlsManifestUrl) {
        const media = await pickHls(sd.hlsManifestUrl, client.userAgent, kind);
        if (media) {
          preferred = key;
          return { hls: true, url: media, ua: client.userAgent, mime: kind === 'video' ? 'video/mp4' : 'audio/aac', via: 'innertube:' + key + ':hls', ...meta };
        }
      }
      errors.push(`${key}: nessun formato utilizzabile`);
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'nessun client');
}

function ytdlpJson(videoId) {
  return new Promise((resolve, reject) => {
    execFile('/opt/ytdlp/bin/yt-dlp', [
      '-J', '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:player_client=ios,android_vr,web_safari',
      'https://www.youtube.com/watch?v=' + videoId,
    ], { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('yt-dlp: ' + (stderr || err.message).split('\n').filter(Boolean).pop()));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('yt-dlp: risposta non valida')); }
    });
  });
}

async function fromYtdlp(videoId, kind) {
  const j = await ytdlpJson(videoId);
  const all = (j.formats || []).filter((f) => f.url);
  const direct = all.filter((f) => f.protocol === 'https' || f.protocol === 'http');
  const hls = all.filter((f) => /m3u8/.test(f.protocol || ''));
  const meta = { title: j.title || '', author: j.uploader || j.channel || '', lengthSeconds: j.duration || 0 };
  const isAudio = (x) => x.acodec && x.acodec !== 'none' && (!x.vcodec || x.vcodec === 'none');
  const isMuxed = (x) => x.vcodec && x.vcodec !== 'none' && x.acodec && x.acodec !== 'none';
  let f;
  if (kind === 'video') f = direct.filter(isMuxed).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  else {
    const audio = direct.filter(isAudio);
    const m4a = audio.filter((x) => x.ext === 'm4a');
    f = (m4a.length ? m4a : audio).sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  }
  if (f) {
    const ua = (f.http_headers && f.http_headers['User-Agent']) || 'Mozilla/5.0';
    try {
      const clen = f.filesize || (await contentLength(f.url, ua));
      const mime = kind === 'video' ? 'video/mp4' : f.ext === 'm4a' ? 'audio/mp4' : f.ext === 'webm' ? 'audio/webm' : 'audio/mpeg';
      return { url: f.url, ua, clen, itag: Number(f.format_id) || 0, mime, via: 'yt-dlp', ...meta };
    } catch (e) { /* provo HLS */ }
  }
  // HLS: solo audio (233/234) o video fino a 480p
  let h;
  if (kind === 'video') h = hls.filter(isMuxed).filter((x) => (x.height || 0) <= 480).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  else h = hls.filter(isAudio).sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0] || hls.filter(isMuxed).filter((x) => (x.height || 0) <= 360).sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (!h) throw new Error('yt-dlp: nessun formato utilizzabile');
  const ua = (h.http_headers && h.http_headers['User-Agent']) || 'Mozilla/5.0';
  return { hls: true, url: h.url, ua, mime: kind === 'video' ? 'video/mp4' : 'audio/aac', via: 'yt-dlp:hls', ...meta };
}

function markBad(key) {
  if (!(bad.get(key) > Date.now())) console.log(`[stream] client ${key} escluso per 6 ore (link interrotti)`);
  bad.set(key, Date.now() + BAD_MS);
  if (preferred === key) preferred = null;
}

/** Il link si è interrotto durante la riproduzione: escludo quel client e svuoto la cache del brano. */
export function reportBroken(videoId, kind, via) {
  const key = String(via || '').replace('innertube:', '');
  if (clients[key]) markBad(key);
  cache.delete(kind + ':' + videoId);
}

/**
 * @param kind 'audio' | 'video'
 * @param force ignora la cache (link scaduto)
 */
export async function resolve(videoId, kind = 'audio', force = false, preferItag = 0) {
  const key = kind + ':' + videoId;
  const c = cache.get(key);
  if (!force && c && Date.now() < c.expires) return c.src;
  let src;
  try {
    src = await fromInnertube(videoId, kind, preferItag || (c && c.src.itag));
  } catch (e1) {
    try {
      src = await fromYtdlp(videoId, kind);
    } catch (e2) {
      if (kind === 'video') throw new Error(e1.message + ' || ' + e2.message); // video non sempre disponibile: non è un guasto
      stats.fail++;
      stats.consecutiveFail++;
      stats.lastError = `${new Date().toISOString()} ${videoId}: ${e1.message} || ${e2.message}`;
      console.log('[stream] KO', stats.lastError);
      throw new Error(e1.message + ' || ' + e2.message);
    }
  }
  stats.ok++;
  stats.consecutiveFail = 0;
  stats.lastOk = `${new Date().toISOString()} ${videoId} via ${src.via}`;
  stats.via[src.via] = (stats.via[src.via] || 0) + 1;
  const exp = Number((/[?&/]expire[=/](\d+)/.exec(src.url) || [])[1]) * 1000;
  cache.set(key, { src, expires: exp ? exp - 10 * 60000 : Date.now() + 3 * 3600000 });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return src;
}
