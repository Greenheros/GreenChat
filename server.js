'use strict';
/*
 * GreenChat — chat Twitch local façon Twitchat
 * Serveur unique : se connecte au chat Twitch (IRC WebSocket) et à EventSub,
 * relaie tout aux pages (panneau de contrôle + overlays OBS) via WebSocket.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3500;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SCOPES = [
  'chat:read', 'chat:edit',
  'moderator:manage:banned_users', 'moderator:manage:chat_messages',
  'moderator:read:followers', 'moderator:manage:shoutouts', 'moderator:manage:announcements',
  'channel:read:redemptions', 'channel:manage:broadcast', 'channel:read:ads',
  // commandes admin (onglet Stream)
  'moderator:manage:chat_settings', 'moderator:manage:shield_mode', 'moderator:manage:warnings',
  'channel:manage:raids', 'channel:edit:commercial', 'channel:manage:ads', 'clips:edit',
  'channel:manage:moderators', 'channel:manage:vips', 'channel:manage:polls', 'channel:manage:predictions',
  // événements supplémentaires pour les filtres du chat
  'channel:read:hype_train', 'channel:read:goals', 'channel:read:charity', 'channel:moderate', 'moderator:read:unban_requests',
].join(' ');

/* ------------------------------------------------------------------ */
/* Stockage JSON                                                        */
/* ------------------------------------------------------------------ */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
function loadJSON(file, def) {
  try { return deepMerge(def, JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))); }
  catch { return JSON.parse(JSON.stringify(def)); }
}
function saveJSON(file, obj) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(p + '.tmp', p);
}

const DEFAULT_CONFIG = { clientId: '', channel: '', auth: null };
const DEFAULT_SETTINGS = {
  accent: '#2ee59d',
  highlightWords: [],
  ignoredUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'botheros'],
  overlayChat: {
    fontSize: 22, maxMessages: 12, hideAfter: 0, showBadges: true, showEvents: true,
    hideCommands: true, hideBots: true, background: 'rgba(10,12,16,0.55)', textColor: '#ffffff',
    animation: 'slide', showTime: false,
  },
  overlayHighlight: { duration: 0, position: 'bottom-left', scale: 1 },
  alerts: { follow: true, sub: true, subgift: true, raid: true, cheer: true, reward: true, duration: 6, sound: true, volume: 0.5 },
};
const DEFAULT_PLANNING = {
  title: 'Planning de la semaine',
  subtitle: 'twitch.tv/',
  accent: '#2ee59d',
  offLabel: 'Repos',
  slots: [
    { id: 's2', day: 2, start: '20:30', end: '01:00', game: '', title: 'Live du soir', guest: '', color: '' },
    { id: 's3', day: 3, start: '20:30', end: '01:00', game: '', title: 'Stream sucré-salé', guest: 'Mixmaixe', color: '#ff9f43' },
    { id: 's4', day: 4, start: '20:30', end: '01:00', game: '', title: 'Live du soir', guest: '', color: '' },
    { id: 's5', day: 5, start: '20:30', end: '01:00', game: '', title: 'Live du soir', guest: '', color: '' },
    { id: 's6', day: 6, start: '20:30', end: '01:00', game: '', title: 'Live du soir', guest: '', color: '' },
    { id: 's7', day: 7, start: '20:30', end: '01:00', game: '', title: 'Live du soir', guest: '', color: '' },
  ],
  specials: [],
};

const config = loadJSON('config.json', DEFAULT_CONFIG);
let settings = loadJSON('settings.json', DEFAULT_SETTINGS);
let planning = (() => {
  try { return { ...DEFAULT_PLANNING, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'planning.json'), 'utf8')) }; }
  catch { return JSON.parse(JSON.stringify(DEFAULT_PLANNING)); }
})();
const saveConfig = () => saveJSON('config.json', config);

/* ------------------------------------------------------------------ */
/* État partagé + diffusion                                             */
/* ------------------------------------------------------------------ */
const state = {
  irc: 'off',            // off | connecting | on
  eventsub: 'off',       // off | connecting | on | partial | error
  eventsubDetail: '',
  roomId: null,
  emotes: {},            // emotes 7TV / BTTV / FFZ : nom -> { url, src }
  badges: {},            // "set/version" -> url
  highlight: null,
  userstate: null,
  demo: false,
};
const history = [];
const clients = new Set();

function publicStatus() {
  return {
    irc: state.irc, eventsub: state.eventsub, eventsubDetail: state.eventsubDetail,
    channel: config.channel, clientId: config.clientId, roomId: state.roomId, demo: state.demo,
    login: config.auth?.login || null, userId: config.auth?.userId || null,
    scopes: config.auth?.scopes || [], requiredScopes: SCOPES.split(' '),
  };
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
function pushStatus() { broadcast({ type: 'status', status: publicStatus() }); }
function emitItem(item, keep = true) {
  if (keep) { history.push(item); if (history.length > 400) history.shift(); }
  broadcast(item);
}
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const log = (...a) => console.log(new Date().toLocaleTimeString('fr-FR'), ...a);

/* ------------------------------------------------------------------ */
/* Authentification Twitch (Device Code Flow, sans URL de redirection)  */
/* ------------------------------------------------------------------ */
let pendingDevice = null;
let refreshing = null;

async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
async function validateToken(token) {
  const r = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token } });
  if (!r.ok) return null;
  return r.json();
}
async function refreshToken() {
  if (!config.auth?.refresh || !config.clientId) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const r = await postForm('https://id.twitch.tv/oauth2/token', {
      grant_type: 'refresh_token', refresh_token: config.auth.refresh, client_id: config.clientId,
    });
    if (!r.ok) { log('Rafraîchissement du token refusé :', r.data.message || r.status); return false; }
    config.auth.token = r.data.access_token;
    config.auth.refresh = r.data.refresh_token || config.auth.refresh;
    saveConfig();
    log('Token Twitch rafraîchi');
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function ensureValidToken() {
  if (!config.auth?.token) return false;
  let v = await validateToken(config.auth.token).catch(() => null);
  if (!v && await refreshToken()) v = await validateToken(config.auth.token).catch(() => null);
  if (!v) { log('Session Twitch expirée, reconnecte-toi depuis Paramètres'); config.auth = null; saveConfig(); pushStatus(); return false; }
  config.auth.login = v.login; config.auth.userId = v.user_id; config.auth.scopes = v.scopes || [];
  saveConfig();
  return true;
}

async function startDeviceAuth() {
  if (!config.clientId) throw new Error('Renseigne d\'abord ton Client ID Twitch');
  const r = await postForm('https://id.twitch.tv/oauth2/device', { client_id: config.clientId, scopes: SCOPES });
  if (!r.ok) throw new Error(r.data.message || 'Twitch a refusé la demande (vérifie le Client ID et que l\'appli est de type « Public »)');
  const d = r.data;
  const myId = rid();
  pendingDevice = { id: myId, ...d, until: Date.now() + d.expires_in * 1000 };
  (async function poll() {
    while (pendingDevice && pendingDevice.id === myId && Date.now() < pendingDevice.until) {
      await new Promise((res) => setTimeout(res, (pendingDevice.interval || 5) * 1000));
      if (!pendingDevice || pendingDevice.id !== myId) return;
      const t = await postForm('https://id.twitch.tv/oauth2/token', {
        client_id: config.clientId, scopes: SCOPES, device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch(() => ({ ok: false, data: {} }));
      if (t.ok) {
        const v = await validateToken(t.data.access_token);
        config.auth = { token: t.data.access_token, refresh: t.data.refresh_token, login: v.login, userId: v.user_id, scopes: v.scopes || [] };
        if (!config.channel) config.channel = v.login;
        saveConfig();
        pendingDevice = null;
        log('Connecté à Twitch en tant que', v.login);
        broadcast({ type: 'auth', ok: true, login: v.login });
        pushStatus();
        ircConnect();
        // nouvelles autorisations : on refait les abonnements EventSub avec le nouveau token
        if (state.roomId) startEventSub();
        return;
      }
      const msg = t.data.message || '';
      if (msg && msg !== 'authorization_pending' && msg !== 'slow_down') {
        pendingDevice = null;
        broadcast({ type: 'auth', ok: false, error: msg });
        return;
      }
    }
  })();
  return { userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in };
}

/* ------------------------------------------------------------------ */
/* API Helix                                                            */
/* ------------------------------------------------------------------ */
async function helix(method, pathq, body, retry = true) {
  if (!config.auth?.token || !config.clientId) throw new Error('Connecte ton compte Twitch dans Paramètres');
  const r = await fetch('https://api.twitch.tv/helix' + pathq, {
    method,
    headers: {
      'Client-Id': config.clientId,
      Authorization: 'Bearer ' + config.auth.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry && await refreshToken()) return helix(method, pathq, body, false);
  const txt = await r.text();
  let data = {};
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { message: txt }; }
  if (!r.ok) throw new Error(data.message || ('Erreur Twitch HTTP ' + r.status));
  return data;
}
const userCache = new Map();
async function getUserByLogin(login) {
  login = String(login).replace(/^@/, '').toLowerCase();
  if (userCache.has(login)) return userCache.get(login);
  const d = await helix('GET', '/users?login=' + encodeURIComponent(login));
  const u = d.data?.[0];
  if (!u) throw new Error('Utilisateur introuvable : ' + login);
  userCache.set(login, u);
  return u;
}
async function getUserById(id) {
  const d = await helix('GET', '/users?id=' + encodeURIComponent(id));
  return d.data?.[0] || null;
}
const modQuery = () => `broadcaster_id=${state.roomId}&moderator_id=${config.auth.userId}`;

/* ------------------------------------------------------------------ */
/* Commandes admin (onglet Stream + commandes / du chat)                */
/* ------------------------------------------------------------------ */
function needChannel() {
  if (!state.roomId || !config.auth?.token) throw new Error('Connecte ton compte Twitch et rejoins une chaîne');
}
function needBroadcaster() {
  needChannel();
  if (config.auth.userId !== state.roomId) throw new Error('Commande réservée au propriétaire de la chaîne (connecte-toi avec le compte du streamer)');
}
const bq = () => 'broadcaster_id=' + state.roomId;
const CHAT_SETTING_KEYS = ['slow_mode', 'slow_mode_wait_time', 'follower_mode', 'follower_mode_duration', 'subscriber_mode',
  'emote_mode', 'unique_chat_mode', 'non_moderator_chat_delay', 'non_moderator_chat_delay_duration'];
const ANNOUNCE_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];

const admin = {
  async chatSettings(patch) {
    needChannel();
    const body = {};
    for (const k of CHAT_SETTING_KEYS) if (patch[k] !== undefined) body[k] = patch[k];
    if (!Object.keys(body).length) throw new Error('Aucun réglage à modifier');
    const d = await helix('PATCH', '/chat/settings?' + modQuery(), body);
    return d.data?.[0] || null;
  },
  async shield(active) {
    needChannel();
    const d = await helix('PUT', `/moderation/shield_mode?${modQuery()}`, { is_active: !!active });
    return d.data?.[0] || null;
  },
  async clear() { needChannel(); await helix('DELETE', '/moderation/chat?' + modQuery()); },
  async announce(message, color = 'primary') {
    needChannel();
    message = String(message || '').trim();
    if (!message) throw new Error('Message vide');
    color = ANNOUNCE_COLORS.includes(String(color).toLowerCase()) ? String(color).toLowerCase() : 'primary';
    await helix('POST', '/chat/announcements?' + modQuery(), { message, color });
  },
  async shoutout(login) {
    needChannel(); const u = await getUserByLogin(login);
    await helix('POST', `/chat/shoutouts?from_broadcaster_id=${state.roomId}&to_broadcaster_id=${u.id}&moderator_id=${config.auth.userId}`);
  },
  async ban(login, duration, reason) {
    needChannel(); const u = await getUserByLogin(login);
    const data = { user_id: u.id, reason: reason || '' };
    if (Number(duration) > 0) data.duration = Math.min(1209600, Math.max(1, Math.round(Number(duration))));
    await helix('POST', '/moderation/bans?' + modQuery(), { data });
  },
  async unban(login) { needChannel(); const u = await getUserByLogin(login); await helix('DELETE', `/moderation/bans?${modQuery()}&user_id=${u.id}`); },
  async warn(login, reason) {
    needChannel(); if (!reason) throw new Error('Indique la raison de l\'avertissement');
    const u = await getUserByLogin(login);
    await helix('POST', '/moderation/warnings?' + modQuery(), { data: { user_id: u.id, reason } });
  },
  async role(action, login) {
    needBroadcaster(); const u = await getUserByLogin(login);
    const q = `${bq()}&user_id=${u.id}`;
    if (action === 'mod') await helix('POST', '/moderation/moderators?' + q);
    else if (action === 'unmod') await helix('DELETE', '/moderation/moderators?' + q);
    else if (action === 'vip') await helix('POST', '/channels/vips?' + q);
    else if (action === 'unvip') await helix('DELETE', '/channels/vips?' + q);
    else throw new Error('Action inconnue');
    return u.display_name;
  },
  async raid(login) {
    needBroadcaster(); const u = await getUserByLogin(login);
    await helix('POST', `/raids?from_broadcaster_id=${state.roomId}&to_broadcaster_id=${u.id}`);
    return u.display_name;
  },
  async unraid() { needBroadcaster(); await helix('DELETE', '/raids?' + bq()); },
  async commercial(length) {
    needBroadcaster();
    const d = await helix('POST', '/channels/commercial', { broadcaster_id: state.roomId, length: Math.min(180, Math.max(30, Number(length) || 30)) });
    return d.data?.[0] || null;
  },
  async snoozeAd() { needBroadcaster(); const d = await helix('POST', '/channels/ads/schedule/snooze?' + bq()); return d.data?.[0] || null; },
  async marker(description) {
    needChannel();
    const d = await helix('POST', '/streams/markers', { user_id: state.roomId, description: String(description || '').slice(0, 140) });
    return d.data?.[0] || null;
  },
  async clip() {
    needChannel();
    const d = await helix('POST', '/clips?' + bq());
    return d.data?.[0] || null;
  },
  async poll({ title, choices, duration, pointsPerVote }) {
    needBroadcaster();
    const list = (choices || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 5);
    if (!title || list.length < 2) throw new Error('Un sondage a besoin d\'une question et d\'au moins 2 choix');
    const body = { broadcaster_id: state.roomId, title: String(title).slice(0, 60), choices: list.map((t) => ({ title: t.slice(0, 25) })), duration: Math.min(1800, Math.max(15, Number(duration) || 120)) };
    if (Number(pointsPerVote) > 0) Object.assign(body, { channel_points_voting_enabled: true, channel_points_per_vote: Number(pointsPerVote) });
    const d = await helix('POST', '/polls', body);
    return d.data?.[0] || null;
  },
  async endPoll(id, archive) {
    needBroadcaster();
    await helix('PATCH', '/polls', { broadcaster_id: state.roomId, id, status: archive ? 'ARCHIVED' : 'TERMINATED' });
  },
  async prediction({ title, outcomes, window }) {
    needBroadcaster();
    const list = (outcomes || []).map((c) => String(c).trim()).filter(Boolean).slice(0, 10);
    if (!title || list.length < 2) throw new Error('Une prédiction a besoin d\'une question et d\'au moins 2 issues');
    const d = await helix('POST', '/predictions', {
      broadcaster_id: state.roomId, title: String(title).slice(0, 45), outcomes: list.map((t) => ({ title: t.slice(0, 25) })),
      prediction_window: Math.min(1800, Math.max(30, Number(window) || 120)),
    });
    return d.data?.[0] || null;
  },
  async endPrediction(id, status, winningOutcomeId) {
    needBroadcaster();
    if (!['RESOLVED', 'CANCELED', 'LOCKED'].includes(status)) throw new Error('Statut invalide');
    await helix('PATCH', '/predictions', { broadcaster_id: state.roomId, id, status, ...(status === 'RESOLVED' ? { winning_outcome_id: winningOutcomeId } : {}) });
  },
  async snapshot() {
    needChannel();
    const isOwner = config.auth.userId === state.roomId;
    const get = (p) => helix('GET', p);
    const tasks = {
      chat: get('/chat/settings?' + modQuery()).then((d) => d.data?.[0] || null),
      shield: get('/moderation/shield_mode?' + modQuery()).then((d) => d.data?.[0] || null),
    };
    if (isOwner) {
      Object.assign(tasks, {
        poll: get('/polls?first=1&' + bq()).then((d) => d.data?.[0] || null),
        prediction: get('/predictions?first=1&' + bq()).then((d) => d.data?.[0] || null),
        ads: get('/channels/ads?' + bq()).then((d) => d.data?.[0] || null),
        mods: get('/moderation/moderators?first=100&' + bq()).then((d) => (d.data || []).map((u) => u.user_name)),
        vips: get('/channels/vips?first=100&' + bq()).then((d) => (d.data || []).map((u) => u.user_name)),
      });
    }
    const keys = Object.keys(tasks);
    const res = await Promise.allSettled(Object.values(tasks));
    const out = { isOwner, errors: {} };
    res.forEach((r, i) => { if (r.status === 'fulfilled') out[keys[i]] = r.value; else out.errors[keys[i]] = r.reason?.message || 'erreur'; });
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Emotes tierces (7TV, BTTV, FFZ) et badges                            */
/* ------------------------------------------------------------------ */
async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(url + ' -> ' + r.status);
  return r.json();
}
const fixUrl = (u) => (u && u.startsWith('//') ? 'https:' + u : u);

async function loadChannelAssets() {
  const id = state.roomId;
  if (!id) return;
  const maps = { ffzG: {}, bttvG: {}, stvG: {}, ffzC: {}, bttvC: {}, stvC: {} };
  const stv = (m, list) => (list || []).forEach((e) => { const h = e.data?.host; if (h) m[e.name] = { url: 'https:' + h.url + '/2x.webp', src: '7TV' }; });
  const bttv = (m, list) => (list || []).forEach((e) => { m[e.code] = { url: `https://cdn.betterttv.net/emote/${e.id}/2x`, src: 'BTTV' }; });
  const ffz = (m, sets) => Object.values(sets || {}).forEach((s) => (s.emoticons || []).forEach((e) => {
    m[e.name] = { url: fixUrl(e.urls['2'] || e.urls['1']), src: 'FFZ' };
  }));
  await Promise.allSettled([
    getJSON('https://7tv.io/v3/emote-sets/global').then((d) => stv(maps.stvG, d.emotes)),
    getJSON('https://7tv.io/v3/users/twitch/' + id).then((d) => stv(maps.stvC, d.emote_set?.emotes)),
    getJSON('https://api.betterttv.net/3/cached/emotes/global').then((d) => bttv(maps.bttvG, d)),
    getJSON('https://api.betterttv.net/3/cached/users/twitch/' + id).then((d) => bttv(maps.bttvC, [...(d.channelEmotes || []), ...(d.sharedEmotes || [])])),
    getJSON('https://api.frankerfacez.com/v1/set/global').then((d) => ffz(maps.ffzG, d.sets)),
    getJSON('https://api.frankerfacez.com/v1/room/id/' + id).then((d) => ffz(maps.ffzC, d.sets)),
  ]);
  state.emotes = Object.assign({}, maps.ffzG, maps.bttvG, maps.stvG, maps.ffzC, maps.bttvC, maps.stvC);
  log(Object.keys(state.emotes).length, 'emotes 7TV/BTTV/FFZ chargées');
  broadcast({ type: 'emotes', emotes: state.emotes });
  await loadBadges();
}
async function loadBadges() {
  if (!config.auth?.token || !state.roomId) return;
  const badges = {};
  const add = (d) => (d.data || []).forEach((set) => set.versions.forEach((v) => { badges[set.set_id + '/' + v.id] = v.image_url_2x; }));
  try {
    add(await helix('GET', '/chat/badges/global'));
    add(await helix('GET', '/chat/badges?broadcaster_id=' + state.roomId));
    state.badges = badges;
    broadcast({ type: 'badges', badges });
  } catch (e) { log('Badges :', e.message); }
}

/* ------------------------------------------------------------------ */
/* Chat Twitch (IRC sur WebSocket)                                      */
/* ------------------------------------------------------------------ */
let irc = null;
let ircTimer = null;

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' }[c] ?? c));
}
function parseIrc(line) {
  const m = { tags: {}, prefix: '', command: '', params: [] };
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      m.tags[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : unescapeTag(kv.slice(eq + 1));
    }
    line = line.slice(sp + 1);
  }
  if (line[0] === ':') { const sp = line.indexOf(' '); m.prefix = line.slice(1, sp); line = line.slice(sp + 1); }
  const t = line.indexOf(' :');
  let trailing = null;
  if (t >= 0) { trailing = line.slice(t + 2); line = line.slice(0, t); }
  const parts = line.split(' ').filter(Boolean);
  m.command = parts.shift() || '';
  m.params = parts;
  if (trailing !== null) m.params.push(trailing);
  return m;
}
function parseBadges(s) {
  if (!s) return [];
  return s.split(',').filter(Boolean).map((b) => { const [set, version] = b.split('/'); return { set, version }; });
}
function userFromTags(tags, prefix) {
  const login = tags.login || (prefix || '').split('!')[0];
  const badges = parseBadges(tags.badges);
  const has = (n) => badges.some((b) => b.set === n);
  return {
    id: tags['user-id'] || '', login, name: tags['display-name'] || login, color: tags.color || '',
    badges, mod: has('moderator') || has('broadcaster'), vip: has('vip'), sub: has('subscriber') || has('founder'),
    broadcaster: has('broadcaster'),
  };
}
function chatItem(tags, prefix, text) {
  let isAction = false;
  if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) { text = text.slice(8, -1); isAction = true; }
  return {
    type: 'chat', id: tags.id || rid(), ts: Number(tags['tmi-sent-ts']) || Date.now(),
    user: userFromTags(tags, prefix), text, emotes: tags.emotes || '',
    bits: Number(tags.bits) || 0, firstMsg: tags['first-msg'] === '1', returning: tags['returning-chatter'] === '1',
    isAction, msgType: tags['msg-id'] || '', rewardId: tags['custom-reward-id'] || '',
    reply: tags['reply-parent-msg-id'] ? {
      id: tags['reply-parent-msg-id'], login: tags['reply-parent-user-login'],
      name: tags['reply-parent-display-name'], text: tags['reply-parent-msg-body'],
    } : null,
  };
}
const TIERS = { Prime: 'Prime', 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };

function handleUserNotice(m) {
  const t = m.tags;
  const kindRaw = t['msg-id'];
  const text = m.params[1] || '';
  const user = userFromTags(t, m.prefix);
  const base = { type: 'event', id: t.id || rid(), ts: Number(t['tmi-sent-ts']) || Date.now(), user, text, emotes: t.emotes || '', systemText: t['system-msg'] || '' };
  const p = (k) => t['msg-param-' + k];
  switch (kindRaw) {
    case 'sub': case 'resub':
      return emitItem({ ...base, kind: 'sub', months: Number(p('cumulative-months')) || 1, tier: TIERS[p('sub-plan')] || 'Tier 1', resub: kindRaw === 'resub' });
    case 'subgift': case 'anonsubgift':
      if (p('community-gift-id')) return; // fait partie d'un don groupé, déjà annoncé
      return emitItem({ ...base, kind: 'subgift', recipient: p('recipient-display-name'), tier: TIERS[p('sub-plan')] || 'Tier 1', count: 1 });
    case 'submysterygift': case 'anonsubmysterygift':
      return emitItem({ ...base, kind: 'subgift', count: Number(p('mass-gift-count')) || 1, tier: TIERS[p('sub-plan')] || 'Tier 1', community: true });
    case 'giftpaidupgrade': case 'anongiftpaidupgrade': case 'primepaidupgrade':
      return emitItem({ ...base, kind: 'sub', months: 1, tier: TIERS[p('sub-plan')] || 'Tier 1', upgrade: true });
    case 'raid':
      return emitItem({ ...base, kind: 'raid', viewers: Number(p('viewerCount')) || 0 });
    case 'announcement':
      return emitItem({ ...chatItem(t, m.prefix, text), msgType: 'announcement', announceColor: p('color') || 'PRIMARY' });
    case 'viewermilestone':
      if (p('category') === 'watch-streak') return emitItem({ ...base, kind: 'watchstreak', value: Number(p('value')) || 0 });
      return emitItem({ ...base, kind: 'other' });
    default:
      return emitItem({ ...base, kind: 'other' });
  }
}

async function handleIrcLine(line) {
  const m = parseIrc(line);
  switch (m.command) {
    case 'PING': irc?.send('PONG :' + (m.params[0] || 'tmi.twitch.tv')); break;
    case 'ROOMSTATE':
      if (state.irc !== 'on') { state.irc = 'on'; log('Chat connecté sur #' + config.channel); pushStatus(); }
      if (m.tags['room-id'] && m.tags['room-id'] !== state.roomId) {
        state.roomId = m.tags['room-id'];
        pushStatus();
        loadChannelAssets();
        startEventSub();
      }
      break;
    case 'PRIVMSG': emitItem(chatItem(m.tags, m.prefix, m.params[1] || '')); break;
    case 'USERNOTICE': handleUserNotice(m); break;
    case 'CLEARCHAT': {
      const target = m.params[1];
      if (target) {
        const duration = Number(m.tags['ban-duration']) || 0;
        emitItem({ type: 'clearUser', id: rid(), ts: Date.now(), userId: m.tags['target-user-id'], login: target, duration });
      } else emitItem({ type: 'clear', id: rid(), ts: Date.now() });
      break;
    }
    case 'CLEARMSG': emitItem({ type: 'delete', id: rid(), targetId: m.tags['target-msg-id'], login: m.tags.login, ts: Date.now() }); break;
    case 'USERSTATE': case 'GLOBALUSERSTATE': state.userstate = { ...(state.userstate || {}), ...m.tags }; break;
    case 'NOTICE': {
      const text = m.params[m.params.length - 1] || '';
      if (/authentication failed|improperly formatted auth/i.test(text)) {
        log('Authentification chat refusée, tentative de rafraîchissement…');
        if (await refreshToken()) return ircConnect();
        config.auth = null; saveConfig(); pushStatus(); return ircConnect();
      }
      emitItem({ type: 'notice', id: rid(), ts: Date.now(), text });
      break;
    }
    case 'RECONNECT': ircConnect(); break;
    default: break;
  }
}

function ircDisconnect() {
  clearTimeout(ircTimer);
  if (irc) { const old = irc; irc = null; old.removeAllListeners(); try { old.close(); } catch { /* */ } }
  state.irc = 'off';
}
function ircConnect() {
  ircDisconnect();
  if (!config.channel) { pushStatus(); return; }
  state.irc = 'connecting'; pushStatus();
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  irc = ws;
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    if (config.auth?.token) { ws.send('PASS oauth:' + config.auth.token); ws.send('NICK ' + config.auth.login); }
    else ws.send('NICK justinfan' + Math.floor(10000 + Math.random() * 80000));
    ws.send('JOIN #' + config.channel.toLowerCase());
  });
  ws.on('message', (data) => data.toString().split('\r\n').filter(Boolean).forEach((l) => handleIrcLine(l).catch((e) => log('IRC', e.message))));
  ws.on('error', (e) => log('Erreur chat :', e.message));
  ws.on('close', () => {
    if (irc !== ws) return;
    state.irc = 'off'; pushStatus();
    log('Chat déconnecté, reconnexion dans 3 s');
    ircTimer = setTimeout(ircConnect, 3000);
  });
}
function ircSay(text, replyTo) {
  if (!irc || state.irc !== 'on') throw new Error('Chat non connecté');
  if (!config.auth?.token) throw new Error('Connecte ton compte Twitch pour écrire dans le chat');
  text = String(text).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return;
  irc.send(`${replyTo ? '@reply-parent-msg-id=' + replyTo + ' ' : ''}PRIVMSG #${config.channel.toLowerCase()} :${text}`);
  // Twitch ne renvoie pas nos propres messages : on les affiche nous-mêmes
  const us = state.userstate || {};
  const tags = { ...us, login: config.auth.login, 'display-name': us['display-name'] || config.auth.login, 'user-id': config.auth.userId, id: rid(), emotes: '' };
  const item = chatItem(tags, '', text);
  item.self = true;
  emitItem(item);
}

/* ------------------------------------------------------------------ */
/* EventSub (follows, points de chaîne, pubs)                           */
/* ------------------------------------------------------------------ */
let es = null;
let esGen = 0;
function stopEventSub() {
  esGen++;
  if (es) { const old = es; es = null; old.removeAllListeners(); try { old.close(); } catch { /* */ } }
  state.eventsub = 'off'; state.eventsubDetail = '';
}
function startEventSub() {
  stopEventSub();
  if (!config.auth?.token || !state.roomId) { pushStatus(); return; }
  state.eventsub = 'connecting'; pushStatus();
  connectES('wss://eventsub.wss.twitch.tv/ws', false, esGen);
}
function connectES(url, isReconnect, gen) {
  const ws = new WebSocket(url);
  ws.on('message', async (raw) => {
    if (gen !== esGen) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.metadata?.message_type;
    if (t === 'session_welcome') {
      const old = es; es = ws;
      if (old && old !== ws) { old.removeAllListeners(); try { old.close(); } catch { /* */ } }
      if (!isReconnect) await subscribeAll(msg.payload.session.id);
    } else if (t === 'session_reconnect') {
      connectES(msg.payload.session.reconnect_url, true, gen);
    } else if (t === 'notification') {
      handleESNotification(msg.payload);
    } else if (t === 'revocation') {
      log('Abonnement EventSub révoqué :', msg.payload.subscription?.type);
    }
  });
  ws.on('error', (e) => log('EventSub :', e.message));
  ws.on('close', () => {
    if (gen !== esGen || es !== ws) return;
    es = null; state.eventsub = 'off'; pushStatus();
    setTimeout(() => { if (gen === esGen) startEventSub(); }, 5000);
  });
}
async function subscribeAll(sessionId) {
  const room = state.roomId; const me = config.auth.userId;
  const subs = [
    ['channel.follow', '2', { broadcaster_user_id: room, moderator_user_id: me }, 'follows'],
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: room }, 'points de chaîne'],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: room }, 'pubs'],
  ];
  const B = { broadcaster_user_id: room }; const BM = { broadcaster_user_id: room, moderator_user_id: me };
  // abonnements « bonus » pour les filtres du chat : un échec ne change pas le statut (ex. sondages si pas affilié)
  const extras = [
    ['channel.poll.begin', '1', B], ['channel.poll.end', '1', B],
    ['channel.prediction.begin', '1', B], ['channel.prediction.lock', '1', B], ['channel.prediction.end', '1', B],
    ['channel.hype_train.begin', ['2', '1'], B], ['channel.hype_train.end', ['2', '1'], B],
    ['channel.goal.begin', '1', B], ['channel.goal.end', '1', B],
    ['channel.charity_campaign.donate', '1', B],
    ['stream.online', '1', B], ['stream.offline', '1', B],
    ['channel.shoutout.create', '1', BM], ['channel.shoutout.receive', '1', BM],
    ['channel.shield_mode.begin', '1', BM], ['channel.shield_mode.end', '1', BM],
    ['channel.unban', '1', B], ['channel.unban_request.create', '1', BM], ['channel.warning.send', '1', BM],
  ];
  const sub = (type, version, condition) => helix('POST', '/eventsub/subscriptions', { type, version, condition, transport: { method: 'websocket', session_id: sessionId } });
  const failed = [];
  const report = [];
  for (const [type, version, condition, label] of subs) {
    try { await sub(type, version, condition); report.push({ type, ok: true }); } catch (e) { failed.push(label); report.push({ type, ok: false, error: e.message }); log('EventSub', type, ':', e.message); }
  }
  for (const [type, versions, condition] of extras) {
    const errs = [];
    for (const v of [].concat(versions)) {
      try { await sub(type, v, condition); errs.length = 0; break; } catch (e) { errs.push(`v${v} ${e.message}`); }
    }
    report.push({ type, ok: !errs.length, error: errs.join(' | ') });
    if (errs.length) log('EventSub (bonus)', type, ':', errs.join(' | '));
  }
  state.eventsubReport = { at: Date.now(), items: report };
  state.eventsub = failed.length === 0 ? 'on' : failed.length === subs.length ? 'error' : 'partial';
  state.eventsubDetail = failed.length ? 'Indisponible : ' + failed.join(', ') + ' (il faut être le streamer ou modo de la chaîne)' : '';
  pushStatus();
}
function handleESNotification(payload) {
  const type = payload.subscription?.type;
  const e = payload.event || {};
  const ts = Date.now();
  if (type === 'channel.follow') {
    emitItem({ type: 'event', kind: 'follow', id: rid(), ts, user: { id: e.user_id, login: e.user_login, name: e.user_name, badges: [] } });
  } else if (type === 'channel.channel_points_custom_reward_redemption.add') {
    emitItem({ type: 'event', kind: 'reward', id: e.id || rid(), ts, user: { id: e.user_id, login: e.user_login, name: e.user_name, badges: [] }, reward: { title: e.reward?.title, cost: e.reward?.cost }, text: e.user_input || '' });
  } else if (type === 'channel.ad_break.begin') {
    emitItem({ type: 'event', kind: 'ad', id: rid(), ts, duration: e.duration_seconds, user: null, manual: e.is_automatic === false });
    return;
  }
  const u = (id, login, name) => (login || name ? { id: id || '', login: login || '', name: name || login, badges: [] } : null);
  const ev = (kind, extra) => emitItem({ type: 'event', kind, id: rid(), ts, user: null, ...extra });
  switch (type) {
    case 'channel.poll.begin': return ev('poll', { phase: 'begin', title: e.title, choices: (e.choices || []).map((c) => c.title) });
    case 'channel.poll.end': {
      if (e.status === 'archived') return;
      const ch = (e.choices || []).map((c) => ({ title: c.title, votes: c.votes || 0 })).sort((a, b) => b.votes - a.votes);
      return ev('poll', { phase: 'end', title: e.title, choices: ch, status: e.status });
    }
    case 'channel.prediction.begin': return ev('prediction', { phase: 'begin', title: e.title, outcomes: (e.outcomes || []).map((o) => o.title) });
    case 'channel.prediction.lock': return ev('prediction', { phase: 'lock', title: e.title });
    case 'channel.prediction.end': {
      const win = (e.outcomes || []).find((o) => o.id === e.winning_outcome_id);
      return ev('prediction', { phase: e.status === 'canceled' ? 'cancel' : 'end', title: e.title, winner: win?.title || '' });
    }
    case 'channel.hype_train.begin': return ev('hypetrain', { phase: 'begin', level: e.level || 1 });
    case 'channel.hype_train.end': return ev('hypetrain', { phase: 'end', level: e.level || 1, total: e.total || 0 });
    case 'channel.goal.begin': return ev('goal', { phase: 'begin', goalType: e.type, description: e.description, current: e.current_amount, target: e.target_amount });
    case 'channel.goal.end': return ev('goal', { phase: e.is_achieved ? 'achieved' : 'end', goalType: e.type, description: e.description, current: e.current_amount, target: e.target_amount });
    case 'channel.charity_campaign.donate': {
      const a = e.amount || {}; const val = (a.value || 0) / Math.pow(10, a.decimal_places || 0);
      return ev('charity', { user: u(e.user_id, e.user_login, e.user_name), amount: val.toLocaleString('fr-FR', { style: 'currency', currency: a.currency || 'EUR' }), charity: e.charity_name });
    }
    case 'stream.online': return ev('stream', { phase: 'online' });
    case 'stream.offline': return ev('stream', { phase: 'offline' });
    case 'channel.shoutout.create': return ev('shoutout', { phase: 'out', user: u(e.to_broadcaster_user_id, e.to_broadcaster_user_login, e.to_broadcaster_user_name), viewers: e.viewer_count, by: e.moderator_user_name });
    case 'channel.shoutout.receive': return ev('shoutout', { phase: 'in', user: u(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name), viewers: e.viewer_count });
    case 'channel.shield_mode.begin': return ev('shield', { phase: 'on', by: e.moderator_user_name });
    case 'channel.shield_mode.end': return ev('shield', { phase: 'off', by: e.moderator_user_name });
    case 'channel.unban': return ev('unban', { user: u(e.user_id, e.user_login, e.user_name), by: e.moderator_user_name });
    case 'channel.unban_request.create': return ev('unbanrequest', { user: u(e.user_id, e.user_login, e.user_name), text: e.text || '' });
    case 'channel.warning.send': return ev('warn', { user: u(e.user_id, e.user_login, e.user_name), by: e.moderator_user_name, reason: e.reason || '' });
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Mode démo (pour régler les overlays sans être en live)               */
/* ------------------------------------------------------------------ */
let demoTimer = null;
const DEMO_USERS = [
  ['PixelPanda', '#ff6b6b', ['subscriber/12']], ['LunaGamer', '#c56cf0', ['vip/1']], ['xXDarkSasukeXx', '', []],
  ['Mixmaixe', '#ff9f43', ['broadcaster/1']], ['ModoZen', '#1dd1a1', ['moderator/1', 'subscriber/24']], ['Toto_57', '#54a0ff', []],
  ['ChefTartiflette', '#feca57', ['subscriber/3']], ['NoobMaster', '', ['subscriber/1']],
];
const DEMO_MSG = [
  'Salut tout le monde !', 'GG c\'était propre Kappa', 'Il y a un fantôme derrière toi 👻', 'Quel est le prochain jeu ?',
  '!discord', 'Trop fort ce passage PogChamp', 'Bonsoir le chat, je viens d\'arriver', 'mdr la tête du perso',
  'On est combien ce soir ?', 'Courage pour le boss !', 'LUL LUL LUL', 'Tu streames demain ?', '@GreenHeros t\'as vu le clip ?',
];
function demoTick() {
  const [name, color, badges] = DEMO_USERS[Math.floor(Math.random() * DEMO_USERS.length)];
  const r = Math.random();
  const user = { id: 'demo-' + name, login: name.toLowerCase(), name, color, badges: badges.map((b) => ({ set: b.split('/')[0], version: b.split('/')[1] })) };
  user.mod = badges.some((b) => /^(moderator|broadcaster)/.test(b)); user.vip = badges.some((b) => b.startsWith('vip')); user.sub = badges.some((b) => b.startsWith('subscriber'));
  const base = { id: rid(), ts: Date.now(), user, demo: true };
  if (r < 0.07) emitItem({ ...base, type: 'event', kind: 'follow' });
  else if (r < 0.11) emitItem({ ...base, type: 'event', kind: 'sub', months: Math.ceil(Math.random() * 20), tier: 'Tier 1', resub: true, text: 'Toujours là depuis le début !' });
  else if (r < 0.13) emitItem({ ...base, type: 'event', kind: 'raid', viewers: Math.ceil(Math.random() * 80) });
  else if (r < 0.16) emitItem({ ...base, type: 'event', kind: 'reward', reward: { title: 'Défi : jouer sans lampe', cost: 500 }, text: '' });
  else if (r < 0.18) emitItem({ ...base, type: 'event', kind: 'subgift', count: 5, tier: 'Tier 1', community: true });
  else {
    const text = DEMO_MSG[Math.floor(Math.random() * DEMO_MSG.length)];
    const k = text.indexOf('Kappa');
    const emotes = k >= 0 ? `25:${Array.from(text.slice(0, k)).length}-${Array.from(text.slice(0, k)).length + 4}` : '';
    emitItem({ ...base, type: 'chat', text, emotes, firstMsg: Math.random() < 0.08, bits: Math.random() < 0.03 ? 100 : 0, msgType: '', reply: null });
  }
  demoTimer = setTimeout(demoTick, 900 + Math.random() * 2200);
}
function setDemo(on) {
  clearTimeout(demoTimer);
  state.demo = !!on;
  if (state.demo) demoTick();
  pushStatus();
}

/* ------------------------------------------------------------------ */
/* Serveur HTTP + API                                                   */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .then((out) => res.json(out ?? { ok: true }))
  .catch((e) => res.status(400).json({ error: e.message }));

app.get('/api/state', (req, res) => res.json({ status: publicStatus(), settings, planning }));
app.get('/api/eventsub', (req, res) => res.json(state.eventsubReport || { at: null, items: [] }));
const localIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
app.get('/api/info', (req, res) => res.json({ port: PORT, ips: localIps() }));

app.post('/api/config', wrap(async (req) => {
  const { clientId, channel } = req.body || {};
  if (typeof clientId === 'string') config.clientId = clientId.trim();
  if (typeof channel === 'string') {
    const ch = channel.trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').toLowerCase();
    if (ch !== config.channel) { config.channel = ch; state.roomId = null; state.emotes = {}; state.badges = {}; stopEventSub(); history.length = 0; ircConnect(); }
  }
  saveConfig(); pushStatus();
}));
app.post('/api/auth/start', wrap(() => startDeviceAuth()));
app.post('/api/auth/logout', wrap(() => { config.auth = null; pendingDevice = null; saveConfig(); stopEventSub(); ircConnect(); }));

app.post('/api/settings', wrap((req) => {
  settings = deepMerge(settings, req.body || {});
  saveJSON('settings.json', settings);
  broadcast({ type: 'settings', settings });
  return settings;
}));
app.get('/api/planning', (req, res) => res.json(planning));
app.put('/api/planning', wrap((req) => {
  const p = req.body || {};
  if (!Array.isArray(p.slots)) throw new Error('Planning invalide');
  planning = { ...DEFAULT_PLANNING, ...p };
  saveJSON('planning.json', planning);
  broadcast({ type: 'planning', planning });
  return planning;
}));

app.post('/api/highlight', wrap(async (req) => {
  const msg = req.body?.message;
  if (!msg) throw new Error('Message manquant');
  state.highlight = { ...msg, shownAt: Date.now() };
  if (msg.user?.id && !msg.user.avatar && config.auth?.token && !String(msg.user.id).startsWith('demo')) {
    try { const u = await getUserById(msg.user.id); if (u) state.highlight.user = { ...msg.user, avatar: u.profile_image_url }; } catch { /* */ }
  }
  broadcast({ type: 'highlight', highlight: state.highlight });
}));
app.delete('/api/highlight', wrap(() => { state.highlight = null; broadcast({ type: 'highlight', highlight: null }); }));

app.post('/api/chat/send', wrap(async (req) => {
  const text = String(req.body?.text || '').trim();
  const replyTo = req.body?.replyTo || null;
  if (!text) return;
  if (!text.startsWith('/')) return ircSay(text, replyTo);
  const [cmd, ...args] = text.slice(1).split(/\s+/);
  const rest = (n) => args.slice(n).join(' ');
  const needArg = () => { if (!args[0]) throw new Error('Pseudo manquant : /' + cmd + ' pseudo'); };
  const dur = (v, def) => { const m = String(v || '').match(/^(\d+)([smhdj]?)$/i); if (!m) return def; return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, j: 86400 }[m[2].toLowerCase()] || 1); };
  switch (cmd.toLowerCase()) {
    case 'me': return ircSay('\u0001ACTION ' + args.join(' ') + '\u0001');
    case 'timeout': case 'to': needArg(); return admin.ban(args[0], dur(args[1], 600), rest(2));
    case 'ban': needArg(); return admin.ban(args[0], 0, rest(1));
    case 'unban': case 'untimeout': needArg(); return admin.unban(args[0]);
    case 'warn': needArg(); return admin.warn(args[0], rest(1));
    case 'so': case 'shoutout': needArg(); return admin.shoutout(args[0]);
    case 'announce': return admin.announce(args.join(' '));
    case 'announceblue': case 'announcegreen': case 'announceorange': case 'announcepurple':
      return admin.announce(args.join(' '), cmd.toLowerCase().slice(8));
    case 'clear': return admin.clear();
    case 'slow': return admin.chatSettings({ slow_mode: true, slow_mode_wait_time: Math.min(120, Math.max(3, dur(args[0], 30))) });
    case 'slowoff': return admin.chatSettings({ slow_mode: false });
    case 'followers': return admin.chatSettings({ follower_mode: true, follower_mode_duration: /^\d+$/.test(args[0] || '') ? Number(args[0]) : Math.round(dur(args[0], 0) / 60) });
    case 'followersoff': return admin.chatSettings({ follower_mode: false });
    case 'subscribers': return admin.chatSettings({ subscriber_mode: true });
    case 'subscribersoff': return admin.chatSettings({ subscriber_mode: false });
    case 'emoteonly': return admin.chatSettings({ emote_mode: true });
    case 'emoteonlyoff': return admin.chatSettings({ emote_mode: false });
    case 'uniquechat': case 'r9kbeta': return admin.chatSettings({ unique_chat_mode: true });
    case 'uniquechatoff': case 'r9kbetaoff': return admin.chatSettings({ unique_chat_mode: false });
    case 'shieldmode': return admin.shield(true);
    case 'shieldmodeoff': return admin.shield(false);
    case 'mod': case 'unmod': case 'vip': case 'unvip': needArg(); return admin.role(cmd.toLowerCase(), args[0]);
    case 'raid': needArg(); return admin.raid(args[0]);
    case 'unraid': return admin.unraid();
    case 'commercial': return admin.commercial(dur(args[0], 30));
    case 'marker': return admin.marker(args.join(' '));
    case 'clip': return admin.clip();
    default: return ircSay(text, replyTo); // laisse Twitch répondre pour les autres commandes
  }
}));

/* Commandes admin de l'onglet Stream */
app.get('/api/admin/state', wrap(() => admin.snapshot()));
app.patch('/api/admin/chat-settings', wrap((req) => admin.chatSettings(req.body || {})));
app.post('/api/admin/shield', wrap((req) => admin.shield(req.body?.active)));
app.post('/api/admin/clear', wrap(() => admin.clear()));
app.post('/api/admin/announce', wrap((req) => admin.announce(req.body?.message, req.body?.color)));
app.post('/api/admin/shoutout', wrap((req) => admin.shoutout(req.body?.login)));
app.post('/api/admin/ban', wrap((req) => admin.ban(req.body?.login, req.body?.duration, req.body?.reason)));
app.post('/api/admin/unban', wrap((req) => admin.unban(req.body?.login)));
app.post('/api/admin/warn', wrap((req) => admin.warn(req.body?.login, req.body?.reason)));
app.post('/api/admin/role', wrap(async (req) => ({ name: await admin.role(req.body?.action, req.body?.login) })));
app.post('/api/admin/raid', wrap(async (req) => ({ name: await admin.raid(req.body?.login) })));
app.delete('/api/admin/raid', wrap(() => admin.unraid()));
app.post('/api/admin/commercial', wrap((req) => admin.commercial(req.body?.length)));
app.post('/api/admin/ads/snooze', wrap(() => admin.snoozeAd()));
app.post('/api/admin/marker', wrap((req) => admin.marker(req.body?.description)));
app.post('/api/admin/clip', wrap(() => admin.clip()));
app.post('/api/admin/poll', wrap((req) => admin.poll(req.body || {})));
app.patch('/api/admin/poll', wrap((req) => admin.endPoll(req.body?.id, req.body?.archive)));
app.post('/api/admin/prediction', wrap((req) => admin.prediction(req.body || {})));
app.patch('/api/admin/prediction', wrap((req) => admin.endPrediction(req.body?.id, req.body?.status, req.body?.winningOutcomeId)));

app.post('/api/mod/ban', wrap(async (req) => {
  const { userId, duration, reason } = req.body || {};
  await helix('POST', '/moderation/bans?' + modQuery(), { data: { user_id: userId, ...(duration ? { duration: Number(duration) } : {}), reason: reason || '' } });
}));
app.post('/api/mod/unban', wrap(async (req) => { await helix('DELETE', `/moderation/bans?${modQuery()}&user_id=${req.body.userId}`); }));
app.post('/api/mod/delete', wrap(async (req) => { await helix('DELETE', `/moderation/chat?${modQuery()}&message_id=${req.body.messageId}`); }));
app.post('/api/mod/shoutout', wrap(async (req) => {
  await helix('POST', `/chat/shoutouts?from_broadcaster_id=${state.roomId}&to_broadcaster_id=${req.body.userId}&moderator_id=${config.auth.userId}`);
}));

app.get('/api/user/:id', wrap(async (req) => {
  const u = await getUserById(req.params.id);
  let followedAt = null;
  try {
    const f = await helix('GET', `/channels/followers?broadcaster_id=${state.roomId}&user_id=${req.params.id}`);
    followedAt = f.data?.[0]?.followed_at || null;
  } catch { /* scope manquant */ }
  return { user: u, followedAt };
}));

app.get('/api/stream', wrap(async () => {
  if (!state.roomId) throw new Error('Pas encore connecté à la chaîne');
  const [c, s] = await Promise.all([
    helix('GET', '/channels?broadcaster_id=' + state.roomId),
    helix('GET', '/streams?user_id=' + state.roomId),
  ]);
  return { channel: c.data?.[0] || null, live: s.data?.[0] || null };
}));
app.patch('/api/stream', wrap(async (req) => {
  const body = {};
  if (typeof req.body.title === 'string') body.title = req.body.title;
  if (req.body.gameId) body.game_id = req.body.gameId;
  if (Array.isArray(req.body.tags)) body.tags = req.body.tags;
  await helix('PATCH', '/channels?broadcaster_id=' + state.roomId, body);
}));
app.get('/api/categories', wrap(async (req) => {
  const d = await helix('GET', '/search/categories?first=10&query=' + encodeURIComponent(req.query.q || ''));
  return d.data || [];
}));

app.post('/api/demo', wrap((req) => setDemo(req.body?.on)));
app.post('/api/test-event', wrap((req) => {
  const kind = req.body?.kind || 'follow';
  const user = { id: 'demo-test', login: 'viewer_test', name: 'Viewer_Test', color: '#54a0ff', badges: [] };
  const base = { type: 'event', id: rid(), ts: Date.now(), user, demo: true, test: true };
  const map = {
    follow: { kind: 'follow' },
    sub: { kind: 'sub', months: 6, tier: 'Tier 1', resub: true, text: 'Six mois déjà !' },
    subgift: { kind: 'subgift', count: 10, tier: 'Tier 1', community: true },
    raid: { kind: 'raid', viewers: 42 },
    reward: { kind: 'reward', reward: { title: 'Hydrate-toi !', cost: 300 }, text: '' },
  };
  if (kind === 'cheer') return emitItem({ type: 'chat', id: rid(), ts: Date.now(), user, text: 'Cheer100 Allez allez !', emotes: '', bits: 100, demo: true, test: true });
  emitItem({ ...base, ...(map[kind] || map.follow) });
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'init', status: publicStatus(), settings, planning, emotes: state.emotes, badges: state.badges,
    highlight: state.highlight, history,
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});
setInterval(() => { for (const c of clients) if (c.readyState === WebSocket.OPEN) c.ping(); }, 30000);

server.listen(PORT, '0.0.0.0', async () => {
  const ips = localIps();
  log(`GreenChat démarré : http://localhost:${PORT}`);
  ips.forEach((ip) => log(`   depuis un autre PC : http://${ip}:${PORT}`));
  if (config.auth?.token) await ensureValidToken();
  ircConnect();
  setInterval(() => { if (config.auth?.token) ensureValidToken(); }, 60 * 60 * 1000); // Twitch exige une validation horaire
});
