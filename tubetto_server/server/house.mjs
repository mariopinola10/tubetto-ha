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
  const norm = (n) => String(n).toLowerCase().replace(/[♪()]/g, '').replace(/\s+/g, ' ').trim();
  // TV/Chromecast fuori da Music Assistant (stesso nome): servono per mostrare anche il VIDEO
  const videoCapable = all.filter((s) => !ids.includes(s.entity_id) && ((s.attributes && s.attributes.device_class) === 'tv' || /cast|bravia|tv|chromecast|sony|samsung|philips|\blg\b|kd-|aftss|fire/i.test(s.entity_id + ' ' + nameOf(s))));
  // un solo elemento per stanza: lo stesso dispositivo può comparire più volte (Cast, DLNA, AirPlay…)
  const byName = new Map();
  for (const s of list) {
    const k = norm(nameOf(s));
    const cur = byName.get(k);
    const score = (x) => (x.state === 'playing' ? 3 : 0) + (x.state !== 'unavailable' ? 2 : 0) + (/airplay|dlna|upnp/i.test(x.entity_id) ? 0 : 1);
    if (!cur || score(s) > score(cur)) byName.set(k, s);
  }
  // TV senza un player di Music Assistant con lo stesso nome: compaiono da sole e ricevono via Cast
  if (ids.length) {
    for (const v of videoCapable) {
      const k = norm(nameOf(v));
      if (v.state === 'unavailable' || byName.has(k) || [...byName.keys()].some((n) => n.includes(k) || k.includes(n))) continue;
      byName.set(k, v);
    }
  }
  return {
    musicAssistant: ids.length > 0,
    players: [...byName.values()].map((s) => {
      const k = norm(nameOf(s));
      const v = !ids.includes(s.entity_id) && ids.length ? s : videoCapable.find((x) => norm(nameOf(x)) === k) || (/tv|bravia|sony|samsung|lg/i.test(nameOf(s)) ? videoCapable.find((x) => norm(nameOf(x)).includes(k) || k.includes(norm(nameOf(x)))) : null);
      return {
        id: s.entity_id,
        name: nameOf(s).replace(/\s*♪\s*$/, ''),
        state: s.state,
        volume: s.attributes && s.attributes.volume_level,
        group: (s.attributes && s.attributes.group_members) || [],
        video: v ? v.entity_id : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// entità che Home Assistant ha rifiutato per music_assistant.play_media (es. la TV vista via Cast)
export const notMa = new Set();

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
  await service('media_player', 'play_media', {
    entity_id: entity,
    media_content_id: url,
    media_content_type: type,
    extra: { metadata: { metadataType: type.startsWith('audio') ? 3 : 0, title, images: thumb ? [{ url: thumb }] : [] } },
  });
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

export async function command(players, cmd, value) {
  const leader = players[0] && target(players[0]);
  if (!leader) throw new Error('Nessuna stanza scelta');
  const all = players.map(target);
  switch (cmd) {
    case 'play': return service('media_player', 'media_play', { entity_id: leader });
    case 'pause': return service('media_player', 'media_pause', { entity_id: leader });
    case 'next': return service('media_player', 'media_next_track', { entity_id: leader });
    case 'previous': return service('media_player', 'media_previous_track', { entity_id: leader });
    case 'stop': return service('media_player', 'media_stop', { entity_id: all });
    case 'seek': return service('media_player', 'media_seek', { entity_id: leader, seek_position: Number(value) || 0 });
    case 'volume': return service('media_player', 'volume_set', { entity_id: all, volume_level: Math.max(0, Math.min(1, Number(value))) });
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
