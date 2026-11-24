/* Tubetto Server (add-on Home Assistant) — interfaccia web senza pubblicità, stessa libreria dell'app. */
'use strict';

const APP_VERSION = '1.0.7';
const SERVER_MODE = true;
const SYNC_PATH = 'sync/tubetto-library.json';

// ============================================================ utilità

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem('tubetto.' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('tubetto.' + k, JSON.stringify(v)); } catch (e) { /* pieno */ }
  },
};

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}

function shuffled(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|ufficiale)\s*$/i, '').trim();
}

function songKey(title, artist = '') {
  let t = String(title || '').toLowerCase().replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  t = t.replace(/\b(official|ufficiale|video|audio|lyrics?|testo|visualizer|hd|4k|remaster(ed)?|music)\b/g, ' ');
  if (artist) t = t.split(String(artist).toLowerCase()).join(' ');
  return t.replace(/feat\..*$|ft\..*$/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
}

function dedupe(list) {
  const ids = new Set(), keys = new Set();
  return list.filter((v) => {
    if (!v || ids.has(v.id)) return false;
    const k = songKey(v.title, cleanArtist(v.author));
    if (k && keys.has(k)) return false;
    ids.add(v.id);
    if (k) keys.add(k);
    return true;
  });
}

const thumbOf = (v) => v.thumb || v.thumbnailUrl || (v.kind === 'VIDEO' || !v.kind ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : '');

// ============================================================ stato

let cfg = Object.assign({ worker: 'server', key: '', repo: 'mariopinola10/Tubetto', token: '' }, LS.get('cfg', {}));
cfg.worker = 'server';
{
  // aperto dalla rete di casa con ?key=… (fuori dal pannello di Home Assistant)
  const k = new URLSearchParams(location.search).get('key');
  if (k) { cfg.key = k; LS.set('cfg', cfg); history.replaceState(null, '', location.pathname); }
}
let lib = normLib(LS.get('lib', null));
let history = LS.get('history', []);
let artImg = LS.get('artImg', {});
let histDirty = LS.get('histDirty', false);

function normLib(o) {
  o = o || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const pl = {};
  if (o.playlists && typeof o.playlists === 'object') for (const k of Object.keys(o.playlists)) pl[k] = arr(o.playlists[k]);
  return { modified: Number(o.modified) || 0, favorites: arr(o.favorites), channels: arr(o.channels), artists: arr(o.artists), playlists: pl };
}

/** Elemento nel formato della libreria dell'app Android. */
function libItem(v, kind) {
  return {
    id: v.id, title: v.title || '', author: v.author || '', duration: v.duration || '',
    thumb: thumbOf(v), kind: kind || v.kind || 'VIDEO', channelId: v.channelId || '',
  };
}

function saveLib(changed = true) {
  if (changed) lib.modified = Date.now();
  mixCache = null;
  LS.set('lib', lib);
  if (changed) scheduleSync(3000);
  renderSidebar();
  refreshLikes();
}

// ============================================================ API (Cloudflare Worker)

const apiCache = new Map();

async function api(op, params = {}, ttlMs = 0) {
  if (cfg.key) params = { ...params, key: cfg.key };
  const qs = new URLSearchParams(params).toString();
  const url = 'api/' + op + (qs ? '?' + qs : '');
  if (ttlMs) {
    const c = apiCache.get(url);
    if (c && Date.now() - c.t < ttlMs) return c.d;
  }
  const r = await fetch(url);
  let d;
  try { d = await r.json(); } catch (e) { d = { error: 'Risposta non valida dal server (HTTP ' + r.status + ')' }; }
  if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
  if (ttlMs) apiCache.set(url, { t: Date.now(), d });
  return d;
}

async function artistThumb(name) {
  const k = name.toLowerCase();
  if (artImg[k] !== undefined) return artImg[k];
  try {
    const d = await api('artistimg', { name });
    artImg[k] = d.thumb || null;
    LS.set('artImg', artImg);
    return artImg[k];
  } catch (e) { return null; }
}

// ============================================================ Sincronizzazione GitHub

let syncTimer = null;
let syncing = false;

function ghHeaders() {
  return { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${SYNC_PATH}`, { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return null;
  if (r.status === 401) throw new Error('Token GitHub non valido o scaduto');
  if (!r.ok) throw new Error('Lettura GitHub fallita (HTTP ' + r.status + ')');
  const o = await r.json();
  let content = o.content;
  if (!content && o.download_url) {
    const raw = await fetch(o.git_url, { headers: ghHeaders() }).then((x) => x.json());
    content = raw.content;
  }
  return { data: JSON.parse(b64ToUtf8(content)), sha: o.sha };
}

async function ghPut(payload, sha) {
  const body = { message: 'Tubetto sync da PC (Tubetto Web)', content: utf8ToB64(JSON.stringify(payload)) };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${SYNC_PATH}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.ok) return true;
  if (r.status === 409 || r.status === 422) return false;
  if (r.status === 403 || r.status === 404) throw new Error('Il token non può scrivere nel repo: serve "Contents: Read and write"');
  throw new Error('Salvataggio GitHub fallito (HTTP ' + r.status + ')');
}

/** Unisce la cronologia remota: @return true se quella locale è cambiata. */
function mergeHistory(remote) {
  const map = new Map(history.map((h) => [h.id, h]));
  let changed = false;
  for (const o of remote) {
    if (!o || !o.id) continue;
    const h = map.get(o.id);
    if (!h) {
      map.set(o.id, { id: o.id, title: o.title || '', author: o.author || '', thumb: o.thumb || '', music: !!o.music, count: o.count || 1, last: o.last || 0 });
      changed = true;
    } else if ((o.last || 0) > h.last || (o.count || 0) > h.count) {
      h.count = Math.max(h.count, o.count || 0);
      h.last = Math.max(h.last, o.last || 0);
      changed = true;
    }
  }
  if (changed) {
    history = [...map.values()].sort((a, b) => b.last - a.last).slice(0, 300);
    LS.set('history', history);
  }
  return changed;
}

/** Il remoto non ha ancora qualcosa che abbiamo noi? */
function remoteLacks(remote) {
  const map = new Map((remote || []).filter(Boolean).map((o) => [o.id, o]));
  return history.some((h) => {
    const o = map.get(h.id);
    return !o || (o.last || 0) < h.last || (o.count || 0) < h.count;
  });
}

function setSyncStatus(s) {
  $('#syncStatus').textContent = s;
}

function scheduleSync(ms) {
  if (!cfg.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch((e) => setSyncStatus('⚠ ' + e.message)), ms);
}

async function sync(manual = false) {
  if (!cfg.token || !cfg.repo) {
    setSyncStatus('Sincronizzazione non configurata');
    if (manual) openSettings();
    return false;
  }
  if (syncing) return false;
  syncing = true;
  setSyncStatus('Sincronizzo…');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await ghGet();
      let libChanged = false;
      let histChanged = false;
      const rl = remote && remote.data && remote.data.library;
      if (rl && (Number(rl.modified) || 0) > lib.modified) {
        lib = normLib(rl);
        LS.set('lib', lib);
        libChanged = true;
      }
      const rh = remote && remote.data && Array.isArray(remote.data.history) ? remote.data.history : null;
      if (rh) histChanged = mergeHistory(rh);
      if (libChanged || histChanged) {
        renderSidebar();
        refreshLikes();
      }
      const remoteMod = (rl && Number(rl.modified)) || 0;
      const need = !remote || lib.modified > remoteMod || histDirty || remoteLacks(rh);
      if (!need) {
        histDirty = false;
        LS.set('histDirty', false);
        setSyncStatus('Sincronizzato ✓ ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
        return libChanged;
      }
      const payload = { version: 1, device: 'PC (Tubetto Web)', updated: Date.now(), library: lib, history: history.slice(0, 300) };
      if (await ghPut(payload, remote && remote.sha)) {
        histDirty = false;
        LS.set('histDirty', false);
        setSyncStatus('Sincronizzato ✓ ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
        return libChanged;
      }
      await sleep(700); // conflitto: un altro dispositivo ha appena salvato
    }
    throw new Error('conflitto ripetuto, riprovo più tardi');
  } catch (e) {
    setSyncStatus('⚠ ' + e.message);
    if (manual) toast(e.message, 4500);
    return false;
  } finally {
    syncing = false;
  }
}

// ============================================================ Cronologia

function recordListen(v, music) {
  const now = Date.now();
  let h = history.find((x) => x.id === v.id);
  if (h) {
    h.count++;
    h.last = now;
    h.title = v.title || h.title;
    h.author = v.author || h.author;
  } else {
    h = { id: v.id, title: v.title || '', author: v.author || '', thumb: thumbOf(v), music: !!music, count: 1, last: now };
    history.unshift(h);
  }
  history.sort((a, b) => b.last - a.last);
  if (history.length > 300) history.length = 300;
  LS.set('history', history);
  histDirty = true;
  LS.set('histDirty', true);
  scheduleSync(60000);
}

const histItem = (h) => ({ id: h.id, title: h.title, author: h.author, duration: '', thumb: h.thumb, kind: 'VIDEO', channelId: '' });

function topArtists(n) {
  const score = new Map();
  for (const h of history) {
    if (!h.music) continue;
    const a = cleanArtist(h.author);
    if (!a) continue;
    score.set(a, (score.get(a) || 0) + (h.count || 1));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

// ============================================================ Libreria: azioni

const isFav = (id) => lib.favorites.some((f) => f.id === id);

function toggleFav(v) {
  const i = lib.favorites.findIndex((f) => f.id === v.id);
  if (i >= 0) {
    lib.favorites.splice(i, 1);
    toast('Rimosso da Brani che ti piacciono');
  } else {
    lib.favorites.unshift(libItem(v, 'VIDEO'));
    toast('Aggiunto a Brani che ti piacciono ♥');
  }
  saveLib();
}

const isArtistFollowed = (name) => lib.artists.some((a) => a.id.toLowerCase() === String(name).toLowerCase());

function toggleArtist(name, thumb, channelId) {
  const i = lib.artists.findIndex((a) => a.id.toLowerCase() === name.toLowerCase());
  if (i >= 0) {
    lib.artists.splice(i, 1);
    toast('Non segui più ' + name);
  } else {
    lib.artists.unshift({ id: name, title: name, author: 'Artista', duration: '', thumb: thumb || '', kind: 'ARTIST', channelId: channelId || '' });
    toast('Ora segui ' + name);
  }
  saveLib();
}

const isChannelFollowed = (id) => lib.channels.some((c) => c.id === id);

function toggleChannel(c) {
  const i = lib.channels.findIndex((x) => x.id === c.id);
  if (i >= 0) {
    lib.channels.splice(i, 1);
    toast('Non segui più ' + c.title);
  } else {
    lib.channels.unshift(libItem(c, 'CHANNEL'));
    toast('Ora segui ' + c.title);
  }
  saveLib();
}

function addToPlaylist(name, v) {
  const list = lib.playlists[name] || (lib.playlists[name] = []);
  if (list.some((x) => x.id === v.id)) return toast('Già presente in ' + name);
  list.push(libItem(v, 'VIDEO'));
  saveLib();
  toast('Aggiunto a ' + name);
}

async function newPlaylist(firstItem) {
  const name = await promptModal('Nuova playlist', 'Nome della playlist', '');
  if (!name) return;
  if (lib.playlists[name]) return toast('Esiste già una playlist con questo nome');
  lib.playlists[name] = [];
  if (firstItem) lib.playlists[name].push(libItem(firstItem, 'VIDEO'));
  saveLib();
  toast('Playlist creata');
}

// ============================================================ Navigazione

let navStack = [];
let renderToken = 0;
const lists = {};
let listSeq = 0;

function go(name, args = {}, replace = false) {
  if (replace && navStack.length) navStack[navStack.length - 1] = { name, args };
  else navStack.push({ name, args });
  if (navStack.length > 40) navStack.shift();
  render();
}

function goRoot(name, args = {}) {
  navStack = [{ name, args }];
  render();
}

function back() {
  if (navStack.length > 1) {
    navStack.pop();
    render();
  }
}

function render() {
  const cur = navStack[navStack.length - 1];
  renderToken++;
  for (const k of Object.keys(lists)) if (k !== 'side') delete lists[k];
  $('#backBtn').disabled = navStack.length < 2;
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.nav === cur.name));
  $('#searchBox').classList.toggle('hidden', cur.name !== 'search');
  $('#sidebar').classList.remove('open');
  $('#main').scrollTop = 0;
  VIEWS[cur.name](cur.args, renderToken);
}

const stale = (token) => token !== renderToken;

/** Registra una lista di elementi cliccabili e restituisce il suo id. */
function regList(items, opts = {}) {
  const id = opts.id || 'l' + ++listSeq;
  lists[id] = { items, queue: opts.queue !== false, music: opts.music !== false, local: opts.local || null };
  return id;
}

// ============================================================ HTML: schede, scaffali, brani

function tileHTML(kind) {
  if (kind === 'mix') return '<div class="tile mix">✨</div>';
  if (kind === 'fav') return '<div class="tile fav">♥</div>';
  return '<div class="tile pl">♫</div>';
}

/** Copertine dei brani di una raccolta (mix, preferiti, playlist): per il mosaico 2×2. */
function collageThumbs(id) {
  id = String(id);
  const cover = (v) => thumbOf(v).replace('/hqdefault.jpg', '/mqdefault.jpg');
  let songs = null;
  if (id === 'tile:fav') songs = lib.favorites.filter((v) => !v.kind || v.kind === 'VIDEO');
  else if (id === 'tile:mix') {
    const fav = lib.favorites.filter((v) => !v.kind || v.kind === 'VIDEO');
    const top = history.filter((h) => h.music).sort((a, b) => b.count - a.count).map(histItem);
    songs = [];
    for (let i = 0; i < 4; i++) { if (fav[i]) songs.push(fav[i]); if (top[i]) songs.push(top[i]); }
  } else if (id.startsWith('local:')) songs = lib.playlists[id.slice(6)] || [];
  if (!songs) return null;
  return [...new Set(songs.map(cover).filter(Boolean))].slice(0, 4);
}

function collageHTML(thumbs, cls = '') {
  if (thumbs.length >= 4) return `<div class="collage ${cls}">${thumbs.map((t) => `<img loading="lazy" src="${esc(t)}" alt="">`).join('')}</div>`;
  return `<img class="${cls}" loading="lazy" src="${esc(thumbs[0])}" alt="">`;
}

function imgHTML(v) {
  const c = collageThumbs(v.id);
  if (c && c.length) return collageHTML(c);
  if (v.id === 'tile:mix') return tileHTML('mix');
  if (v.id === 'tile:fav') return tileHTML('fav');
  const t = thumbOf(v);
  if (!t) return tileHTML('pl');
  return `<img loading="lazy" src="${esc(t)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'tile pl',textContent:'♫'}))">`;
}

function cardHTML(listId, v, i, style) {
  const sub = v.kind === 'ARTIST' ? 'Artista'
    : v.kind === 'CHANNEL' ? (v.views || 'Canale')
    : v.kind === 'PLAYLIST' ? [v.author, v.duration].filter(Boolean).join(' • ') || 'Playlist'
    : [v.author, style === 'wide' ? v.views || v.published : ''].filter(Boolean).join(' • ');
  const badge = v.kind === 'VIDEO' && v.duration ? `<span class="badge">${esc(v.duration)}</span>` : '';
  const play = v.kind === 'VIDEO' || v.kind === 'PLAYLIST' || String(v.id).startsWith('tile:') || String(v.id).startsWith('local:')
    ? '<button class="hoverplay" data-act="play" title="Riproduci">▶</button>' : '';
  return `<div class="card ${style || ''}" role="button" tabindex="0" data-list="${listId}" data-idx="${i}">
    <div class="img">${imgHTML(v)}${badge}${play}</div>
    <div class="t">${esc(v.title)}</div>
    <div class="s">${esc(sub)}</div>
  </div>`;
}

function shelfStyle(items, style) {
  if (style) return style;
  const k = items[0] && items[0].kind;
  return k === 'ARTIST' || k === 'CHANNEL' ? 'round' : '';
}

function rowHTML(items, opts = {}) {
  const id = regList(items, opts);
  return `<div class="row">${items.map((v, i) => cardHTML(id, v, i, opts.style || (v.kind === 'ARTIST' || v.kind === 'CHANNEL' ? 'round' : ''))).join('')}</div>`;
}

function gridHTML(items, opts = {}) {
  const id = regList(items, opts);
  return `<div class="grid ${opts.style === 'wide' ? 'wide' : ''}">${items.map((v, i) => cardHTML(id, v, i, opts.style || (v.kind === 'ARTIST' || v.kind === 'CHANNEL' ? 'round' : ''))).join('')}</div>`;
}

function tracksHTML(items, opts = {}) {
  const id = regList(items, opts);
  const cur = currentItem();
  return `<div class="tracks">${items.map((v, i) => `
    <div class="track ${cur && cur.id === v.id ? 'playing' : ''}" data-list="${id}" data-idx="${i}" data-vid="${esc(v.id)}">
      <span class="n">${i + 1}</span>
      <img loading="lazy" src="${esc(thumbOf(v))}" alt="" onerror="this.style.visibility='hidden'">
      <div class="ellipsis"><div class="tt ellipsis">${esc(v.title)}</div><div class="ta ellipsis">${esc(v.author)}</div></div>
      <span class="td">${esc(v.duration || '')}</span>
      <button class="iconbtn like ${isFav(v.id) ? 'on' : ''}" data-act="like" data-vid="${esc(v.id)}" title="Mi piace">${isFav(v.id) ? '♥' : '♡'}</button>
      <button class="iconbtn" data-act="menu" title="Altro">⋯</button>
    </div>`).join('')}</div>`;
}

function refreshLikes() {
  $$('[data-act="like"][data-vid]').forEach((b) => {
    const on = isFav(b.dataset.vid);
    b.classList.toggle('on', on);
    b.textContent = on ? '♥' : '♡';
  });
  const cur = currentItem();
  const pb = $('#pbLike');
  const on = !!(cur && isFav(cur.id));
  pb.classList.toggle('on', on);
  pb.textContent = on ? '♥' : '♡';
}

function loadingHTML(msg = 'Caricamento…') {
  return `<div class="loading">${esc(msg)}</div>`;
}

function errorHTML(e) {
  return `<div class="empty">⚠ ${esc(e.message || e)}</div>`;
}

// ============================================================ Viste

const VIEWS = {
  home: viewHome,
  search: viewSearch,
  library: viewLibrary,
  artist: viewArtist,
  channel: viewChannel,
  playlist: viewPlaylist,
  local: viewLocal,
  favorites: viewFavorites,
  mix: viewMix,
};

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Buonanotte' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

async function myArtists(limit = 14) {
  const followed = lib.artists.slice();
  const names = new Set(followed.map((a) => a.id.toLowerCase()));
  const top = topArtists(limit).filter((n) => !names.has(n.toLowerCase()))
    .map((n) => ({ id: n, title: n, author: 'Artista', duration: '', thumb: '', kind: 'ARTIST', channelId: '' }));
  const all = [...followed, ...top].slice(0, limit);
  await Promise.all(all.map(async (a) => {
    if (!a.thumb) a.thumb = (await artistThumb(a.title)) || '';
  }));
  return all;
}

function myPlaylistTiles() {
  return [
    { id: 'tile:mix', title: 'Il mio mix', author: 'Creato per te', kind: 'PLAYLIST' },
    { id: 'tile:fav', title: 'Brani che ti piacciono', author: lib.favorites.length + ' brani', kind: 'PLAYLIST' },
    ...Object.keys(lib.playlists).map((name) => ({
      id: 'local:' + name, title: name, author: 'La mia playlist', duration: lib.playlists[name].length + ' brani',
      thumb: lib.playlists[name][0] ? thumbOf(lib.playlists[name][0]) : '', kind: 'PLAYLIST',
    })),
  ];
}

function musicShelves() {
  const recentMusic = history.filter((h) => h.music);
  const seeds = [...recentMusic.slice(0, 3).map((h) => h.id), ...lib.favorites.slice(0, 2).map((f) => f.id)];
  const top = topArtists(1)[0];
  return [
    { title: 'I tuoi artisti', style: 'round', queue: false, load: () => myArtists() },
    { title: 'Le tue playlist', queue: false, load: async () => myPlaylistTiles() },
    { title: 'Per te', load: async () => (seeds.length ? (await api('foryou', { ids: [...new Set(seeds)].join(',') }, 600000)).items.slice(0, 24) : []) },
    { title: '🔥 Hit del momento in Italia', load: async () => (await api('charts', {}, 1800000)).items.slice(0, 30) },
    { title: '🆕 Nuove uscite', load: async () => (await api('news', {}, 1800000)).items.slice(0, 24) },
    { title: 'Ascoltati di recente', load: async () => recentMusic.slice(0, 18).map(histItem) },
    { title: 'Playlist che potrebbero piacerti', queue: false, load: async () => (await api('search', { q: top ? top + ' playlist' : 'playlist hit italiane', type: 'playlists' }, 1800000)).items.slice(0, 16) },
  ];
}

function videoShelves() {
  const recentVideo = history.filter((h) => !h.music);
  return [
    {
      title: 'Video per te', style: 'wide', music: false,
      load: async () => {
        const seed = recentVideo[0];
        const d = seed ? await api('related', { id: seed.id, music: 0 }, 600000) : await api('search', { q: 'video musicali nuovi', type: 'videos' }, 1800000);
        return d.items.slice(0, 20);
      },
    },
    {
      title: 'Dai canali che segui', style: 'wide', music: false,
      load: async () => {
        const lists2 = await Promise.all(lib.channels.slice(0, 6).map((c) => api('channel', { id: c.id }, 1800000).then((d) => d.videos.slice(0, 4)).catch(() => [])));
        const out = [];
        for (let i = 0; i < 4; i++) for (const l of lists2) if (l[i]) out.push(l[i]);
        return out;
      },
    },
    { title: 'Canali che segui', style: 'round', queue: false, load: async () => lib.channels.slice() },
    { title: 'Visti di recente', style: 'wide', music: false, load: async () => recentVideo.slice(0, 16).map(histItem) },
  ];
}

async function viewHome(args, token) {
  const filter = args.filter || 'all';
  const view = $('#view');
  const m = musicShelves(), v = videoShelves();
  const shelves = filter === 'music' ? m : filter === 'video' ? v : [...m.slice(0, 2), v[0], ...m.slice(2), ...v.slice(1)];
  view.innerHTML = `
    <h1>${greeting()}${filter === 'video' ? ' 🎬' : ' 🎧'}</h1>
    <div class="chips">
      ${[['all', 'Tutti'], ['music', 'Musica'], ['video', 'Video']].map(([k, l]) => `<button class="chip ${k === filter ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}
    </div>
    ${history.length === 0 && lib.artists.length === 0 ? '<p class="sub">Ascolta qualcosa e segui i tuoi artisti: la home imparerà i tuoi gusti.</p>' : ''}
    ${shelves.map((s, i) => `<section class="shelf" id="shelf${i}"><div class="shelf-head"><h2>${esc(s.title)}</h2></div>${loadingHTML('')}</section>`).join('')}`;
  $$('.chip[data-filter]', view).forEach((b) => b.addEventListener('click', () => go('home', { filter: b.dataset.filter }, true)));
  shelves.forEach(async (s, i) => {
    let items = [];
    try { items = await s.load(); } catch (e) { items = []; }
    if (stale(token)) return;
    const el = $('#shelf' + i);
    if (!el) return;
    if (!items || !items.length) return el.remove();
    el.innerHTML = `<div class="shelf-head"><h2>${esc(s.title)}</h2></div>` + rowHTML(items, { style: s.style, queue: s.queue !== false, music: s.music !== false });
  });
}

let searchDebounce = null;

async function viewSearch(args, token) {
  const q = args.q || '';
  const type = args.type || 'songs';
  const input = $('#searchInput');
  if (input.value !== q) input.value = q;
  setTimeout(() => input.focus(), 0);
  const types = [['songs', 'Brani'], ['artists', 'Artisti'], ['playlists', 'Playlist'], ['videos', 'Video'], ['channels', 'Canali']];
  const view = $('#view');
  view.innerHTML = `
    <div class="chips">${types.map(([k, l]) => `<button class="chip ${k === type ? 'active' : ''}" data-type="${k}">${l}</button>`).join('')}</div>
    <div id="results">${q ? loadingHTML('Cerco…') : '<div class="empty">Cerca brani, artisti, playlist, video e canali</div>'}</div>`;
  $$('.chip[data-type]', view).forEach((b) => b.addEventListener('click', () => go('search', { q: $('#searchInput').value.trim(), type: b.dataset.type }, true)));
  if (!q) {
    if (!history.length) return;
    $('#results').innerHTML = '<h2>Ascoltati di recente</h2>' + tracksHTML(history.slice(0, 12).map(histItem));
    return;
  }
  try {
    const d = await api('search', { q, type }, 600000);
    if (stale(token)) return;
    const items = d.items || [];
    const box = $('#results');
    if (!items.length) return (box.innerHTML = '<div class="empty">Nessun risultato</div>');
    if (type === 'songs') box.innerHTML = tracksHTML(items);
    else if (type === 'videos') box.innerHTML = gridHTML(items, { style: 'wide', music: false });
    else box.innerHTML = gridHTML(items, { queue: false });
  } catch (e) {
    if (!stale(token)) $('#results').innerHTML = errorHTML(e);
  }
}

async function viewLibrary(args) {
  const f = args.filter || 'all';
  const view = $('#view');
  const parts = [];
  if (f === 'all' || f === 'playlists') parts.push(...myPlaylistTiles());
  if (f === 'all' || f === 'artists') parts.push(...lib.artists.map((a) => ({ ...a, thumb: a.thumb || artImg[a.title.toLowerCase()] || '' })));
  if (f === 'all' || f === 'channels') parts.push(...lib.channels);
  view.innerHTML = `
    <h1>La tua libreria</h1>
    <div class="chips">
      ${[['all', 'Tutto'], ['playlists', 'Playlist'], ['artists', 'Artisti'], ['channels', 'Canali']].map(([k, l]) => `<button class="chip ${k === f ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}
      <button class="chip" id="libNewPl">＋ Nuova playlist</button>
    </div>
    ${parts.length ? gridHTML(parts, { queue: false }) : '<div class="empty">La libreria è vuota</div>'}`;
  $$('.chip[data-filter]', view).forEach((b) => b.addEventListener('click', () => go('library', { filter: b.dataset.filter }, true)));
  $('#libNewPl').addEventListener('click', () => newPlaylist().then(() => render()));
}

function heroHTML({ cover, round, kind, title, sub, collage }) {
  const img = collage && collage.length ? `<div class="cover">${collageHTML(collage)}</div>`
    : cover === 'mix' || cover === 'fav' ? `<div class="cover">${tileHTML(cover)}</div>`
    : cover ? `<img class="cover ${round ? 'round' : ''}" src="${esc(cover)}" alt="">`
    : `<div class="cover ${round ? 'round' : ''}">${tileHTML('pl')}</div>`;
  return `<div class="hero">${img}<div><div class="kind">${esc(kind)}</div><h1>${esc(title)}</h1><div class="sub">${esc(sub || '')}</div></div></div>`;
}

function playActions(items, music, extra = '') {
  const id = 'pa' + ++listSeq;
  setTimeout(() => {
    const play = $('#' + id + 'p'), sh = $('#' + id + 's');
    if (play) play.addEventListener('click', () => items.length && playQueue(items, 0, music));
    if (sh) sh.addEventListener('click', () => items.length && playQueue(shuffled(items), 0, music));
  }, 0);
  return `<div class="actions"><button class="bigplay" id="${id}p" title="Riproduci">▶</button><button class="outline" id="${id}s">🔀 Casuale</button>${extra}</div>`;
}

async function viewArtist(args, token) {
  const name = args.name;
  const view = $('#view');
  view.innerHTML = heroHTML({ cover: args.thumb || artImg[name.toLowerCase()], round: true, kind: 'Artista', title: name }) + loadingHTML();
  try {
    const d = await api('artist', { name, channelId: args.channelId || '' }, 1800000);
    if (stale(token)) return;
    const cover = d.thumb || args.thumb || artImg[name.toLowerCase()];
    if (d.thumb) { artImg[name.toLowerCase()] = d.thumb; LS.set('artImg', artImg); }
    const all = dedupe([...(d.latest || []), ...(d.top || [])]);
    const followed = isArtistFollowed(name);
    view.innerHTML = heroHTML({ cover, round: true, kind: 'Artista', title: name, sub: (d.latest || []).length ? 'Dalle uscite più recenti ai brani più ascoltati' : '' })
      + playActions(all, true,
        `<button class="outline ${followed ? 'on' : ''}" id="followArtist">${followed ? '✓ Segui già' : '＋ Segui'}</button>`
        + (d.channelId ? '<button class="outline" id="artistChannel">Canale YouTube</button>' : ''))
      + ((d.latest || []).length ? '<h2>Dalle più recenti</h2>' + tracksHTML(d.latest) : '')
      + ((d.top || []).length ? '<h2>Brani più ascoltati</h2>' + tracksHTML(d.top) : '')
      + ((d.playlists || []).length ? '<h2>Playlist</h2>' + rowHTML(d.playlists, { queue: false }) : '');
    $('#followArtist').addEventListener('click', () => { toggleArtist(name, cover, d.channelId); render(); });
    const chBtn = $('#artistChannel');
    if (chBtn) chBtn.addEventListener('click', () => go('channel', { id: d.channelId, title: name, thumb: cover }));
  } catch (e) {
    if (!stale(token)) view.insertAdjacentHTML('beforeend', errorHTML(e));
  }
}

async function viewChannel(args, token) {
  const view = $('#view');
  view.innerHTML = heroHTML({ cover: args.thumb, round: true, kind: 'Canale', title: args.title || 'Canale' }) + loadingHTML();
  try {
    const d = await api('channel', { id: args.id }, 1800000);
    if (stale(token)) return;
    const followed = isChannelFollowed(args.id);
    view.innerHTML = heroHTML({ cover: args.thumb, round: true, kind: 'Canale', title: args.title || 'Canale', sub: 'Video dal più recente' })
      + playActions(d.videos || [], false, `<button class="outline ${followed ? 'on' : ''}" id="followCh">${followed ? '✓ Segui già' : '＋ Segui canale'}</button>`)
      + ((d.videos || []).length ? '<h2>Video</h2>' + gridHTML(d.videos, { style: 'wide', music: false }) : '<div class="empty">Nessun video</div>')
      + ((d.playlists || []).length ? '<h2>Playlist</h2>' + rowHTML(d.playlists, { queue: false }) : '');
    $('#followCh').addEventListener('click', () => {
      toggleChannel({ id: args.id, title: args.title || 'Canale', thumb: args.thumb || '', kind: 'CHANNEL' });
      render();
    });
  } catch (e) {
    if (!stale(token)) view.insertAdjacentHTML('beforeend', errorHTML(e));
  }
}

async function viewPlaylist(args, token) {
  const view = $('#view');
  view.innerHTML = heroHTML({ cover: args.thumb, kind: 'Playlist', title: args.title || 'Playlist' }) + loadingHTML();
  try {
    const d = await api('playlist', { id: args.id }, 1800000);
    if (stale(token)) return;
    const items = d.items || [];
    const title = args.title || d.title || 'Playlist';
    view.innerHTML = heroHTML({ cover: args.thumb || (items[0] && thumbOf(items[0])), kind: 'Playlist', title, sub: items.length + ' brani' })
      + playActions(items, true, '<button class="outline" id="savePl">＋ Salva nella libreria</button>')
      + (items.length ? tracksHTML(items) : '<div class="empty">Playlist vuota o privata</div>');
    $('#savePl').addEventListener('click', () => {
      let name = title, n = 2;
      while (lib.playlists[name]) name = `${title} (${n++})`;
      lib.playlists[name] = items.map((v) => libItem(v, 'VIDEO'));
      saveLib();
      toast('Salvata come "' + name + '"');
    });
  } catch (e) {
    if (!stale(token)) view.insertAdjacentHTML('beforeend', errorHTML(e));
  }
}

function viewLocal(args) {
  const name = args.name;
  const items = lib.playlists[name];
  const view = $('#view');
  if (!items) {
    view.innerHTML = '<div class="empty">Playlist non trovata</div>';
    return;
  }
  view.innerHTML = heroHTML({ cover: items[0] ? thumbOf(items[0]) : '', collage: collageThumbs('local:' + name), kind: 'La mia playlist', title: name, sub: items.length + ' brani' })
    + playActions(items, true, '<button class="outline" id="renPl">✎ Rinomina</button><button class="outline" id="delPl">🗑 Elimina</button>')
    + (items.length ? tracksHTML(items, { local: name }) : '<div class="empty">Aggiungi brani dal menu ⋯ di qualsiasi brano</div>');
  $('#renPl').addEventListener('click', async () => {
    const nn = await promptModal('Rinomina playlist', 'Nuovo nome', name);
    if (!nn || nn === name) return;
    if (lib.playlists[nn]) return toast('Nome già usato');
    const copy = {};
    for (const k of Object.keys(lib.playlists)) copy[k === name ? nn : k] = lib.playlists[k];
    lib.playlists = copy;
    saveLib();
    go('local', { name: nn }, true);
  });
  $('#delPl').addEventListener('click', async () => {
    if (!(await confirmModal('Eliminare la playlist "' + name + '"?'))) return;
    delete lib.playlists[name];
    saveLib();
    navStack.length > 1 ? back() : goRoot('library');
  });
}

function viewFavorites() {
  const items = lib.favorites.filter((v) => !v.kind || v.kind === 'VIDEO');
  $('#view').innerHTML = heroHTML({ cover: 'fav', collage: collageThumbs('tile:fav'), kind: 'Playlist', title: 'Brani che ti piacciono', sub: items.length + ' brani' })
    + playActions(items, true)
    + (items.length ? tracksHTML(items) : '<div class="empty">Tocca ♡ su un brano per aggiungerlo qui</div>');
}

let mixCache = null;

async function buildMix() {
  if (mixCache && Date.now() - mixCache.t < 30 * 60000) return mixCache.items;
  const fav = shuffled(lib.favorites.filter((v) => !v.kind || v.kind === 'VIDEO')).slice(0, 30);
  const top = history.filter((h) => h.music).sort((a, b) => b.count - a.count).slice(0, 20).map(histItem);
  const seeds = [...new Set([...fav.slice(0, 3), ...top.slice(0, 2)].map((x) => x.id))];
  const [sim, artistSongs] = await Promise.all([
    seeds.length ? api('foryou', { ids: seeds.join(',') }, 600000).then((d) => d.items.slice(0, 30)).catch(() => []) : Promise.resolve([]),
    Promise.all(lib.artists.slice(0, 6).map((a) => api('search', { q: a.title, type: 'songs' }, 1800000).then((d) => d.items.slice(0, 3)).catch(() => []))).then((l) => l.flat()),
  ]);
  const sources = [fav, sim, top, shuffled(artistSongs)];
  const out = [];
  for (let i = 0; i < 40; i++) for (const s of sources) if (s[i]) out.push(s[i]);
  const items = dedupe(out).slice(0, 80);
  if (items.length) mixCache = { t: Date.now(), items };
  return items;
}

async function viewMix(args, token) {
  const view = $('#view');
  view.innerHTML = heroHTML({ cover: 'mix', collage: collageThumbs('tile:mix'), kind: 'Playlist', title: 'Il mio mix', sub: 'Preferiti, artisti che segui e brani simili, senza doppioni' }) + loadingHTML('Compongo il mix…');
  const items = await buildMix();
  if (stale(token)) return;
  view.innerHTML = heroHTML({ cover: 'mix', collage: collageThumbs('tile:mix'), kind: 'Playlist', title: 'Il mio mix', sub: items.length + ' brani • preferiti, artisti che segui e brani simili' })
    + playActions(items, true, '<button class="outline" id="remix">⟳ Rigenera</button>')
    + (items.length ? tracksHTML(items) : '<div class="empty">Aggiungi qualche preferito o segui un artista per creare il mix</div>');
  $('#remix').addEventListener('click', () => { mixCache = null; render(); });
}

// ============================================================ Barra laterale

function renderSidebar() {
  const items = [
    { id: 'tile:mix', title: 'Il mio mix', author: 'Playlist • creata per te', tile: 'mix' },
    { id: 'tile:fav', title: 'Brani che ti piacciono', author: 'Playlist • ' + lib.favorites.length + ' brani', tile: 'fav' },
    ...Object.keys(lib.playlists).map((n) => ({ id: 'local:' + n, title: n, author: 'Playlist • ' + lib.playlists[n].length + ' brani', thumb: lib.playlists[n][0] ? thumbOf(lib.playlists[n][0]) : '', kind: 'PLAYLIST' })),
    ...lib.artists.map((a) => ({ ...a, author: 'Artista', round: true, thumb: a.thumb || artImg[a.title.toLowerCase()] || '' })),
    ...lib.channels.map((c) => ({ ...c, author: 'Canale', round: true })),
  ];
  const id = regList(items, { queue: false, id: 'side' });
  $('#sideList').innerHTML = items.map((v, i) => `
    <button class="sideitem ${v.round ? 'round' : ''}" data-list="${id}" data-idx="${i}">
      ${(collageThumbs(v.id) || []).length ? collageHTML(collageThumbs(v.id)) : v.tile ? tileHTML(v.tile) : v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="">` : tileHTML('pl')}
      <div class="ellipsis"><div class="t ellipsis">${esc(v.title)}</div><div class="s ellipsis">${esc(v.author)}</div></div>
    </button>`).join('');
}

// ============================================================ Clic su elementi

function openItem(listId, idx, forcePlay = false) {
  const l = lists[listId];
  if (!l) return;
  const v = l.items[idx];
  if (!v) return;
  const id = String(v.id);
  if (id === 'tile:mix') {
    if (forcePlay) return buildMix().then((items) => items.length && playQueue(items, 0, true));
    return go('mix');
  }
  if (id === 'tile:fav') {
    if (forcePlay) return lib.favorites.length && playQueue(lib.favorites, 0, true);
    return go('favorites');
  }
  if (id.startsWith('local:')) {
    const name = id.slice(6);
    if (forcePlay) return (lib.playlists[name] || []).length && playQueue(lib.playlists[name], 0, true);
    return go('local', { name });
  }
  if (v.kind === 'ARTIST') return go('artist', { name: v.title, channelId: v.channelId || '', thumb: v.thumb || '' });
  if (v.kind === 'CHANNEL') return go('channel', { id: v.channelId || v.id, title: v.title, thumb: v.thumb || '' });
  if (v.kind === 'PLAYLIST') {
    if (forcePlay) {
      return api('playlist', { id: v.id }, 1800000).then((d) => d.items.length && playQueue(d.items, 0, true)).catch((e) => toast(e.message));
    }
    return go('playlist', { id: v.id, title: v.title, thumb: v.thumb || '' });
  }
  // brano/video: la coda prosegue con gli altri della stessa lista
  if (l.queue) {
    const vids = l.items.filter((x) => !x.kind || x.kind === 'VIDEO');
    playQueue(vids, Math.max(0, vids.indexOf(v)), l.music);
  } else {
    playQueue([v], 0, l.music);
  }
}

function onListClick(e) {
  const el = e.target.closest('[data-list]');
  if (!el) return;
  const listId = el.dataset.list;
  const idx = Number(el.dataset.idx);
  const l = lists[listId];
  if (!l) return;
  const actEl = e.target.closest('[data-act]');
  const act = actEl && el.contains(actEl) ? actEl.dataset.act : null;
  if (act === 'like') {
    e.stopPropagation();
    toggleFav(l.items[idx]);
    return;
  }
  if (act === 'menu') {
    e.stopPropagation();
    showItemMenu(l, idx, e.clientX, e.clientY);
    return;
  }
  openItem(listId, idx, act === 'play');
}

function onListContext(e) {
  const el = e.target.closest('[data-list]');
  if (!el) return;
  const l = lists[el.dataset.list];
  if (!l) return;
  e.preventDefault();
  showItemMenu(l, Number(el.dataset.idx), e.clientX, e.clientY);
}

// ============================================================ Menu contestuale

function showMenu(entries, x, y) {
  const m = $('#ctxmenu');
  m.innerHTML = entries.map((en, i) => (en === '-' ? '<hr>' : `<button data-i="${i}">${esc(en.label)}</button>`)).join('');
  m.classList.remove('hidden');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    hideMenu();
    const en = entries[Number(b.dataset.i)];
    if (en && en.run) en.run();
  };
}

function hideMenu() {
  $('#ctxmenu').classList.add('hidden');
}

function playlistPicker(v, x, y) {
  const names = Object.keys(lib.playlists);
  showMenu([
    { label: '＋ Nuova playlist…', run: () => newPlaylist(v) },
    ...(names.length ? ['-'] : []),
    ...names.map((n) => ({ label: '♫ ' + n, run: () => addToPlaylist(n, v) })),
  ], x, y);
}

function showItemMenu(l, idx, x, y) {
  const v = l.items[idx];
  if (!v) return;
  const id = String(v.id);
  const entries = [];
  if (id.startsWith('tile:')) return;
  if (id.startsWith('local:')) {
    const name = id.slice(6);
    entries.push({ label: '▶ Riproduci', run: () => (lib.playlists[name] || []).length && playQueue(lib.playlists[name], 0, true) });
    entries.push({ label: '🗑 Elimina playlist', run: async () => { if (await confirmModal('Eliminare "' + name + '"?')) { delete lib.playlists[name]; saveLib(); render(); } } });
  } else if (v.kind === 'ARTIST') {
    const f = isArtistFollowed(v.title);
    entries.push({ label: f ? '✕ Smetti di seguire' : '＋ Segui artista', run: () => { toggleArtist(v.title, v.thumb, v.channelId); render(); } });
  } else if (v.kind === 'CHANNEL') {
    const f = isChannelFollowed(v.channelId || v.id);
    entries.push({ label: f ? '✕ Smetti di seguire' : '＋ Segui canale', run: () => { toggleChannel({ ...v, id: v.channelId || v.id }); render(); } });
  } else if (v.kind === 'PLAYLIST') {
    entries.push({ label: '▶ Riproduci', run: () => openItem(regList([v]), 0, true) });
    entries.push({ label: '↗ Apri su YouTube', run: () => window.open('https://www.youtube.com/playlist?list=' + encodeURIComponent(v.id), '_blank') });
  } else {
    const music = l.music;
    entries.push({ label: '▶ Riproduci', run: () => playQueue([v], 0, music) });
    entries.push({ label: '⏭ Riproduci dopo', run: () => playNext(v) });
    entries.push({ label: '➕ Aggiungi alla coda', run: () => { enqueue(v); toast('Aggiunto alla coda'); } });
    entries.push('-');
    entries.push({ label: isFav(v.id) ? '♥ Rimuovi da Mi piace' : '♡ Mi piace', run: () => toggleFav(v) });
    entries.push({ label: '♫ Aggiungi a playlist…', run: () => setTimeout(() => playlistPicker(v, x, y), 0) });
    if (l.local) entries.push({ label: '✕ Rimuovi da questa playlist', run: () => { const pl = lib.playlists[l.local]; if (pl) { lib.playlists[l.local] = pl.filter((x2) => x2.id !== v.id); saveLib(); render(); } } });
    entries.push('-');
    const artist = cleanArtist(v.author);
    if (artist) entries.push({ label: '👤 Vai all\'artista: ' + artist, run: () => go('artist', { name: artist, channelId: '' }) });
    entries.push({ label: '📻 Avvia radio', run: () => startRadio(v, music) });
    entries.push({ label: '↗ Apri su YouTube', run: () => window.open('https://www.youtube.com/watch?v=' + encodeURIComponent(v.id), '_blank') });
    entries.push({ label: '🔗 Copia link', run: () => navigator.clipboard.writeText('https://youtu.be/' + v.id).then(() => toast('Link copiato')) });
  }
  showMenu(entries, x, y);
}

// ============================================================ Finestre

function closeModal() {
  $('#modal').classList.add('hidden');
}

function promptModal(title, label, value) {
  return new Promise((resolve) => {
    $('#modalBox').innerHTML = `<h3>${esc(title)}</h3><label>${esc(label)}</label><input type="text" id="pmInput" value="${esc(value)}">
      <div class="btns"><button class="secondary" id="pmCancel">Annulla</button><button class="primary" id="pmOk">OK</button></div>`;
    $('#modal').classList.remove('hidden');
    const inp = $('#pmInput');
    inp.focus();
    inp.select();
    const done = (v) => { closeModal(); resolve(v); };
    $('#pmOk').onclick = () => done(inp.value.trim());
    $('#pmCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null); };
  });
}

function confirmModal(msg) {
  return new Promise((resolve) => {
    $('#modalBox').innerHTML = `<h3>${esc(msg)}</h3><div class="btns"><button class="secondary" id="cmNo">Annulla</button><button class="primary" id="cmYes">Sì</button></div>`;
    $('#modal').classList.remove('hidden');
    $('#cmYes').onclick = () => { closeModal(); resolve(true); };
    $('#cmNo').onclick = () => { closeModal(); resolve(false); };
  });
}

function openSettings() {
  $('#modalBox').innerHTML = `
    <h3>Impostazioni</h3>
    <label>Repository GitHub (utente/repo)</label>
    <input type="text" id="sRepo" value="${esc(cfg.repo)}">
    <label>Token GitHub (lo stesso dell'app)</label>
    <input type="password" id="sToken" value="${esc(cfg.token)}" placeholder="github_pat_…">
    <div class="hint">Di solito si compilano da soli con i valori della configurazione dell'add-on in Home Assistant.</div>
    <div id="testResult">Carico lo stato…</div>
    <div class="btns">
      <button class="secondary" id="sClose">Chiudi</button>
      <button class="primary" id="sSave">Salva</button>
    </div>
    <div class="hint" style="margin-top:14px">Tubetto Server ${APP_VERSION} • Spazio = play/pausa, N = successivo, P = precedente, L = mi piace</div>`;
  $('#modal').classList.remove('hidden');
  api('status').then((st) => {
    const s = st.stream || {};
    $('#testResult').textContent = [
      `Server ${st.version} • configurazione client: ${st.config}`,
      `Brani avviati: ${s.ok || 0} • falliti: ${s.fail || 0}` + (s.consecutiveFail ? ` (di fila: ${s.consecutiveFail})` : ''),
      s.lastOk ? 'Ultimo ok: ' + s.lastOk : '',
      s.lastError ? 'Ultimo errore: ' + s.lastError : '',
      `Ordine client: ${(s.order || []).join(' → ')}` + ((s.excluded || []).length ? ` (esclusi: ${s.excluded.join(', ')})` : ''),
      s.innertubeDown ? 'YouTube blocca le richieste dirette: uso yt-dlp con PO token' : '',
      s.cookies ? 'Cookie account: attivi' : '',
      `Stream per Music Assistant: ${st.streamBase}`,
    ].filter(Boolean).join('\n');
  }).catch((e) => { $('#testResult').textContent = '❌ ' + e.message; });
  $('#sClose').onclick = closeModal;
  $('#sSave').onclick = async () => {
    cfg.repo = $('#sRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
    cfg.token = $('#sToken').value.trim();
    LS.set('cfg', cfg);
    closeModal();
    toast('Impostazioni salvate');
    if (cfg.token) await sync(true);
    goRoot('home');
  };
}

// ============================================================ Player (stream dal server, senza pubblicità) + "Suona in casa"

const pl = {
  queue: [], idx: -1, music: true,
  shuffle: LS.get('shuffle', false), repeat: false,
  playing: false, recorded: false, dragging: false,
  skips: 0, extending: false, retried: false,
  target: LS.get('target', 'local'),          // 'local' = questo dispositivo, 'house' = Music Assistant
  players: LS.get('housePlayers', []),        // entity_id delle stanze scelte
  house: null,                                // ultimo stato letto da Home Assistant
};

const media = () => $('#media');
const isHouse = () => pl.target === 'house' && pl.players.length > 0;

function currentItem() {
  return pl.idx >= 0 ? pl.queue[pl.idx] : null;
}

function keyQs() {
  return cfg.key ? '?key=' + encodeURIComponent(cfg.key) : '';
}

function postApi(op, body) {
  return fetch('api/' + op + keyQs(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  });
}

function initMedia() {
  const m = media();
  m.volume = Number($('#pbVol').value) / 100;
  m.addEventListener('playing', () => {
    pl.playing = true;
    pl.skips = 0;
    pl.retried = false;
    const v = currentItem();
    if (v && !pl.recorded) {
      pl.recorded = true;
      recordListen(v, pl.music);
      // prepara già il brano successivo sul server
      const n = pl.queue[pl.idx + 1];
      if (n) api('prefetch', { id: n.id }).catch(() => null);
    }
    refreshPlayButton();
  });
  m.addEventListener('pause', () => { pl.playing = false; refreshPlayButton(); });
  m.addEventListener('ended', () => { pl.playing = false; next(true); });
  m.addEventListener('error', onMediaError);
}

function refreshPlayButton() {
  const playing = isHouse() ? !!(pl.house && pl.house.state === 'playing') : pl.playing;
  $('#pbPlay').textContent = playing ? '⏸' : '▶';
  const v = currentItem();
  document.title = (playing ? '▶ ' : '') + (v ? v.title + ' — Tubetto' : 'Tubetto');
}

function srcFor(v, kind, t = 0) {
  const q = new URLSearchParams();
  if (cfg.key) q.set('key', cfg.key);
  if (t > 0) q.set('t', String(Math.floor(t)));
  const qs = q.toString();
  return `${kind === 'video' ? 'video' : 'stream'}/${encodeURIComponent(v.id)}${qs ? '?' + qs : ''}`;
}

/** Durata dal testo "3:21" (per gli stream HLS il browser non la conosce). */
function itemSeconds(v) {
  const p = String((v && v.duration) || '').split(':').map(Number);
  if (!p.length || p.some((x) => Number.isNaN(x))) return 0;
  return p.reduce((a, x) => a * 60 + x, 0);
}

/** Posizione e durata reali, anche per gli stream HLS (che ripartono da un punto: pl.offset). */
function localTimes() {
  const m = media();
  const v = currentItem();
  if (isFinite(m.duration) && m.duration > 0) return { c: m.currentTime || 0, d: m.duration, live: false };
  return { c: (pl.offset || 0) + (m.currentTime || 0), d: itemSeconds(v), live: true };
}

function playQueue(items, idx, music = true) {
  if (!items || !items.length) return;
  pl.queue = items.map((v) => ({ ...v }));
  pl.idx = Math.min(Math.max(0, idx), pl.queue.length - 1);
  pl.music = music;
  if (isHouse()) return houseSend();
  setVideoPanelFor(music);
  playCurrent();
}

function playCurrent() {
  const v = currentItem();
  if (!v) return;
  if (isHouse()) return houseSend();
  pl.recorded = false;
  pl.retried = false;
  pl.offset = 0;
  const m = media();
  m.src = srcFor(v, pl.music ? 'audio' : 'video');
  m.play().catch(() => { /* serve un tocco dell'utente */ });
  updateNowPlaying();
  if (pl.idx >= pl.queue.length - 2) extendQueue();
}

function onMediaError() {
  const v = currentItem();
  if (!v || isHouse()) return;
  const m = media();
  if (!pl.music && m.src.includes('/video/')) {
    toast('Video non disponibile: riproduco solo l\'audio');
    m.src = srcFor(v, 'audio');
    m.play().catch(() => null);
    return;
  }
  if (!pl.retried) {
    pl.retried = true;
    m.src = srcFor(v, 'audio', pl.offset || 0);
    m.play().catch(() => null);
    return;
  }
  pl.skips++;
  if (pl.skips > 5) return toast('Troppi brani non riproducibili di seguito: mi fermo. Controlla "Stato" nelle impostazioni.', 5000);
  toast('Brano non riproducibile, passo al successivo');
  setTimeout(() => { if (currentItem() === v) next(); }, 800);
}

function next(auto = false) {
  if (!pl.queue.length) return;
  if (isHouse()) return houseCmd('next');
  if (auto && pl.repeat) {
    media().currentTime = 0;
    media().play();
    return;
  }
  if (pl.shuffle && pl.queue.length > 1) {
    let i;
    do { i = Math.floor(Math.random() * pl.queue.length); } while (i === pl.idx);
    pl.idx = i;
    return playCurrent();
  }
  if (pl.idx + 1 < pl.queue.length) {
    pl.idx++;
    return playCurrent();
  }
  extendQueue().then((added) => {
    if (added) {
      pl.idx++;
      playCurrent();
    } else toast('Fine della coda');
  });
}

function prev() {
  if (!pl.queue.length) return;
  if (isHouse()) return houseCmd('previous');
  if (localTimes().c > 4) { seekTo(0); return; }
  if (pl.idx > 0) {
    pl.idx--;
    playCurrent();
  } else media().currentTime = 0;
}

/** A fine coda continua con brani simili, come la radio dell'app. */
async function extendQueue() {
  if (pl.extending || !pl.queue.length) return false;
  pl.extending = true;
  try {
    const last = pl.queue[pl.queue.length - 1];
    const d = await api('related', { id: last.id, music: pl.music ? 1 : 0 }, 600000);
    const have = new Set(pl.queue.map((v) => v.id));
    const add = dedupe([...pl.queue, ...d.items]).filter((v) => !have.has(v.id)).slice(0, 20);
    pl.queue.push(...add);
    renderQueue();
    return add.length > 0;
  } catch (e) {
    return false;
  } finally {
    pl.extending = false;
  }
}

function startRadio(v, music = true) {
  playQueue([v], 0, music);
  toast('📻 Radio avviata: seguiranno brani simili');
}

function playNext(v) {
  if (!pl.queue.length) return playQueue([v], 0, true);
  pl.queue.splice(pl.idx + 1, 0, { ...v });
  renderQueue();
  if (isHouse()) toast('In casa la coda è gestita da Music Assistant: avvio da qui');
  else toast('Riprodurrò dopo: ' + v.title);
  if (isHouse()) houseSend();
}

function enqueue(v) {
  if (!pl.queue.length) return playQueue([v], 0, true);
  pl.queue.push({ ...v });
  renderQueue();
}

function togglePlay() {
  if (!currentItem()) return;
  if (isHouse()) return houseCmd(pl.house && pl.house.state === 'playing' ? 'pause' : 'play');
  const m = media();
  if (m.paused) m.play().catch(() => null);
  else m.pause();
}

function updateNowPlaying() {
  const v = currentItem();
  if (!v) return;
  $('#pbThumb').src = thumbOf(v);
  $('#pbTitle').textContent = v.title || 'Caricamento…';
  $('#pbTitle').title = v.title || '';
  $('#pbArtist').textContent = v.author || '';
  $('#vpTitle').textContent = v.title || 'Video';
  refreshLikes();
  refreshPlayButton();
  $$('.track[data-vid]').forEach((t) => t.classList.toggle('playing', t.dataset.vid === v.id));
  renderQueue();
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: v.title || '', artist: v.author || '', artwork: [{ src: thumbOf(v), sizes: '320x320' }] });
    } catch (e) { /* non supportato */ }
  }
}

function renderQueue() {
  if ($('#queuePanel').classList.contains('hidden')) return;
  const box = $('#queueList');
  box.innerHTML = pl.queue.map((v, i) => `
    <div class="track ${i === pl.idx ? 'playing' : ''}" data-q="${i}">
      <span class="n">${i === pl.idx ? '▶' : i + 1}</span>
      <img loading="lazy" src="${esc(thumbOf(v))}" alt="">
      <div class="ellipsis"><div class="tt ellipsis">${esc(v.title)}</div><div class="ta ellipsis">${esc(v.author)}</div></div>
      <button class="iconbtn" data-qrm="${i}" title="Rimuovi">✕</button>
    </div>`).join('') || '<div class="empty">La coda è vuota</div>';
  const cur = box.querySelector('.track.playing');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function setVideoPanelFor(music) {
  const p = $('#videoPanel');
  p.classList.toggle('off', music || isHouse());
}

function seekTo(fraction) {
  if (isHouse()) {
    const d = (pl.house && pl.house.duration) || 0;
    if (d) houseCmd('seek', Math.round(fraction * d));
    return;
  }
  const m = media();
  const t = localTimes();
  if (!t.live) { m.currentTime = fraction * t.d; return; }
  // stream HLS: si riparte dal punto scelto
  const v = currentItem();
  if (!v || !t.d) return;
  pl.offset = Math.floor(fraction * t.d);
  m.src = srcFor(v, pl.music ? 'audio' : 'video', pl.offset);
  m.play().catch(() => null);
}

function setVolume(v) {
  LS.set('vol', v);
  if (isHouse()) {
    clearTimeout(setVolume._t);
    setVolume._t = setTimeout(() => houseCmd('volume', v / 100), 250);
    return;
  }
  media().volume = v / 100;
}

setInterval(() => {
  let c = 0, d = 0;
  if (isHouse()) {
    const h = pl.house;
    if (h) {
      d = h.duration || 0;
      c = h.position || 0;
      if (h.state === 'playing' && h.positionAt) c += (Date.now() - Date.parse(h.positionAt)) / 1000;
      c = Math.min(c, d || c);
    }
  } else {
    const t = localTimes();
    c = t.c;
    d = t.d;
  }
  $('#pbCur').textContent = fmtTime(c);
  $('#pbDur').textContent = fmtTime(d);
  if (!pl.dragging) $('#pbSeek').value = d ? Math.round((c / d) * 1000) : 0;
}, 500);

// ---------------- "Suona in casa" (Music Assistant) ----------------

async function houseSend() {
  const items = pl.queue.slice(pl.idx, pl.idx + 60).map((v) => ({ id: v.id, title: v.title, author: v.author }));
  if (!items.length) return;
  media().pause();
  setVideoPanelFor(true);
  updateNowPlaying();
  try {
    const d = await postApi('house/play', { players: pl.players, items, music: pl.music });
    // la coda del server può essere stata allungata con brani simili
    const byId = new Map(pl.queue.map((v) => [v.id, v]));
    pl.queue = pl.queue.slice(0, pl.idx).concat(d.items.map((x) => byId.get(x.id) || x));
    renderQueue();
    toast(`🏠 In riproduzione in ${playerNames()}`);
    const v = currentItem();
    if (v) recordListen(v, pl.music);
    setTimeout(pollHouse, 1500);
  } catch (e) {
    toast('Casa: ' + e.message, 5000);
  }
}

async function houseCmd(cmd, value) {
  try {
    await postApi('house/cmd', { players: pl.players, cmd, value });
    setTimeout(pollHouse, 700);
  } catch (e) {
    toast('Casa: ' + e.message, 4000);
  }
}

async function pollHouse() {
  if (!isHouse()) return;
  try {
    const h = await api('house/state', { players: pl.players.join(',') });
    pl.house = h;
    if (h && h.videoId) {
      const i = pl.queue.findIndex((v) => v.id === h.videoId);
      if (i >= 0 && i !== pl.idx) {
        pl.idx = i;
        pl.recorded = false;
        updateNowPlaying();
        recordListen(pl.queue[i], pl.music);
      }
    }
    if (h && typeof h.volume === 'number' && !document.activeElement.matches('#pbVol')) $('#pbVol').value = Math.round(h.volume * 100);
    refreshPlayButton();
  } catch (e) { /* riprovo */ }
}
setInterval(pollHouse, 3000);

let housePlayers = [];

function playerNames() {
  const names = pl.players.map((id) => (housePlayers.find((p) => p.id === id) || { name: id.replace('media_player.', '') }).name);
  return names.join(', ') || 'casa';
}

function refreshOutputButton() {
  const b = $('#pbOutput');
  b.classList.toggle('on', isHouse());
  b.textContent = isHouse() ? '🏠' : '🎧';
  b.title = isHouse() ? 'In casa: ' + playerNames() : 'Su questo dispositivo';
}

async function showOutputMenu(x, y) {
  try {
    housePlayers = (await api('house/players')).players || [];
  } catch (e) {
    toast('Stanze non disponibili: ' + e.message, 4000);
    housePlayers = [];
  }
  const sel = new Set(pl.players);
  const entries = [
    { label: (pl.target === 'local' ? '✓ ' : '　') + '🎧 Questo dispositivo', run: () => switchTarget('local') },
    '-',
    ...housePlayers.map((p) => ({
      label: (sel.has(p.id) ? '☑ ' : '☐ ') + p.name + (p.state === 'playing' ? ' ♪' : ''),
      run: () => {
        if (sel.has(p.id)) sel.delete(p.id); else sel.add(p.id);
        pl.players = [...sel];
        LS.set('housePlayers', pl.players);
        setTimeout(() => showOutputMenu(x, y), 0);
      },
    })),
  ];
  if (housePlayers.length) {
    entries.push('-');
    entries.push({ label: '🏠 Suona nelle stanze scelte', run: () => switchTarget('house') });
    if (isHouse()) entries.push({ label: '⏹ Ferma la musica in casa', run: () => houseCmd('stop') });
  } else {
    entries.push({ label: 'Nessun player di Music Assistant trovato', run: () => null });
  }
  showMenu(entries, x, y);
}

function switchTarget(t) {
  if (t === 'house' && !pl.players.length) return toast('Scegli almeno una stanza');
  const wasHouse = isHouse();
  pl.target = t;
  LS.set('target', t);
  refreshOutputButton();
  if (t === 'house') {
    if (currentItem()) houseSend();
    else toast('🏠 Ora la musica partirà in ' + playerNames());
  } else {
    if (wasHouse) houseCmd('pause').catch(() => null);
    pl.house = null;
    if (currentItem()) {
      setVideoPanelFor(pl.music);
      playCurrent();
    }
  }
}

// ============================================================ Avvio

function bind() {
  $$('.navbtn').forEach((b) => b.addEventListener('click', () => goRoot(b.dataset.nav)));
  $('#backBtn').addEventListener('click', back);
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#syncBtn').addEventListener('click', () => sync(true).then((changed) => changed && render()));
  $('#newPlaylistBtn').addEventListener('click', () => newPlaylist());

  for (const box of [$('#view'), $('#sideList')]) {
    box.addEventListener('click', onListClick);
    box.addEventListener('contextmenu', onListContext);
  }
  $('#view').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.card')) e.target.click();
  });

  const input = $('#searchInput');
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const cur = navStack[navStack.length - 1];
      if (cur.name === 'search' && input.value.trim() !== (cur.args.q || '')) go('search', { q: input.value.trim(), type: cur.args.type || 'songs' }, true);
    }, 550);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounce);
      const cur = navStack[navStack.length - 1];
      go('search', { q: input.value.trim(), type: (cur.args && cur.args.type) || 'songs' }, true);
    }
  });

  $('#pbPlay').addEventListener('click', togglePlay);
  $('#pbNext').addEventListener('click', () => next());
  $('#pbPrev').addEventListener('click', prev);
  const sh = $('#pbShuffle');
  sh.classList.toggle('on', pl.shuffle);
  sh.addEventListener('click', () => {
    pl.shuffle = !pl.shuffle;
    LS.set('shuffle', pl.shuffle);
    sh.classList.toggle('on', pl.shuffle);
    toast(pl.shuffle ? 'Casuale attivo' : 'Casuale disattivato');
  });
  const rp = $('#pbRepeat');
  rp.addEventListener('click', () => {
    pl.repeat = !pl.repeat;
    rp.classList.toggle('on', pl.repeat);
    toast(pl.repeat ? 'Ripeti brano attivo' : 'Ripeti disattivato');
  });
  $('#pbLike').addEventListener('click', () => currentItem() && toggleFav(currentItem()));
  $('#pbOutput').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showOutputMenu(r.left, r.top - 10);
  });
  $('#pbArtist').addEventListener('click', () => {
    const v = currentItem();
    const a = v && cleanArtist(v.author);
    if (a) go('artist', { name: a, channelId: pl.music ? '' : v.channelId || '' });
  });
  const seek = $('#pbSeek');
  seek.addEventListener('input', () => { pl.dragging = true; });
  seek.addEventListener('change', () => {
    pl.dragging = false;
    seekTo(Number(seek.value) / 1000);
  });
  const vol = $('#pbVol');
  vol.value = LS.get('vol', 80);
  vol.addEventListener('input', () => {
    setVolume(Number(vol.value));
  });

  const vp = $('#videoPanel');
  $('#pbVideo').addEventListener('click', () => {
    if (vp.classList.contains('off')) {
      vp.classList.remove('off');
      if (pl.music) LS.set('hideVideoForMusic', false);
    } else vp.classList.toggle('big');
  });
  $('#vpHide').addEventListener('click', () => {
    vp.classList.add('off');
    vp.classList.remove('big');
    if (pl.music) LS.set('hideVideoForMusic', true);
  });
  $('#vpSize').addEventListener('click', () => vp.classList.toggle('big'));

  $('#pbQueue').addEventListener('click', () => {
    $('#queuePanel').classList.toggle('hidden');
    renderQueue();
  });
  $('#queueClose').addEventListener('click', () => $('#queuePanel').classList.add('hidden'));
  $('#queueList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-qrm]');
    if (rm) {
      const i = Number(rm.dataset.qrm);
      if (i === pl.idx) return toast('È il brano in riproduzione');
      pl.queue.splice(i, 1);
      if (i < pl.idx) pl.idx--;
      return renderQueue();
    }
    const row = e.target.closest('[data-q]');
    if (row) {
      pl.idx = Number(row.dataset.q);
      playCurrent();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' && cfg.worker) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape') { hideMenu(); e.target.blur && e.target.blur(); }
      return;
    }
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'MediaTrackNext') next();
    else if (e.key === 'p' || e.key === 'P' || e.key === 'MediaTrackPrevious') prev();
    else if (e.key === 'l' || e.key === 'L') { if (currentItem()) toggleFav(currentItem()); }
    else if (e.key === 'Escape') { hideMenu(); $('#queuePanel').classList.add('hidden'); }
    else if (e.key === '/') { e.preventDefault(); goRoot('search'); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleSync(500);
    if (document.visibilityState === 'visible') scheduleSync(1500);
  });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
      navigator.mediaSession.setActionHandler('previoustrack', prev);
    } catch (e) { /* non supportato */ }
  }
}

/** Stato del controllo automatico (config/tubetto-status.json): avviso se il servizio è in difficoltà. */
async function checkServiceStatus() {
  if (!cfg.token || !cfg.repo) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/config/tubetto-status.json`, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw+json' }, cache: 'no-store',
    });
    if (!r.ok) return;
    const st = await r.json();
    if (st.overall !== 'broken') return;
    const key = 'remote:' + st.since;
    if (LS.get('ackAlert', '') === key) return;
    const failed = (st.checks || []).filter((c) => c.state === 'fail').map((c) => '❌ ' + c.name + (c.detail ? ' — ' + c.detail : '')).join('\n');
    $('#modalBox').innerHTML = `<h3>⚠ Tubetto: servizio in difficoltà</h3>
      <p class="sub" style="white-space:pre-line">${esc(st.message || '')}\n\n${esc(failed)}\n\nIl sistema riprova da solo ogni 6 ore. Se dura, copia il rapporto e incollalo a Claude.</p>
      <div class="btns"><button class="secondary" id="stCopy">Copia rapporto</button><button class="primary" id="stOk">Ho capito</button></div>`;
    $('#modal').classList.remove('hidden');
    $('#stCopy').onclick = () => navigator.clipboard.writeText('=== Rapporto Tubetto Server ' + APP_VERSION + ' ===\n' + JSON.stringify(st, null, 2)).then(() => toast('Rapporto copiato: incollalo a Claude'));
    $('#stOk').onclick = () => { LS.set('ackAlert', key); closeModal(); };
  } catch (e) { /* niente */ }
}

async function start() {
  bind();
  initMedia();
  refreshOutputButton();
  try {
    const sc = await api('config');
    if (sc.repo && !LS.get('cfg', {}).repoSet) cfg.repo = sc.repo;
    if (sc.token && !cfg.token) cfg.token = sc.token;
    LS.set('cfg', cfg);
  } catch (e) {
    if (/Chiave/.test(e.message)) toast('Apri Tubetto dal pannello di Home Assistant oppure con il link che contiene ?key=', 6000);
  }
  renderSidebar();
  goRoot('home');
  if (cfg.token) sync().then((changed) => { if (changed) render(); });
  else setSyncStatus('Sincronizzazione non configurata');
  setTimeout(checkServiceStatus, 3000);
  setInterval(() => cfg.token && sync().then((changed) => { if (changed && navStack[navStack.length - 1].name !== 'search') renderSidebar(); }), 5 * 60000);
}

start();
