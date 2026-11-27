/**
 * Tubetto Server — "Suona in casa": invia la coda a Music Assistant tramite l'API di Home Assistant.
 * Le stanze sono i player di Music Assistant (squeezelite/DAC, HEOS del Denon, gruppi…).
 */

const API = 'http://supervisor/core/api';

async function ha(method, path, body) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error('API di Home Assistant non disponibile (manca SUPERVISOR_TOKEN)');
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Home Assistant ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return text; }
}

function service(domain, name, data) {
  return ha('POST', `/services/${domain}/${name}`, data);
}

async function supervisor(path) {
  const r = await fetch('http://supervisor' + path, { headers: { Authorization: 'Bearer ' + process.env.SUPERVISOR_TOKEN }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Supervisor ' + path + ': HTTP ' + r.status);
  const j = await r.json();
  return j.data || j;
}

/**
 * Indirizzo raggiungibile dalla TV: la TV non conosce il nome interno del container
 * (che va bene solo per Music Assistant), serve IP di casa + porta pubblicata dell'add-on.
 */
let lanCache = null;
export async function lanBase(port) {
  if (lanCache && Date.now() - lanCache.t < 10 * 60 * 1000) return lanCache.v;
  let hostPort = null;
  try {
    const info = await supervisor('/addons/self/info');
    hostPort = info.network && info.network[port + '/tcp'];
  } catch (e) { /* senza hassio_api */ }
  if (!hostPort) throw new Error(`La TV non raggiunge il video: in Home Assistant apri Impostazioni → Componenti aggiuntivi → Tubetto Server → Configurazione → Rete, scrivi ${port} nella porta e riavvia l'add-on`);
  let ip = null;
  try {
    const net = await supervisor('/network/info');
    const ifs = (net.interfaces || []).filter((i) => i.enabled !== false && i.ipv4 && (i.ipv4.address || []).length);
    const pick = ifs.find((i) => i.primary) || ifs[0];
    if (pick) ip = String(pick.ipv4.address[0]).split('/')[0];
  } catch (e) { /* ripiego sotto */ }
  if (!ip) {
    try {
      const c = await ha('GET', '/config');
      if (c.internal_url) ip = new URL(c.internal_url).hostname;
    } catch (e) { /* niente */ }
  }
  if (!ip) throw new Error("Non trovo l'indirizzo di casa di Home Assistant: imposta stream_base_url nella configurazione dell'add-on (es. http://192.168.1.10:" + port + ')');
  const v = `http://${ip}:${hostPort}`;
  lanCache = { t: Date.now(), v };
  return v;
}

// stanza → TV che sta mostrando il video (i comandi vanno alla TV, non a Music Assistant)
const videoRoute = new Map();
export function routeVideo(player, entity) { videoRoute.set(player, entity); }
export function clearVideo(players) { for (const p of players) videoRoute.delete(p); }
export function videoOf(player) { return videoRoute.get(player) || null; }
const target = (p) => videoRoute.get(p) || p;

/** Player di Music Assistant (se non trovati, tutti i media_player). */
export async function players() {
  const ids = [...await maSet()];
  const states = await ha('GET', '/states');
  const all = states.filter((s) => s.entity_id.startsWith('media_player.'));
  const list = ids.length ? all.filter((s) => ids.includes(s.entity_id)) : all;
  const nameOf = (s) => (s.attributes && s.attributes.friendly_name) || s.entity_id;
  // "TV dello studio" e "TV STUDIO" sono la stessa stanza: tolgo articoli e preposizioni
  const STOP = new Set(['di', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'da', 'il', 'lo', 'la', 'i', 'gli', 'le', 'the', 'of', 'in', 'airplay', 'cast', 'dlna']);
  const norm = (n) => String(n).toLowerCase().replace(/[♪()\[\]_\-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
  // TV/Chromecast fuori da Music Assistant (stesso nome): servono per mostrare anche il VIDEO
  // Solo entità che accettano un link video: Google Cast (e DLNA). L'integrazione Sony Bravia, Android TV, webOS…
  // accettano solo "app" e "canale" e danno "Invalid media type".
  const urlOk = await urlPlayers();
  const looksTv = (s) => (s.attributes && s.attributes.device_class) === 'tv' || /cast|bravia|tv|chromecast|sony|samsung|philips|\blg\b|kd-|aftss|fire/i.test(s.entity_id + ' ' + nameOf(s));
  const videoCapable = all.filter((s) => !ids.includes(s.entity_id) && !noUrl.has(s.entity_id) && (urlOk.size ? urlOk.has(s.entity_id) : looksTv(s)))
    .sort((a, b) => (castIds.has(b.entity_id) ? 1 : 0) - (castIds.has(a.entity_id) ? 1 : 0));
  // un solo elemento per stanza: lo stesso dispositivo può comparire più volte (Cast, DLNA, AirPlay…)
  const byName = new Map();
  for (const s of list) {
    const k = norm(nameOf(s));
    const cur = byName.get(k);
    const score = (x) => (x.state === 'playing' ? 3 : 0) + (x.state !== 'unavailable' ? 2 : 0) + (/airplay|dlna|upnp/i.test(x.entity_id) ? 0 : 1);
    if (!cur || score(s) > score(cur)) byName.set(k, s);
  }
  // stessa TV in integrazioni diverse: entity_id con la stessa radice (sony_kd_43xh8096, _2, _3…)
  const root = (id) => String(id).replace(/^media_player\./, '').replace(/_\d+$/, '');
  const sameTv = (a, b) => root(a.entity_id) === root(b.entity_id);
  // TV senza un player di Music Assistant con lo stesso nome: compaiono da sole e ricevono via Cast
  if (ids.length) {
    for (const v of videoCapable) {
      const k = norm(nameOf(v));
      if (v.state === 'unavailable' || byName.has(k) || [...byName.keys()].some((n) => n.includes(k) || k.includes(n))) continue;
      if ([...byName.values()].some((x) => sameTv(x, v))) continue;
      byName.set(k, v);
    }
  }
  const fs = await firesticks().catch(() => []);
  return {
    musicAssistant: ids.length > 0,
    players: [...fs.map((f) => ({ id: 'app:' + f.entity, name: f.name + ' (app Tubetto)', state: f.state, video: 'app', app: true })), ...[...byName.values()].map((s) => {
      const k = norm(nameOf(s));
      const v = !ids.includes(s.entity_id) && ids.length ? s : videoCapable.find((x) => castIds.has(x.entity_id) && (sameTv(x, s) || norm(nameOf(x)) === k)) || videoCapable.find((x) => sameTv(x, s)) || videoCapable.find((x) => norm(nameOf(x)) === k) || (/tv|bravia|sony|samsung|lg/i.test(nameOf(s)) ? videoCapable.find((x) => norm(nameOf(x)).includes(k) || k.includes(norm(nameOf(x)))) : null);
      return {
        id: s.entity_id,
        name: nameOf(s).replace(/\s*♪\s*$/, ''),
        state: s.state,
        volume: s.attributes && s.attributes.volume_level,
        group: (s.attributes && s.attributes.group_members) || [],
        video: v ? v.entity_id : null,
      };
    })].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ------------------------------------------------------------------ Firestick con l'app Tubetto (via ADB)

let fsOpts = {};
export function setFirestickOptions(o) { fsOpts = o || {}; }
const APP_PKG = 'it.gerry.tubetto';
const GENERIC = new Set(['tv', 'firestick', 'fire', 'stick', 'amazon', 'aftss', 'android', 'media', 'player', 'di', 'del', 'della', 'dello']);

async function tpl(t) {
  const r = await ha('POST', '/template', { template: t });
  return typeof r === 'string' ? JSON.parse(r) : r;
}

/** Firestick (integrazione Android Debug Bridge) e la TV a cui sono collegate (integrazione Sony Bravia). */
let fsCache = null;
export async function firesticks() {
  if (fsCache && Date.now() - fsCache.t < 60000) return fsCache.v;
  const v = await firesticksNow();
  fsCache = { t: Date.now(), v };
  return v;
}

async function firesticksNow() {
  const adb = await tpl("{{ integration_entities('androidtv') | select('match', 'media_player\\\\.') | list | tojson }}").catch(() => []);
  const tvs = await tpl("{{ integration_entities('braviatv') | select('match', 'media_player\\\\.') | list | tojson }}").catch(() => []);
  const devName = async (e) => tpl(`{{ (device_attr(device_id('${e}'), 'name_by_user') or device_attr(device_id('${e}'), 'name') or state_attr('${e}', 'friendly_name') or '') | tojson }}`).catch(() => '');
  const out = [];
  for (const pair of adb) {
    const e = Array.isArray(pair) ? pair[1] : pair;
    if (!e) continue;
    const st = await ha('GET', '/states/' + e).catch(() => null);
    const nm = (await devName(e)) || (st && st.attributes && st.attributes.friendly_name) || e;
    const model = await tpl(`{{ (device_attr(device_id('${e}'), 'model') or '') | tojson }}`).catch(() => '');
    const forced = fsOpts.firestick_entity && fsOpts.firestick_entity === e;
    if (!forced && !/fire|aftss|aft[a-z]|firestick/i.test(`${e} ${nm} ${model}`)) continue;
    // TV: scelta nelle opzioni o quella Sony Bravia con una parola del nome in comune (es. "Salone")
    let tv = fsOpts.firestick_tv || '';
    if (!tv) {
      const words = String(nm).toLowerCase().split(/[^a-zà-ù0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
      for (const t of tvs) {
        const tn = String(await devName(t)).toLowerCase();
        if (words.some((w) => tn.includes(w) || t.includes(w))) { tv = t; break; }
      }
    }
    out.push({ entity: e, name: nm, state: st ? st.state : 'unknown', tv });
  }
  return out;
}

const adbCmd = (entity, command) => service('androidtv', 'adb_command', { entity_id: entity, command });

/** Accende la TV, la porta sull'HDMI della Firestick e apre il video nell'app Tubetto. */
export async function firestickPlay(entity, it) {
  const f = (await firesticks()).find((x) => x.entity === entity) || { entity, tv: fsOpts.firestick_tv || '' };
  if (f.tv) {
    const tvState = await ha('GET', '/states/' + f.tv).catch(() => null);
    if (!tvState || tvState.state === 'off' || tvState.state === 'standby') {
      await service('media_player', 'turn_on', { entity_id: f.tv }).catch(() => null);
      await new Promise((ok) => setTimeout(ok, 6000));
    }
    const list = ((await ha('GET', '/states/' + f.tv).catch(() => ({}))).attributes || {}).source_list || [];
    const want = fsOpts.firestick_hdmi || 'HDMI 1';
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const src = list.find((x) => norm(x) === norm(want)) || list.find((x) => norm(x).startsWith(norm(want))) || want;
    await service('media_player', 'select_source', { entity_id: f.tv, source: src }).catch((e) => console.log('[firestick] cambio ingresso non riuscito:', e.message));
  }
  await adbCmd(entity, 'input keyevent 224').catch(() => null); // sveglia la Firestick
  await adbCmd(entity, `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT https://youtu.be/${it.id} -n ${APP_PKG}/.ui.MainActivity`);
}

const KEYS = { play: 126, pause: 127, stop: 86, next: 87, previous: 88 };
export async function firestickCmd(entity, cmd) {
  if (cmd === 'volume' || cmd === 'seek' || cmd === 'unjoin') return null;
  const k = KEYS[cmd];
  if (!k) return null;
  return adbCmd(entity, 'input keyevent ' + k);
}

// entità che Home Assistant ha rifiutato per music_assistant.play_media (es. la TV vista via Cast)
export const notMa = new Set();
// entità che non accettano link (es. Sony Bravia: solo app e canali)
export const noUrl = new Set();
let castIds = new Set();

export function isCast(entity) { return castIds.has(entity); }

/**
 * Entità che possono mostrare il video di questa stanza: quella scelta e le altre della stessa TV
 * (stessa radice dell'entity_id o stesso nome), Google Cast per prime, poi DLNA.
 */
export async function videoCandidates(player, chosen) {
  const urlOk = await urlPlayers();
  const states = await ha('GET', '/states');
  const root = (id) => String(id || '').replace(/^media_player\./, '').replace(/_\d+$/, '');
  const byId = new Map(states.map((x) => [x.entity_id, x]));
  const nm = (id) => String(((byId.get(id) || {}).attributes || {}).friendly_name || '').toLowerCase().replace(/\b(di|del|dello|della)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const roots = new Set([root(player), root(chosen)]);
  const names = new Set([nm(player), nm(chosen)].filter(Boolean));
  const list = [...urlOk].filter((e) => e !== chosen && !noUrl.has(e) && (roots.has(root(e)) || names.has(nm(e))) && (byId.get(e) || {}).state !== 'unavailable')
    .sort((a, b) => (castIds.has(b) ? 1 : 0) - (castIds.has(a) ? 1 : 0));
  // Google Cast prima di tutto (anche se la scelta era il DLNA)
  const all = [chosen, ...list].filter((e) => e && !noUrl.has(e));
  return [...all.filter((e) => castIds.has(e)), ...all.filter((e) => !castIds.has(e))];
}

/** Entità che riproducono un link: Google Cast per prime, poi DLNA. */
export async function refreshUrlPlayers() { return urlPlayers(); }

/** Entità che riproducono un link: Google Cast per prime, poi DLNA. */
async function urlPlayers() {
  try {
    const t = await ha('POST', '/template', { template: "{{ (integration_entities('cast') | select('match', 'media_player\\\\.') | list) | tojson }}" });
    castIds = new Set(typeof t === 'string' ? JSON.parse(t) : t);
    const d = await ha('POST', '/template', { template: "{{ (integration_entities('dlna_dmr') | select('match', 'media_player\\\\.') | list) | tojson }}" }).catch(() => '[]');
    const set = new Set([...castIds, ...(typeof d === 'string' ? JSON.parse(d) : d)]);
    for (const e of noUrl) set.delete(e);
    return set;
  } catch (e) { return new Set(); }
}

/** Entità che sono player di Music Assistant (le altre, es. una TV Cast, si comandano direttamente). */
export async function maSet() {
  const set = new Set();
  try {
    const t = await ha('POST', '/template', { template: "{{ integration_entities('music_assistant') | select('match', 'media_player\\\\.') | list | tojson }}" });
    for (const id of (typeof t === 'string' ? JSON.parse(t) : t) || []) set.add(id);
  } catch (e) { /* ripiego sugli attributi */ }
  try {
    const states = await ha('GET', '/states');
    for (const st of states) {
      const a = st.attributes || {};
      if (st.entity_id.startsWith('media_player.') && (a.mass_player_type || a.mass_player_id || a.active_queue !== undefined)) set.add(st.entity_id);
    }
  } catch (e) { /* niente */ }
  for (const id of notMa) set.delete(id);
  return set;
}

/** Interrompe quello che la TV sta ricevendo (altrimenti il nuovo invio la trova occupata). */
export async function stopDirect(entities) {
  const list = [...new Set(entities.filter(Boolean))];
  if (!list.length) return;
  await Promise.all(list.map((e) => service('media_player', 'media_stop', { entity_id: e }).catch(() => null)));
  await new Promise((ok) => setTimeout(ok, 800));
}

/** Video (o audio) direttamente sulla TV (Chromecast/Cast di Home Assistant): Music Assistant porta solo l'audio. */
export async function playVideo(entity, url, title, thumb, type = 'video/mp4') {
  const send = async () => {
    const data = { entity_id: entity, media_content_id: url, media_content_type: type };
    if (type !== 'cast') data.extra = { metadata: { metadataType: type.startsWith('audio') ? 3 : 0, title, images: thumb ? [{ url: thumb }] : [] } };
    await service('media_player', 'play_media', data);
  };
  try { await send(); } catch (e) {
    // la TV era ancora occupata dal flusso di prima: riprovo una volta
    if (!/quick play|timed out|timeout/i.test(e.message)) throw e;
    await new Promise((ok) => setTimeout(ok, 2500));
    await send();
  }
}

/**
 * @param players entity_id scelti (il primo guida il gruppo)
 * @param urls    stream di Tubetto Server
 */
export async function play(players, urls) {
  if (!players.length || !urls.length) throw new Error('Niente da suonare');
  // la stessa TV stava mostrando un video via Cast: lo fermo prima di passare a Music Assistant
  await stopDirect(players.map((p) => videoRoute.get(p)).filter((e) => e && !players.includes(e)));
  clearVideo(players);
  const leader = players[0];
  if (players.length > 1) {
    try {
      await service('media_player', 'join', { entity_id: leader, group_members: players.slice(1) });
    } catch (e) {
      console.log('[casa] raggruppamento non riuscito, suono stanza per stanza:', e.message);
      for (const p of players) await playOne(p, urls);
      return { grouped: false };
    }
  }
  await playOne(leader, urls);
  return { grouped: players.length > 1 };
}

async function playOne(player, urls) {
  try {
    await service('music_assistant', 'play_media', { entity_id: player, media_id: urls, media_type: 'track', enqueue: 'replace' });
  } catch (e) {
    // versioni che non accettano una lista: il primo sostituisce, gli altri in coda
    await service('music_assistant', 'play_media', { entity_id: player, media_id: urls[0], media_type: 'track', enqueue: 'replace' });
    for (const u of urls.slice(1, 40)) {
      await service('music_assistant', 'play_media', { entity_id: player, media_id: u, media_type: 'track', enqueue: 'add' }).catch(() => null);
    }
  }
}

/** Un servizio per ogni entità: se una non lo supporta (es. TV senza "play") non blocca le altre. */
async function each(entities, name, data = {}) {
  let unsupported = 0, last = null;
  for (const e of [...new Set(entities)]) {
    try { await service('media_player', name, { entity_id: e, ...data }); } catch (err) {
      last = err;
      if (/does not support action/i.test(err.message)) unsupported++;
      else if (!/queue is empty/i.test(err.message)) throw err;
    }
  }
  return { unsupported, last };
}

export async function command(players, cmd, value) {
  if (!players[0]) throw new Error('Nessuna stanza scelta');
  const leader = target(players[0]);
  const all = players.map(target);
  switch (cmd) {
    case 'play': return each([leader], 'media_play');
    case 'pause': {
      const r = await each([leader], 'media_pause');
      if (r.unsupported) await each([leader], 'media_stop');
      return r;
    }
    case 'next': return each([leader], 'media_next_track');
    case 'previous': return each([leader], 'media_previous_track');
    case 'stop': {
      // fermo sia la TV (Cast) sia il player di Music Assistant della stessa stanza
      const r = await each([...all, ...players], 'media_stop');
      clearVideo(players);
      return r;
    }
    case 'seek': return each([leader], 'media_seek', { seek_position: Number(value) || 0 });
    case 'volume': return each(all, 'volume_set', { volume_level: Math.max(0, Math.min(1, Number(value))) });
    case 'unjoin': return service('media_player', 'unjoin', { entity_id: players.slice(1) });
    default: throw new Error('Comando sconosciuto: ' + cmd);
  }
}

export async function state(players) {
  const leader = players[0];
  if (!leader) return null;
  const s = await ha('GET', '/states/' + target(leader));
  const a = s.attributes || {};
  const ids = JSON.stringify(a).match(/\/(?:stream|video)\/([A-Za-z0-9_-]{11})/);
  return {
    video: !!videoRoute.get(leader),
    state: s.state,
    videoId: ids ? ids[1] : null,
    title: a.media_title || '',
    artist: a.media_artist || '',
    position: a.media_position || 0,
    positionAt: a.media_position_updated_at || null,
    duration: a.media_duration || 0,
    volume: a.volume_level,
  };
}
