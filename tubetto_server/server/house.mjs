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

/** Player di Music Assistant (se non trovati, tutti i media_player). */
export async function players() {
  let ids = [];
  try {
    const t = await ha('POST', '/template', { template: "{{ integration_entities('music_assistant') | select('match', 'media_player\\\\.') | list | tojson }}" });
    ids = typeof t === 'string' ? JSON.parse(t) : t;
  } catch (e) { ids = []; }
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
  return {
    musicAssistant: ids.length > 0,
    players: [...byName.values()].map((s) => {
      const k = norm(nameOf(s));
      const v = videoCapable.find((x) => norm(nameOf(x)) === k) || (/tv|bravia|sony|samsung|lg/i.test(nameOf(s)) ? videoCapable.find((x) => norm(nameOf(x)).includes(k) || k.includes(norm(nameOf(x)))) : null);
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

/** Video sulla TV (Chromecast/Cast di Home Assistant): Music Assistant porta solo l'audio. */
export async function playVideo(entity, url, title, thumb) {
  await service('media_player', 'play_media', {
    entity_id: entity,
    media_content_id: url,
    media_content_type: 'video/mp4',
    extra: { metadata: { metadataType: 0, title, images: thumb ? [{ url: thumb }] : [] } },
  });
}

/**
 * @param players entity_id scelti (il primo guida il gruppo)
 * @param urls    stream di Tubetto Server
 */
export async function play(players, urls) {
  if (!players.length || !urls.length) throw new Error('Niente da suonare');
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
  const leader = players[0];
  if (!leader) throw new Error('Nessuna stanza scelta');
  switch (cmd) {
    case 'play': return service('media_player', 'media_play', { entity_id: leader });
    case 'pause': return service('media_player', 'media_pause', { entity_id: leader });
    case 'next': return service('media_player', 'media_next_track', { entity_id: leader });
    case 'previous': return service('media_player', 'media_previous_track', { entity_id: leader });
    case 'stop': return service('media_player', 'media_stop', { entity_id: players });
    case 'seek': return service('media_player', 'media_seek', { entity_id: leader, seek_position: Number(value) || 0 });
    case 'volume': return service('media_player', 'volume_set', { entity_id: players, volume_level: Math.max(0, Math.min(1, Number(value))) });
    case 'unjoin': return service('media_player', 'unjoin', { entity_id: players.slice(1) });
    default: throw new Error('Comando sconosciuto: ' + cmd);
  }
}

export async function state(players) {
  const leader = players[0];
  if (!leader) return null;
  const s = await ha('GET', '/states/' + leader);
  const a = s.attributes || {};
  const ids = JSON.stringify(a).match(/\/stream\/([A-Za-z0-9_-]{11})/);
  return {
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
