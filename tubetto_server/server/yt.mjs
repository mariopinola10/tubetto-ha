/**
 * Tubetto Server — ricerca e pagine YouTube/YouTube Music (stesso codice del Worker di Tubetto Web).
 * Da incollare in un Cloudflare Worker (piano gratuito).
 *
 * Variabile/secret opzionale ma consigliata: TUBETTO_KEY = una parola segreta a tua scelta.
 * La pagina web la invia nell'header "x-tubetto-key"; senza la chiave giusta il Worker risponde 401.
 *
 * Endpoint (GET):
 *   /ping
 *   /search?q=...&type=songs|artists|playlists|videos|channels
 *   /related?id=VIDEO_ID&music=1
 *   /foryou?ids=ID1,ID2,ID3
 *   /playlist?id=PLAYLIST_ID
 *   /channel?id=UC...
 *   /artist?name=...&channelId=UC... (channelId facoltativo)
 *   /artistimg?name=...
 *   /charts            (hit del momento Italia, YouTube Music)
 *   /news              (nuove uscite, YouTube Music)
 */

const VERSION = '1.0.0';
const YT = 'https://www.youtube.com';
const YTM = 'https://music.youtube.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CLIENTS = {
  WEB: { name: 'WEB', id: 1, version: '2.20251110.01.00' },
  WEB_REMIX: { name: 'WEB_REMIX', id: 67, version: '1.20251110.01.00' },
};

/** Versioni aggiornate dalla configurazione remota (config/tubetto-config.json). */
export function setWebClients(cfg) {
  const c = (cfg && cfg.clients) || {};
  for (const k of ['WEB', 'WEB_REMIX']) {
    if (c[k] && c[k].version) CLIENTS[k].version = c[k].version;
  }
}

const P = {
  videos: 'EgIQAQ==',
  playlists: 'EgIQAw==',
  channels: 'EgIQAg==',
  month: 'EgQIBBAB',
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
  tabVideos: 'EgZ2aWRlb3PyBgQKAjoA',
  tabPlaylists: 'EglwbGF5bGlzdHPyBgQKAkIA',
};

/** Durata in secondi della cache per endpoint. */
export const TTL = { charts: 3600, news: 7200, artistimg: 604800, artist: 1800, playlist: 1800, channel: 1800, search: 600, related: 1800, foryou: 600 };

async function post(endpoint, clientKey, payload, origin = YT) {
  const c = CLIENTS[clientKey];
  const body = {
    ...payload,
    context: {
      client: { clientName: c.name, clientVersion: c.version, hl: 'it', gl: 'IT', platform: 'DESKTOP', utcOffsetMinutes: 60 },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
  };
  const r = await fetch(`${origin}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-YouTube-Client-Name': String(c.id),
      'X-YouTube-Client-Version': c.version,
      'Accept-Language': 'it-IT,it;q=0.9',
      Origin: origin,
      Referer: origin + '/',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`InnerTube /${endpoint} (${clientKey}) HTTP ${r.status}`);
  return r.json();
}

const safe = (p, fallback = []) => p.catch(() => fallback);

// ------------------------------------------------------------------ Operazioni

export const OPS = {
  async ping() {
    return { ok: true, version: VERSION };
  },

  async search(q) {
    const query = (q.get('q') || '').trim();
    if (!query) return { items: [] };
    switch (q.get('type') || 'songs') {
      case 'songs': return { items: await searchMusic(query) };
      case 'artists': return { items: await searchArtists(query) };
      case 'playlists': return { items: await searchKind(query, P.playlists, 'PLAYLIST') };
      case 'channels': return { items: await searchKind(query, P.channels, 'CHANNEL') };
      default: return { items: await searchKind(query, P.videos, 'VIDEO') };
    }
  },

  async related(q) {
    const id = q.get('id');
    if (!id) return { items: [] };
    return { items: await related(id, q.get('music') !== '0') };
  },

  async foryou(q) {
    const ids = (q.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    const lists = await Promise.all(ids.map((id) => safe(related(id, true))));
    const seen = new Set(ids);
    const out = [];
    for (let i = 0; i < 12; i++) {
      for (const l of lists) {
        const v = l[i];
        if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
      }
    }
    return { items: dedupeSongs(out).slice(0, 40) };
  },

  async playlist(q) {
    const id = q.get('id');
    if (!id) return { items: [] };
    const root = await post('browse', 'WEB', { browseId: 'VL' + id });
    const header = findFirst(root, 'pageHeaderViewModel') || findFirst(root, 'playlistHeaderRenderer');
    const title = header ? text(header.title) || (header.title && header.title.dynamicTextViewModel && header.title.dynamicTextViewModel.text && header.title.dynamicTextViewModel.text.content) || '' : '';
    return { title, items: collect(root).filter((i) => i.kind === 'VIDEO') };
  },

  async channel(q) {
    const id = q.get('id');
    if (!id) return { videos: [], playlists: [] };
    const [videos, playlists] = await Promise.all([safe(channelVideos(id)), safe(channelPlaylists(id))]);
    return { videos, playlists };
  },

  async artist(q) {
    const name = (q.get('name') || '').trim();
    if (!name) return {};
    let channelId = q.get('channelId') || null;
    let thumb = null;
    const found = await safe(searchArtists(name));
    const match = found.find((a) => a.title.toLowerCase() === name.toLowerCase()) || found[0];
    if (match) {
      thumb = match.thumb;
      if (!channelId && match.title.toLowerCase() === name.toLowerCase()) channelId = match.channelId;
    }
    const [recent, channel, songs, pls] = await Promise.all([
      safe(searchKind(name, P.month, 'VIDEO')),
      channelId ? safe(channelVideos(channelId)) : Promise.resolve([]),
      safe(searchMusic(name)),
      safe(searchKind(name + ' playlist', P.playlists, 'PLAYLIST')),
    ]);
    const lname = name.toLowerCase();
    const rec = recent.filter((v) => {
      const official = (channelId && v.channelId === channelId) || cleanArtist(v.author).toLowerCase() === lname || v.author.toLowerCase().includes(lname);
      return official && isSong(v);
    }).slice(0, 8);
    const recIds = new Set(rec.map((v) => v.id));
    const ch = channel.filter((v) => !recIds.has(v.id) && isSong(v)).slice(0, 20);
    const latest = distinctBy([...rec, ...ch], (v) => songKey(v.title, name));
    return { name, channelId, thumb, latest, top: songs.slice(0, 20), playlists: pls.slice(0, 8) };
  },

  async artistimg(q) {
    const name = (q.get('name') || '').trim();
    if (!name) return { thumb: null };
    const found = await safe(searchArtists(name));
    const a = found.find((x) => x.title.toLowerCase() === name.toLowerCase()) || found[0];
    return { thumb: a ? a.thumb : null, channelId: a ? a.channelId : null };
  },

  async charts() {
    let list = [];
    try {
      list = parseMusic(await post('browse', 'WEB_REMIX', { browseId: 'FEmusic_charts', formData: { selectedValues: ['IT'] } }, YTM));
    } catch (e) { /* ripiego sotto */ }
    list = clean(list);
    if (!list.length) list = await searchMusic('hit del momento italia');
    return { items: list.slice(0, 50) };
  },

  async news() {
    let releases = [];
    try {
      releases = parseReleases(await post('browse', 'WEB_REMIX', { browseId: 'FEmusic_new_releases' }, YTM));
    } catch (e) { /* niente */ }
    const singles = new Set(['Singolo', 'Single', 'EP']);
    releases.sort((a, b) => (singles.has(a.type) ? 0 : 1) - (singles.has(b.type) ? 0 : 1));
    releases = releases.slice(0, 16);
    const tracks = await Promise.all(releases.map(async (rel) => {
      try {
        const songs = parseMusic(await post('browse', 'WEB_REMIX', { browseId: rel.browseId }, YTM)).slice(0, rel.type === 'Album' ? 2 : 1);
        return songs.map((s) => ({ ...s, author: s.author || rel.artist, thumb: s.thumb || rel.thumb, published: rel.type }));
      } catch (e) { return []; }
    }));
    const flat = clean(tracks.flat());
    return { items: distinctBy(flat, (v) => v.id).slice(0, 30) };
  },
};

// ------------------------------------------------------------------ Ricerche

async function searchKind(query, params, kind) {
  return collect(await post('search', 'WEB', { query, params })).filter((i) => i.kind === kind);
}

async function searchMusic(query) {
  let list = [];
  try {
    list = parseMusic(await post('search', 'WEB_REMIX', { query, params: P.songs }, YTM));
  } catch (e) { /* ripiego sulla ricerca video */ }
  if (!list.length) list = await searchKind(query, P.videos, 'VIDEO');
  return clean(list, query);
}

async function searchArtists(query) {
  let music = [];
  try {
    music = parseMusicArtists(await post('search', 'WEB_REMIX', { query, params: P.artists }, YTM));
  } catch (e) { /* ripiego sui canali */ }
  if (music.length) return music;
  const ch = await searchKind(query, P.channels, 'CHANNEL');
  return ch.map((c) => ({ ...c, id: c.title, author: 'Artista', kind: 'ARTIST', channelId: c.id }));
}

export async function related(id, music) {
  let list = null;
  if (music) {
    try {
      const r = collect(await post('next', 'WEB_REMIX', { videoId: id, playlistId: 'RDAMVM' + id, isAudioOnly: true }, YTM)).filter((i) => i.kind === 'VIDEO');
      if (r.length > 1) list = r;
    } catch (e) { /* ripiego */ }
  }
  if (!list) list = collect(await post('next', 'WEB', { videoId: id })).filter((i) => i.kind === 'VIDEO');
  const others = list.filter((v) => v.id !== id);
  return music ? clean(others) : others;
}

async function channelVideos(id) {
  let v = collect(await post('browse', 'WEB', { browseId: id, params: P.tabVideos })).filter((i) => i.kind === 'VIDEO');
  if (!v.length) v = collect(await post('browse', 'WEB', { browseId: id })).filter((i) => i.kind === 'VIDEO');
  return v;
}

async function channelPlaylists(id) {
  return collect(await post('browse', 'WEB', { browseId: id, params: P.tabPlaylists })).filter((i) => i.kind === 'PLAYLIST');
}

// ------------------------------------------------------------------ Filtri musica

const UNWANTED = /(extended|\b\d+\s*(hours?|ore|ora)\b|\b1\s*hour\b|full album|album completo|\bloop\b|nightcore|slowed|sped\s*up|reverb|8d audio|karaoke|mashup|megamix|mix \d{4}|compilation|playlist|non stop|nonstop)/i;
const NOT_A_SONG = /(incident|intervist|interview|\bnews\b|notizi|\btg\d*\b|telegiornale|reaction|reazione|podcast|backstage|vlog|documentari|trailer|parodia|tutorial|making of|dietro le quinte|conferenza|annuncia|ospedale|morto|morte|addio|malore|polemica|gossip|fidanzat|matrimonio|shorts?\b|#shorts)/i;
const MAX_SECONDS = 9 * 60;

function isSong(v, query = '') {
  return !(NOT_A_SONG.test(v.title) && !NOT_A_SONG.test(query));
}

function seconds(d) {
  const p = String(d || '').trim().split(':').map((x) => parseInt(x, 10));
  if (p.some((x) => Number.isNaN(x))) return null;
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
}

function clean(items, query = '') {
  const asked = UNWANTED.test(query);
  const out = items.filter((v) => {
    if (v.kind !== 'VIDEO') return true;
    if (!asked && UNWANTED.test(v.title)) return false;
    if (!isSong(v, query)) return false;
    const s = seconds(v.duration);
    return s == null || s <= MAX_SECONDS;
  });
  return out.length ? out : items;
}

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|ufficiale)\s*$/i, '').trim();
}

function songKey(title, artist = '') {
  let t = String(title || '').toLowerCase();
  t = t.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  t = t.replace(/\b(official|ufficiale|video|audio|lyrics?|testo|visualizer|hd|4k|remaster(ed)?|music)\b/g, ' ');
  if (artist) t = t.split(artist.toLowerCase()).join(' ');
  return t.replace(/feat\..*$|ft\..*$/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function dedupeSongs(list) {
  return distinctBy(list, (v) => songKey(v.title, cleanArtist(v.author)) || v.id);
}

function distinctBy(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => {
    const k = keyFn(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ Parser JSON

function text(n) {
  if (!n || typeof n !== 'object') return '';
  if (n.simpleText) return n.simpleText;
  if (typeof n.content === 'string' && n.content) return n.content;
  if (Array.isArray(n.runs)) return n.runs.map((r) => r.text || '').join('');
  return '';
}

function bestThumb(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let b = null;
  for (const t of arr) if (t && (!b || (t.width || 0) > (b.width || 0))) b = t;
  const u = b && b.url;
  if (!u) return null;
  return u.startsWith('//') ? 'https:' + u : u;
}

function square(u) {
  return u ? u.replace(/=w\d+-h\d+/, '=w320-h320') : u;
}

function findFirst(node, key) {
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findFirst(x, key);
      if (r !== undefined) return r;
    }
  } else if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const k of Object.keys(node)) {
      const r = findFirst(node[k], key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        const child = node[k];
        if (child && typeof child === 'object' && !Array.isArray(child) && visit(k, child)) continue;
        stack.push(child);
      }
    }
  }
}

const VIDEO_RENDERERS = new Set(['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer']);

/** Video, playlist e canali in qualsiasi risposta di search/browse/next. L'ordine segue la pagina. */
function collect(root) {
  const out = new Map();
  walk(root, (key, child) => {
    let item = null;
    if (VIDEO_RENDERERS.has(key)) item = videoItem(child);
    else if (key === 'playlistRenderer') item = playlistItem(child);
    else if (key === 'channelRenderer') item = channelItem(child);
    else if (key === 'lockupViewModel') item = lockupItem(child);
    else return false;
    if (item) {
      const k = item.kind + ':' + item.id;
      if (!out.has(k)) out.set(k, item);
    }
    return true;
  });
  return [...out.values()];
}

function videoItem(r) {
  const id = r.videoId;
  if (!id) return null;
  const owner = r.ownerText || r.shortBylineText || r.longBylineText;
  const live = !text(r.viewCountText) && !!r.badges;
  const ch = findFirst(owner, 'browseId');
  return {
    id,
    title: text(r.title),
    author: text(owner).split(' • ')[0],
    duration: text(r.lengthText) || (live ? 'LIVE' : ''),
    views: text(r.shortViewCountText) || text(r.viewCountText),
    published: text(r.publishedTimeText),
    thumb: bestThumb(r.thumbnail && r.thumbnail.thumbnails) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    kind: 'VIDEO',
    channelId: typeof ch === 'string' && ch.startsWith('UC') ? ch : '',
  };
}

function channelItem(r) {
  const id = r.channelId;
  if (!id) return null;
  const subs = text(r.subscriberCountText);
  return {
    id,
    title: text(r.title),
    author: subs.startsWith('@') ? subs : '',
    duration: '',
    views: text(r.videoCountText) || subs,
    thumb: bestThumb(r.thumbnail && r.thumbnail.thumbnails),
    kind: 'CHANNEL',
    channelId: id,
  };
}

function playlistItem(r) {
  const id = r.playlistId;
  if (!id) return null;
  const thumbs = (r.thumbnails && r.thumbnails[0] && r.thumbnails[0].thumbnails) || (r.thumbnail && r.thumbnail.thumbnails);
  return {
    id,
    title: text(r.title),
    author: text(r.shortBylineText || r.longBylineText),
    duration: text(r.videoCountText) || (r.videoCount ? r.videoCount + ' video' : ''),
    thumb: bestThumb(thumbs),
    kind: 'PLAYLIST',
    channelId: '',
  };
}

const PUBLISHED = /(\bfa$|\bago$|^(in streaming|trasmesso|streamed|premiered))/i;
const VIEWS = /(visualizzazion|views|spettatori|watching)/i;

function lockupItem(l) {
  const id = l.contentId;
  if (!id) return null;
  const type = l.contentType || '';
  const meta = l.metadata && l.metadata.lockupMetadataViewModel;
  const title = (meta && meta.title && meta.title.content) || '';
  const parts = [];
  const rows = meta && meta.metadata && meta.metadata.contentMetadataViewModel && meta.metadata.contentMetadataViewModel.metadataRows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      for (const mp of row.metadataParts || []) {
        const t = mp && mp.text && mp.text.content;
        if (t && t.trim()) parts.push(t);
      }
    }
  }
  const image = l.contentImage;
  const sources = findFirst(image, 'sources');
  const badgeVm = findFirst(image, 'thumbnailBadgeViewModel');
  const badge = (badgeVm && badgeVm.text) || '';
  const isList = ['PLAYLIST', 'ALBUM', 'PODCAST'].some((t) => type.includes(t));
  const published = parts.find((p) => PUBLISHED.test(p)) || '';
  const views = parts.find((p) => VIEWS.test(p)) || '';
  const rest = parts.filter((p) => p !== published && p !== views);
  return {
    id,
    title,
    author: rest[0] || '',
    duration: badge,
    views: [views, ...rest.slice(1)].filter(Boolean).join(' • '),
    published,
    thumb: bestThumb(sources) || (isList ? null : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    kind: isList ? 'PLAYLIST' : 'VIDEO',
    channelId: '',
  };
}

// ---------- YouTube Music

const RELEASE_TYPES = new Set(['Brano', 'Song', 'Video', 'Singolo', 'Single', 'EP', 'Album', 'Video musicale']);
const DURATION = /^\d{1,2}(:\d{2}){1,2}$/;

function flexCol(r, i) {
  const c = r.flexColumns && r.flexColumns[i];
  return c && c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text;
}

function parseMusic(root) {
  const out = new Map();
  walk(root, (key, child) => {
    let item = null;
    if (key === 'musicResponsiveListItemRenderer') item = musicItem(child);
    else if (key === 'musicTwoRowItemRenderer') item = twoRowSong(child);
    else return false;
    if (item && !out.has(item.id)) out.set(item.id, item);
    return true;
  });
  return [...out.values()];
}

function musicItem(r) {
  if (!r.flexColumns) return null;
  const id = (r.playlistItemData && r.playlistItemData.videoId) || findFirst(flexCol(r, 0), 'videoId');
  if (!id || typeof id !== 'string') return null;
  const parts = text(flexCol(r, 1)).split(' • ').map((s) => s.trim()).filter(Boolean);
  const duration = [...parts].reverse().find((p) => DURATION.test(p)) || '';
  const rest = parts.filter((p) => p !== duration && !['Brano', 'Song', 'Video'].includes(p));
  const ch = findFirst(flexCol(r, 1), 'browseId');
  return {
    id,
    title: text(flexCol(r, 0)),
    author: rest[0] || '',
    duration,
    views: rest.slice(1).join(' • '),
    thumb: square(bestThumb(findFirst(r.thumbnail, 'thumbnails'))) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    kind: 'VIDEO',
    channelId: typeof ch === 'string' && ch.startsWith('UC') ? ch : '',
  };
}

function twoRowSong(r) {
  const vid = findFirst(r.navigationEndpoint, 'videoId');
  if (!vid || typeof vid !== 'string') return null;
  const parts = text(r.subtitle).split(' • ').map((s) => s.trim()).filter(Boolean);
  const isViews = (p) => /visualizz|views/i.test(p);
  return {
    id: vid,
    title: text(r.title),
    author: parts.find((p) => !RELEASE_TYPES.has(p) && !isViews(p)) || '',
    duration: '',
    views: parts.find(isViews) || '',
    thumb: square(bestThumb(findFirst(r.thumbnailRenderer, 'thumbnails'))) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    kind: 'VIDEO',
    channelId: '',
  };
}

function parseReleases(root) {
  const out = new Map();
  walk(root, (key, child) => {
    if (key !== 'musicTwoRowItemRenderer') return false;
    const id = findFirst(child.navigationEndpoint, 'browseId');
    if (typeof id === 'string' && id.startsWith('MPRE') && !out.has(id)) {
      const parts = text(child.subtitle).split(' • ').map((s) => s.trim());
      out.set(id, {
        browseId: id,
        title: text(child.title),
        artist: parts.find((p) => !RELEASE_TYPES.has(p) && !/^\d{4}$/.test(p)) || '',
        type: parts.find((p) => RELEASE_TYPES.has(p)) || '',
        thumb: square(bestThumb(findFirst(child.thumbnailRenderer, 'thumbnails'))),
      });
    }
    return true;
  });
  return [...out.values()];
}

function parseMusicArtists(root) {
  const out = new Map();
  walk(root, (key, child) => {
    if (key !== 'musicResponsiveListItemRenderer') return false;
    const a = artistItem(child);
    if (a && !out.has(a.id.toLowerCase())) out.set(a.id.toLowerCase(), a);
    return true;
  });
  return [...out.values()];
}

function artistItem(r) {
  const browse = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
  if (!browse) return null;
  const channelId = browse.browseId;
  if (!channelId || !channelId.startsWith('UC')) return null;
  const pageType = findFirst(browse, 'pageType');
  if (pageType && !String(pageType).includes('ARTIST')) return null;
  const name = text(flexCol(r, 0));
  if (!name) return null;
  const info = text(flexCol(r, 1)).split(' • ').map((s) => s.trim()).filter((s) => s && s !== 'Artista' && s !== 'Artist');
  return {
    id: name,
    title: name,
    author: 'Artista',
    duration: '',
    views: info.join(' • '),
    thumb: square(bestThumb(findFirst(r.thumbnail, 'thumbnails'))),
    kind: 'ARTIST',
    channelId,
  };
}
