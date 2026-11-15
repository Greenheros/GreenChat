/* Panneau de contrôle GreenChat */
(() => {
  const { esc, api } = GC;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const S = {
    status: {}, settings: {}, planning: { slots: [], specials: [] },
    emotes: Object.create(null), badges: {}, highlight: null,
    items: [], byId: new Map(), replyTo: null,
  };
  const local = JSON.parse(localStorage.getItem('gc.local') || '{}');
  const saveLocal = () => localStorage.setItem('gc.local', JSON.stringify(local));
  const onAuthHooks = [];

  /* ---------------- Toasts ---------------- */
  function toast(text, err = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), err ? 6000 : 3000);
  }
  // navigator.clipboard n'existe qu'en https/localhost : depuis un autre PC (http://IP:3500) on passe par execCommand
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).catch(() => copyFallback(text));
    return copyFallback(text);
  }
  function copyFallback(text) {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      ok ? resolve() : reject(new Error('copie impossible'));
    });
  }
  const run = (p, okMsg) => p.then((r) => { if (okMsg) toast(okMsg); return r; }).catch((e) => { toast(e.message, true); throw e; });

  /* ---------------- Onglets ---------------- */
  $$('.nav').forEach((b) => b.addEventListener('click', () => {
    $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'stream') loadStream();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }));

  /* ---------------- WebSocket ---------------- */
  GC.connect(onMessage, (ok) => { if (!ok) setDot('#dotIrc', 'error'); });

  function onMessage(m) {
    switch (m.type) {
      case 'init':
        S.status = m.status; S.settings = m.settings; S.planning = m.planning;
        S.emotes = GC.toMap(m.emotes); S.badges = m.badges || {}; S.highlight = m.highlight;
        S.items = []; S.byId.clear();
        (m.history || []).forEach((it) => addItem(it, false));
        applyStatus(); fillSettings(); renderColumns(); renderPlanning(); renderObs(); renderOnscreen();
        maybeAutoWizard();
        break;
      case 'status': S.status = m.status; applyStatus(); break;
      case 'settings': S.settings = m.settings; document.documentElement.style.setProperty('--accent', S.settings.accent || '#2ee59d'); break;
      case 'planning': if (!planDirty) { S.planning = m.planning; renderPlanning(); } break;
      case 'emotes': S.emotes = GC.toMap(m.emotes); break;
      case 'badges': S.badges = m.badges || {}; break;
      case 'highlight': S.highlight = m.highlight; renderOnscreen(); break;
      case 'auth':
        if (m.ok) { toast('Connecté à Twitch en tant que ' + m.login); renderAuth(); onAuthHooks.forEach((f) => f()); }
        else toast('Connexion Twitch échouée : ' + m.error, true);
        wizOnAuth(m);
        break;
      case 'chat': case 'event': case 'notice': case 'delete': case 'clearUser': case 'clear':
        addItem(m, true); break;
      default: break;
    }
  }

  function setDot(sel, st) { const d = $(sel); d.className = 'dot ' + (st || ''); }
  function applyStatus() {
    const st = S.status;
    document.documentElement.style.setProperty('--accent', S.settings.accent || '#2ee59d');
    setDot('#dotIrc', st.irc); setDot('#dotEs', st.eventsub);
    $('#dotIrc').title = 'Chat : ' + st.irc;
    $('#dotEs').title = 'EventSub (follows, points) : ' + st.eventsub + (st.eventsubDetail ? ' — ' + st.eventsubDetail : '');
    $('#chanName').textContent = st.channel ? '#' + st.channel : 'Aucune chaîne — va dans Réglages';
    const pill = $('#ircPill');
    pill.textContent = st.irc === 'on' ? (st.login ? 'connecté · ' + st.login : 'lecture seule') : st.irc === 'connecting' ? 'connexion…' : 'hors ligne';
    pill.className = 'pill' + (st.irc === 'on' ? ' on' : '');
    $('#demoPill').hidden = !st.demo;
    $('#demoBtn').textContent = st.demo ? 'Arrêter la démo' : 'Activer la démo';
    $('#msgInput').disabled = !st.login;
    $('#msgInput').placeholder = st.login ? 'Envoyer un message… (/timeout, /ban, /slow, /raid, /commercial… liste complète dans l\'onglet Stream)' : 'Connecte ton compte Twitch (Réglages) pour écrire et modérer';
    renderAuth();
    renderScopeWarn();
  }

  /* ---------------- Classement des messages ---------------- */
  const ignored = () => (S.settings.ignoredUsers || []).map((s) => s.toLowerCase());
  const mentionLogin = () => (S.status.login || S.status.channel || '').toLowerCase();
  function isMention(it) {
    if (it.type !== 'chat' || it.self) return false;
    const t = (it.text || '').toLowerCase();
    const me = mentionLogin();
    if (me && new RegExp('(^|[^a-z0-9_])@?' + me.replace(/[^a-z0-9_]/g, '') + '([^a-z0-9_]|$)').test(t)) return true;
    return (S.settings.highlightWords || []).some((w) => w && t.includes(w.toLowerCase()));
  }
  const isBot = (it) => ignored().includes((it.user?.login || '').toLowerCase());
  const isCmd = (it) => (it.text || '').startsWith('!');

  function addItem(it, live) {
    if (it.type === 'delete') {
      const t = S.byId.get(it.targetId); if (t) t.deleted = true;
      $$(`.msg[data-id="${CSS.escape(it.targetId)}"]`).forEach((el) => el.classList.add('deleted'));
      return;
    }
    if (it.type === 'clearUser') {
      S.items.forEach((x) => { if (x.type === 'chat' && x.user?.login === it.login) x.deleted = true; });
      $$(`.msg[data-login="${CSS.escape(it.login)}"]`).forEach((el) => el.classList.add('deleted'));
      it = { ...it, type: 'notice', text: it.duration ? `${it.login} a été exclu ${fmtDur(it.duration)}` : `${it.login} a été banni` , mod: true, cat: 'ban' };
    }
    if (it.type === 'clear') it = { ...it, type: 'notice', text: 'Le chat a été vidé par un modérateur', mod: true, cat: 'clear' };
    it._mention = isMention(it);
    S.items.push(it); S.byId.set(it.id, it);
    if (S.items.length > 1500) { const old = S.items.shift(); S.byId.delete(old.id); }
    if (live) { appendToColumns(it); sounds(it); }
  }
  const fmtDur = (s) => s >= 86400 ? Math.round(s / 86400) + ' j' : s >= 3600 ? Math.round(s / 3600) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s';

  function sounds(it) {
    if (it.demo && !it.test) return;
    if (it.type === 'chat' && it.firstMsg && local.sndFirst) GC.ding(0.3, [660, 990]);
    else if (it._mention && local.sndMention) GC.ding(0.3, [990, 1320]);
    else if (it.type === 'event' && local.sndEvent && it.kind !== 'ad') GC.ding(0.3, [523, 659, 784]);
  }

  /* ---------------- Colonnes ---------------- */
  /* Types de contenu filtrables par colonne */
  const CATS = [
    { group: 'Communauté' },
    { k: 'follow', icon: '💚', label: 'Follows' },
    { k: 'sub', icon: '⭐', label: 'Abonnements' },
    { k: 'subgift', icon: '🎁', label: 'Abos offerts' },
    { k: 'bits', icon: '🔷', label: 'Bits' },
    { k: 'raid', icon: '🚀', label: 'Raids' },
    { k: 'reward', icon: '🎯', label: 'Récompenses (points de chaîne)' },
    { k: 'watchstreak', icon: '🔥', label: 'Streams consécutifs vus' },
    { k: 'charity', icon: '💝', label: 'Dons caritatifs' },
    { group: 'Interactions' },
    { k: 'poll', icon: '📊', label: 'Sondages' },
    { k: 'prediction', icon: '🔮', label: 'Prédictions' },
    { k: 'hypetrain', icon: '🚂', label: 'Train de la hype' },
    { k: 'goal', icon: '🏁', label: 'Objectifs de la chaîne' },
    { k: 'shoutout', icon: '📢', label: 'Shoutouts' },
    { k: 'announcement', icon: '📣', label: 'Annonces' },
    { group: 'Modération' },
    { k: 'ban', icon: '🔨', label: 'Bans et timeouts' },
    { k: 'unban', icon: '♻️', label: 'Unbans' },
    { k: 'unbanrequest', icon: '🙏', label: 'Demandes de déban' },
    { k: 'warn', icon: '⚠️', label: 'Avertissements' },
    { k: 'shield', icon: '🛡️', label: 'Mode bouclier' },
    { k: 'clear', icon: '🧹', label: 'Chat vidé' },
    { group: 'Stream' },
    { k: 'stream', icon: '🟢', label: 'Live commencé / terminé' },
    { k: 'ad', icon: '📺', label: 'Publicités' },
    { k: 'notice', icon: 'ℹ️', label: 'Infos système Twitch' },
  ];
  const CAT_KEYS = CATS.filter((c) => c.k).map((c) => c.k);
  const MOD_KEYS = ['ban', 'unban', 'unbanrequest', 'warn', 'shield', 'clear'];
  const allOn = (on, except = []) => Object.fromEntries(CAT_KEYS.map((k) => [k, on && !except.includes(k)]));
  const pick = (keys) => Object.fromEntries(CAT_KEYS.map((k) => [k, keys.includes(k)]));
  const MSG_DEFAULT = { only: {}, hideBots: false, hideCommands: false, hideDeleted: false };
  const PRESETS = {
    all: { label: 'Tout afficher', name: 'Chat', f: { messages: true, ...allOn(true) }, msg: { ...MSG_DEFAULT } },
    chat: { label: 'Messages uniquement', name: 'Messages', f: { messages: true, ...allOn(false), announcement: true }, msg: { ...MSG_DEFAULT } },
    activity: { label: 'Activité (mentions, 1ers messages, événements)', name: 'Activité', f: { messages: true, ...allOn(true, ['notice', ...MOD_KEYS]) }, msg: { only: { mentions: true, first: true }, hideBots: true, hideCommands: true } },
    events: { label: 'Événements uniquement', name: 'Événements', f: { messages: false, ...allOn(true, ['notice', ...MOD_KEYS]) }, msg: { ...MSG_DEFAULT } },
    mod: { label: 'Modération', name: 'Modération', f: { messages: false, ...pick([...MOD_KEYS, 'notice']) }, msg: { ...MSG_DEFAULT } },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // conversion des colonnes de l'ancienne version
  function migrateCol(col) {
    if (col.f) { CAT_KEYS.forEach((k) => { if (col.f[k] === undefined) col.f[k] = true; }); col.msg = { ...MSG_DEFAULT, ...(col.msg || {}) }; return col; }
    const s = col.show || { chat: true, events: true, mod: true };
    const f = { messages: !!s.chat };
    CAT_KEYS.forEach((k) => { f[k] = MOD_KEYS.includes(k) || k === 'notice' ? !!s.mod : !!s.events; });
    if (s.chat && !s.events) { f.bits = true; f.announcement = true; }
    return { id: col.id, name: col.name, bg: col.bg || '', f, msg: { only: { mentions: !!col.only?.mentions, first: !!col.only?.first, mods: !!col.only?.mods }, hideBots: !!col.hideBots, hideCommands: !!col.hideCommands, hideDeleted: false } };
  }
  let columns = (local.columns || [{ id: 'c1', ...clone(PRESETS.all) }, { id: 'c2', ...clone(PRESETS.activity) }]).map(migrateCol);
  const saveCols = () => { local.columns = columns; saveLocal(); };

  function msgPasses(col, it) {
    const m = col.msg || {};
    if (m.hideBots && isBot(it)) return false;
    if (m.hideCommands && isCmd(it)) return false;
    if (m.hideDeleted && it.deleted) return false;
    const o = m.only || {};
    const flags = ['mentions', 'first', 'mods', 'subs'].filter((k) => o[k]);
    if (!flags.length) return true;
    return (o.mentions && it._mention) || (o.first && it.firstMsg) || (o.mods && (it.user?.mod || it.user?.vip)) || (o.subs && it.user?.sub);
  }
  function passes(col, it) {
    const f = col.f || {};
    const q = ($('#search').value || '').trim().toLowerCase();
    if (it.type === 'chat') {
      if (q && !(it.text || '').toLowerCase().includes(q) && !(it.user?.login || '').includes(q) && !(it.user?.name || '').toLowerCase().includes(q)) return false;
      if (it.bits > 0 && f.bits) return true;
      if (it.msgType === 'announcement' && f.announcement) return true;
      if (it.rewardId && f.reward) return true;
      return !!f.messages && msgPasses(col, it);
    }
    if (q) return false;
    if (it.type === 'event') return !!f[CAT_KEYS.includes(it.kind) ? it.kind : 'notice'];
    if (it.type === 'notice') return !!f[it.cat || 'notice'];
    return false;
  }

  function time(ts) { const d = new Date(ts); return GC.pad(d.getHours()) + ':' + GC.pad(d.getMinutes()); }

  function itemEl(it) {
    const el = document.createElement('div');
    if (it.type === 'chat') {
      const cls = ['msg'];
      if (it._mention) cls.push('hl');
      if (it.firstMsg) cls.push('first');
      if (it.bits) cls.push('bits');
      if (it.msgType === 'announcement') cls.push('announce');
      if (it.rewardId) cls.push('reward');
      if (it.isAction) cls.push('action');
      if (it.deleted) cls.push('deleted');
      if (it.self) cls.push('self');
      if (isBot(it)) cls.push('bot');
      if (S.highlight && S.highlight.id === it.id) cls.push('onscreen-now');
      el.className = cls.join(' ');
      el.dataset.id = it.id; el.dataset.login = it.user?.login || '';
      const color = GC.nameColor(it.user);
      el.innerHTML =
        (it.reply ? `<div class="reply">↪ en réponse à <b>@${esc(it.reply.name)}</b> : ${esc(it.reply.text)}</div>` : '') +
        `<span class="time">${time(it.ts)}</span>${GC.badgesHtml(it.user, S.badges)}` +
        `<span class="user" data-a="user" style="color:${esc(color)}">${esc(it.user?.name)}</span>${it.isAction ? ' ' : '<span class="sep">: </span>'}` +
        (it.bits ? `<b style="color:#f0a920">🔷 ${it.bits} bits </b>` : '') +
        `<span class="text" ${it.isAction ? `style="color:${esc(color)}"` : ''}>${GC.renderText(it.text, it.emotes, { emotes: S.emotes, linkify: true, mentionLogin: mentionLogin() })}</span>` +
        `<div class="acts">
          <button data-a="hl" title="Afficher sur le stream (OBS)">⭐</button>
          <button data-a="reply" title="Répondre">↩️</button>
          <button data-a="copy" title="Copier">📋</button>
          <button data-a="del" title="Supprimer le message">🗑️</button>
          <button data-a="to" title="Timeout 10 min">⏱️</button>
          <button data-a="ban" title="Bannir">🔨</button>
        </div>`;
    } else if (it.type === 'event') {
      const info = GC.eventInfo(it);
      el.className = 'event ' + it.kind;
      el.dataset.id = it.id;
      el.innerHTML = `<span class="time">${time(it.ts)}</span> ${info.icon} ${info.html}` +
        (it.text ? `<div class="ev-text">${GC.renderText(it.text, it.emotes, { emotes: S.emotes })}</div>` : '') +
        (it.user && it.kind !== 'ad' ? `<div class="acts"><button data-a="hl" title="Afficher sur le stream">⭐</button></div>` : '');
      el.style.position = 'relative';
    } else {
      el.className = 'notice';
      el.textContent = `${time(it.ts)} — ${it.text}`;
    }
    return el;
  }

  function renderColumns() {
    const wrap = $('#columns');
    wrap.innerHTML = '';
    columns.forEach((col) => {
      const c = document.createElement('div');
      c.className = 'col'; c.dataset.col = col.id;
      c.innerHTML = `<div class="col-head">
          <input class="name" value="${esc(col.name)}" title="Renommer">
          <button class="x" data-c="cfg" title="Filtres">⚙️</button>
          <button class="x" data-c="clear" title="Vider l'affichage">🧹</button>
          ${columns.length > 1 ? '<button class="x" data-c="del" title="Supprimer la colonne">✕</button>' : ''}
        </div>
        <div class="fpanel" hidden>${filterPanelHtml(col)}</div>
        <div class="feed"></div>
        <button class="btn small more" hidden>↓ nouveaux messages</button>`;
      wrap.appendChild(c);
      const feed = $('.feed', c);
      applyBg(c, col);
      const frag = document.createDocumentFragment();
      S.items.filter((it) => passes(col, it)).slice(-300).forEach((it) => frag.appendChild(itemEl(it)));
      feed.appendChild(frag);
      feed.scrollTop = feed.scrollHeight;
      feed.addEventListener('scroll', () => { if (atBottom(feed)) { $('.more', c).hidden = true; } });
      $('.more', c).addEventListener('click', () => { feed.scrollTop = feed.scrollHeight; $('.more', c).hidden = true; });
      $('.name', c).addEventListener('change', (e) => { col.name = e.target.value; saveCols(); });
      $('[data-c=cfg]', c).addEventListener('click', () => { const p = $('.fpanel', c); p.hidden = !p.hidden; });
      $('[data-c=clear]', c).addEventListener('click', () => { feed.innerHTML = ''; });
      $('[data-c=del]', c)?.addEventListener('click', () => { columns = columns.filter((x) => x !== col); saveCols(); renderColumns(); });
      bindFilterPanel(c, col);
    });
  }

  /* ---------------- Panneau de filtres d'une colonne ---------------- */
  const BG_COLORS = ['', '#c0392b', '#27ae60', '#2e5bff', '#9b27b0', '#a3a31a', '#1aa3a3'];
  const sw = (key, on) => `<label class="sw" title="Afficher / masquer"><input type="checkbox" data-f="${key}" ${on ? 'checked' : ''}><span></span></label>`;
  const subChk = (key, label, on) => `<label class="check sub"><input type="checkbox" data-m="${key}" ${on ? 'checked' : ''}> ${label}</label>`;
  function filterPanelHtml(col) {
    const f = col.f; const m = col.msg || {}; const o = m.only || {};
    const all = f.messages && CAT_KEYS.every((k) => f[k]);
    return `<div class="fp-head">
        <div class="fp-title"><b>Filtres</b><button class="x" data-fp="close" title="Fermer">✕</button></div>
        <div class="muted">Choisis ce qui s'affiche dans la colonne « ${esc(col.name)} »</div>
        <div class="row fp-tools">
          <select data-fp="preset"><option value="">⚡ Préréglages…</option>${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
          <span class="fp-all">Tout ${sw('__all', all)}</span>
        </div>
      </div>
      <div class="fp-list">
        <div class="fp-row msgrow ${f.messages ? 'on' : ''}">
          <button class="eye" data-eye="messages" title="Aperçu">👁</button><span class="ico">💬</span><span class="lbl">Messages du chat</span>${sw('messages', f.messages)}
        </div>
        <div class="fp-sub" ${f.messages ? '' : 'hidden'}>
          <div class="muted">Seulement… <span>(aucune case = tous les messages)</span></div>
          ${subChk('only.mentions', 'Mentions et mots surlignés', o.mentions)}${subChk('only.first', 'Premiers messages', o.first)}
          ${subChk('only.mods', 'Modos et VIP', o.mods)}${subChk('only.subs', 'Abonnés', o.subs)}
          <div class="muted">Masquer…</div>
          ${subChk('hideBots', 'Bots (liste dans Réglages)', m.hideBots)}${subChk('hideCommands', 'Commandes (!xxx)', m.hideCommands)}${subChk('hideDeleted', 'Messages supprimés', m.hideDeleted)}
        </div>
        <div class="fp-prev" data-prev="messages" hidden></div>
        ${CATS.map((c) => (c.group ? `<div class="fp-group">${esc(c.group)}</div>` : `
          <div class="fp-row ${f[c.k] ? 'on' : ''}"><button class="eye" data-eye="${c.k}" title="Aperçu">👁</button><span class="ico">${c.icon}</span><span class="lbl">${esc(c.label)}</span>${sw(c.k, f[c.k])}</div>
          <div class="fp-prev" data-prev="${c.k}" hidden></div>`)).join('')}
      </div>
      <div class="fp-foot">
        <span>🎨 Couleur de fond</span>
        <div class="swatches">${BG_COLORS.map((b) => `<button class="swatch ${b ? '' : 'none'} ${(col.bg || '') === b ? 'sel' : ''}" data-bg="${b}" style="${b ? 'background:' + b : ''}" title="${b || 'Aucune'}"></button>`).join('')}
          <label class="swatch pick ${col.bg && !BG_COLORS.includes(col.bg) ? 'sel' : ''}" title="Autre couleur" style="${col.bg && !BG_COLORS.includes(col.bg) ? 'background:' + col.bg : ''}">🖌️<input type="color" data-bg-custom value="${col.bg || '#2ee59d'}"></label>
        </div>
      </div>`;
  }
  function applyBg(c, col) {
    $('.feed', c).style.background = col.bg ? `color-mix(in srgb, ${col.bg} 14%, transparent)` : '';
    $('.col-head', c).style.boxShadow = col.bg ? `inset 0 -2px 0 ${col.bg}` : '';
  }
  function bindFilterPanel(c, col) {
    const p = $('.fpanel', c);
    const rerender = () => { p.innerHTML = filterPanelHtml(col); saveCols(); refreshColumn(c, col); applyBg(c, col); };
    p.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.f === '__all') { col.f.messages = t.checked; CAT_KEYS.forEach((k) => { col.f[k] = t.checked; }); return rerender(); }
      if (t.dataset.f) { col.f[t.dataset.f] = t.checked; return rerender(); }
      if (t.dataset.m) {
        const [a, b] = t.dataset.m.split('.');
        col.msg = col.msg || clone(MSG_DEFAULT);
        if (b) { col.msg[a] = col.msg[a] || {}; col.msg[a][b] = t.checked; } else col.msg[a] = t.checked;
        saveCols(); return refreshColumn(c, col);
      }
      if (t.dataset.fp === 'preset' && t.value) {
        const pr = clone(PRESETS[t.value]); col.f = pr.f; col.msg = pr.msg;
        toast(`Préréglage « ${pr.label} » appliqué`); return rerender();
      }
      if (t.matches('[data-bg-custom]')) { col.bg = t.value; return rerender(); }
    });
    p.addEventListener('click', (e) => {
      if (e.target.closest('[data-fp=close]')) { p.hidden = true; return; }
      const bg = e.target.closest('[data-bg]'); if (bg) { col.bg = bg.dataset.bg; return rerender(); }
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        const box = $(`[data-prev="${eye.dataset.eye}"]`, p);
        if (!box.hidden) { box.hidden = true; eye.classList.remove('on'); return; }
        box.innerHTML = ''; box.appendChild(itemEl(sampleItem(eye.dataset.eye)));
        box.hidden = false; eye.classList.add('on');
      }
    });
  }
  /* Exemples affichés par le bouton 👁 */
  function sampleItem(k) {
    const user = { id: 'demo-x', login: 'viewer_test', name: 'Viewer_Test', color: '#54a0ff', badges: [], sub: true };
    const base = { id: 'sample-' + k, ts: Date.now(), user, demo: true };
    const ev = (o) => ({ ...base, type: 'event', ...o });
    const S2 = {
      messages: { ...base, type: 'chat', text: 'Salut tout le monde ! Bon live 💚', emotes: '' },
      bits: { ...base, type: 'chat', text: 'Cheer100 Allez allez !', emotes: '', bits: 100 },
      announcement: { ...base, type: 'chat', text: 'Le concours commence dans 5 minutes !', emotes: '', msgType: 'announcement' },
      follow: ev({ kind: 'follow' }), sub: ev({ kind: 'sub', months: 6, tier: 'Tier 1', resub: true, text: 'Six mois déjà !' }),
      subgift: ev({ kind: 'subgift', count: 5, tier: 'Tier 1', community: true }), raid: ev({ kind: 'raid', viewers: 42 }),
      reward: ev({ kind: 'reward', reward: { title: 'Hydrate-toi !', cost: 300 } }), watchstreak: ev({ kind: 'watchstreak', value: 10 }),
      charity: ev({ kind: 'charity', amount: '10,00 €', charity: 'Les Restos du Cœur' }),
      poll: ev({ kind: 'poll', phase: 'end', title: 'Quel jeu ensuite ?', choices: [{ title: 'Elden Ring', votes: 34 }, { title: 'Phasmophobia', votes: 21 }], user: null }),
      prediction: ev({ kind: 'prediction', phase: 'end', title: 'Je bats le boss ?', winner: 'Oui', user: null }),
      hypetrain: ev({ kind: 'hypetrain', phase: 'end', level: 3, user: null }),
      goal: ev({ kind: 'goal', phase: 'achieved', description: '100 followers', current: 100, target: 100, user: null }),
      shoutout: ev({ kind: 'shoutout', phase: 'out', viewers: 57 }), unban: ev({ kind: 'unban', by: 'ModoZen' }),
      unbanrequest: ev({ kind: 'unbanrequest', text: 'Désolé pour hier, je ne recommencerai pas' }),
      warn: ev({ kind: 'warn', by: 'ModoZen', reason: 'Pas de spoil' }), shield: ev({ kind: 'shield', phase: 'on', by: 'ModoZen', user: null }),
      stream: ev({ kind: 'stream', phase: 'online', user: null }), ad: ev({ kind: 'ad', duration: 90, manual: true, user: null }),
      ban: { ...base, type: 'notice', text: 'viewer_test a été exclu 10 min', cat: 'ban' },
      clear: { ...base, type: 'notice', text: 'Le chat a été vidé par un modérateur', cat: 'clear' },
      notice: { ...base, type: 'notice', text: 'Ce salon est maintenant en mode lent (30 s).' },
    };
    return S2[k] || S2.notice;
  }
  function refreshColumn(c, col) {
    const feed = $('.feed', c); feed.innerHTML = '';
    S.items.filter((it) => passes(col, it)).slice(-300).forEach((it) => feed.appendChild(itemEl(it)));
    feed.scrollTop = feed.scrollHeight;
  }
  const atBottom = (f) => f.scrollHeight - f.scrollTop - f.clientHeight < 60;

  function appendToColumns(it) {
    columns.forEach((col) => {
      if (!passes(col, it)) return;
      const c = $(`.col[data-col="${col.id}"]`); if (!c) return;
      const feed = $('.feed', c);
      const stick = atBottom(feed);
      feed.appendChild(itemEl(it));
      while (feed.children.length > 400) feed.firstChild.remove();
      if (stick) feed.scrollTop = feed.scrollHeight; else $('.more', c).hidden = false;
    });
  }

  $('#addCol').addEventListener('click', () => {
    const n = columns.length;
    columns.push({ id: 'c' + Date.now(), bg: '', ...clone(n === 1 ? PRESETS.activity : PRESETS.events) });
    saveCols(); renderColumns();
  });
  let searchT; $('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(renderColumns, 200); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.fpanel').forEach((p) => { p.hidden = true; }); });

  /* Actions sur les messages */
  $('#columns').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-a]'); if (!btn) return;
    const el = btn.closest('[data-id]'); const it = el && S.byId.get(el.dataset.id); if (!it) return;
    const a = btn.dataset.a;
    if (a === 'user') return openUser(it.user);
    if (a === 'hl') return run(api('POST', '/api/highlight', { message: it }), 'Affiché sur le stream');
    if (a === 'reply') { S.replyTo = it; $('#replying').hidden = false; $('#replyingText').textContent = 'Réponse à ' + it.user.name + ' : ' + it.text.slice(0, 80); $('#msgInput').focus(); return; }
    if (a === 'copy') return copyText(it.text).then(() => toast('Copié'), () => toast('Copie impossible', true));
    if (a === 'del') return run(api('POST', '/api/mod/delete', { messageId: it.id }));
    if (a === 'to') return run(api('POST', '/api/mod/ban', { userId: it.user.id, duration: 600 }), it.user.name + ' exclu 10 min');
    if (a === 'ban') { if (confirmInline(btn)) run(api('POST', '/api/mod/ban', { userId: it.user.id }), it.user.name + ' banni'); }
  });
  /* Confirmation en deux clics (évite les boîtes de dialogue bloquantes) */
  function confirmInline(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = '❓';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 2500);
    toast('Clique encore pour confirmer');
    return false;
  }

  function renderOnscreen() {
    const h = S.highlight;
    $('#onscreen').hidden = !h;
    if (h) $('#onscreenText').innerHTML = `<b>${esc(h.user?.name || '')}</b> ${h.type === 'event' ? GC.eventInfo(h).html : esc(h.text || '')}`;
    $$('.msg.onscreen-now').forEach((el) => el.classList.remove('onscreen-now'));
    if (h) $$(`.msg[data-id="${CSS.escape(h.id)}"]`).forEach((el) => el.classList.add('onscreen-now'));
  }
  $('#onscreenOff').addEventListener('click', () => run(api('DELETE', '/api/highlight')));

  /* ---------------- Fiche utilisateur ---------------- */
  let ucUser = null;
  async function openUser(user) {
    ucUser = user;
    $('#ucName').textContent = user.name; $('#ucName').style.color = GC.nameColor(user);
    $('#ucAvatar').src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; $('#ucInfo').textContent = '';
    $('#ucProfile').href = 'https://twitch.tv/' + encodeURIComponent(user.login);
    const msgs = S.items.filter((x) => x.type === 'chat' && x.user?.login === user.login);
    $('#ucMsgs').innerHTML = ''; msgs.slice(-100).forEach((m) => $('#ucMsgs').appendChild(itemEl(m)));
    $('#ucMsgs').scrollTop = 1e9;
    $('#userModal').hidden = false;
    if (S.status.login && user.id && !String(user.id).startsWith('demo')) {
      try {
        const d = await api('GET', '/api/user/' + user.id);
        if (ucUser !== user) return;
        if (d.user) $('#ucAvatar').src = d.user.profile_image_url;
        const created = d.user ? 'Compte créé le ' + new Date(d.user.created_at).toLocaleDateString('fr-FR') : '';
        const fol = d.followedAt ? ' · Follow depuis le ' + new Date(d.followedAt).toLocaleDateString('fr-FR') : ' · Ne follow pas';
        $('#ucInfo').textContent = created + fol + ' · ' + msgs.length + ' message(s) cette session';
      } catch (e) { $('#ucInfo').textContent = msgs.length + ' message(s) cette session'; }
    } else $('#ucInfo').textContent = msgs.length + ' message(s) cette session';
  }
  $$('#ucActions [data-to]').forEach((b) => b.addEventListener('click', () => run(api('POST', '/api/mod/ban', { userId: ucUser.id, duration: Number(b.dataset.to) }), ucUser.name + ' exclu ' + fmtDur(Number(b.dataset.to)))));
  $('#ucBan').addEventListener('click', (e) => { if (confirmInline(e.currentTarget)) run(api('POST', '/api/mod/ban', { userId: ucUser.id }), ucUser.name + ' banni'); });
  $('#ucUnban').addEventListener('click', () => run(api('POST', '/api/mod/unban', { userId: ucUser.id }), ucUser.name + ' débanni'));
  $('#ucSo').addEventListener('click', () => run(api('POST', '/api/mod/shoutout', { userId: ucUser.id }), 'Shoutout envoyé'));
  $('#ucMsgs').addEventListener('click', (e) => { const b = e.target.closest('[data-a=hl]'); const el = e.target.closest('[data-id]'); if (b && el) run(api('POST', '/api/highlight', { message: S.byId.get(el.dataset.id) }), 'Affiché sur le stream'); });
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.modal-close')) m.hidden = true; });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach((m) => { m.hidden = true; }); });

  /* ---------------- Envoi de messages ---------------- */
  const history = []; let hIdx = -1;
  async function send() {
    const inp = $('#msgInput'); const text = inp.value.trim(); if (!text) return;
    try {
      await api('POST', '/api/chat/send', { text, replyTo: S.replyTo?.id || null });
      history.unshift(text); hIdx = -1; inp.value = ''; cancelReply();
    } catch (e) { toast(e.message, true); }
  }
  function cancelReply() { S.replyTo = null; $('#replying').hidden = true; }
  $('#sendBtn').addEventListener('click', send);
  $('#replyCancel').addEventListener('click', cancelReply);
  $('#msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'ArrowUp' && history.length) { hIdx = Math.min(hIdx + 1, history.length - 1); e.target.value = history[hIdx]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hIdx = Math.max(hIdx - 1, -1); e.target.value = hIdx < 0 ? '' : history[hIdx]; }
    else if (e.key === 'Tab') { // complétion des pseudos
      e.preventDefault();
      const v = e.target.value; const m = v.match(/(@?)(\w+)$/); if (!m) return;
      const names = [...new Set(S.items.filter((x) => x.type === 'chat').map((x) => x.user.name))].reverse();
      const found = names.find((n) => n.toLowerCase().startsWith(m[2].toLowerCase()));
      if (found) e.target.value = v.slice(0, v.length - m[0].length) + '@' + found + ' ';
    }
  });

  /* ---------------- Stream ---------------- */
  let selectedGame = null;
  async function loadStream() {
    if (!S.status.login) { $('#streamMsg').textContent = 'Connecte ton compte Twitch dans Réglages pour modifier le titre et la catégorie.'; return; }
    try {
      const d = await api('GET', '/api/stream');
      if (d.channel) { $('#streamTitle').value = d.channel.title; $('#catInput').value = d.channel.game_name; selectedGame = { id: d.channel.game_id, name: d.channel.game_name }; $('#streamTags').value = (d.channel.tags || []).join(', '); }
      loadAdmin();
      $('#livePill').textContent = d.live ? 'EN LIVE' : 'Hors ligne';
      $('#livePill').className = 'pill' + (d.live ? ' live' : '');
      $('#liveStats').innerHTML = d.live
        ? `<div class="stat"><b>${d.live.viewer_count}</b>viewers</div><div class="stat"><b>${GC.countdown(Date.now() - new Date(d.live.started_at))}</b>de live</div>`
        : '';
      $('#streamMsg').textContent = '';
    } catch (e) { $('#streamMsg').textContent = e.message; }
  }
  let catT;
  $('#catInput').addEventListener('input', (e) => {
    clearTimeout(catT);
    const q = e.target.value.trim();
    if (!q) { $('#catList').innerHTML = ''; return; }
    catT = setTimeout(async () => {
      try {
        const list = await api('GET', '/api/categories?q=' + encodeURIComponent(q));
        $('#catList').innerHTML = list.map((g) => `<div class="ac-item" data-id="${esc(g.id)}" data-name="${esc(g.name)}"><img src="${esc(g.box_art_url.replace('{width}', '60').replace('{height}', '80'))}" alt="">${esc(g.name)}</div>`).join('');
      } catch (err) { toast(err.message, true); }
    }, 300);
  });
  $('#catList').addEventListener('click', (e) => {
    const it = e.target.closest('.ac-item'); if (!it) return;
    selectedGame = { id: it.dataset.id, name: it.dataset.name }; $('#catInput').value = it.dataset.name; $('#catList').innerHTML = '';
  });
  // Sélecteur « Depuis le planning » : remplit titre + catégorie avec un créneau du planning
  function renderPlanPick() {
    const p = S.planning || {}; const sel = $('#planPick'); const cur = sel.value;
    const label = (s) => [s.title, s.game && '🎮 ' + s.game, s.guest && '🤝 ' + s.guest].filter(Boolean).join(' · ') || '(sans titre)';
    const opt = (s, prefix) => `<option value="${esc(s.id)}">${esc(prefix)} — ${esc(label(s))}</option>`;
    // avant 6h on est encore sur le live de la veille (créneaux 20h30 → 1h)
    const now = new Date(); const ref = new Date(now); if (now.getHours() < 6) ref.setDate(ref.getDate() - 1);
    const tonight = GC.streamsForDate(p, ref).items;
    const todayIso = GC.isoDate(ref);
    const specials = (p.specials || []).filter((s) => !s.cancelled && s.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date));
    const slots = [...(p.slots || [])].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
    const fd = (iso) => new Date(iso + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    sel.innerHTML = '<option value="">— Choisir un créneau —</option>'
      + (tonight.length ? `<optgroup label="Ce soir">${tonight.map((s) => opt(s, GC.fmtTime(s.start))).join('')}</optgroup>` : '')
      + (specials.length ? `<optgroup label="Événements à venir">${specials.map((s) => opt(s, fd(s.date))).join('')}</optgroup>` : '')
      + (slots.length ? `<optgroup label="Semaine type">${slots.map((s) => opt(s, GC.DAYS[s.day - 1] + ' ' + GC.fmtTime(s.start))).join('')}</optgroup>` : '');
    sel.value = cur;
  }
  $('#planPick').addEventListener('change', async (e) => {
    const id = e.target.value; if (!id) return;
    const p = S.planning || {};
    const s = [...(p.slots || []), ...(p.specials || [])].find((x) => x.id === id); if (!s) return;
    if (s.title) $('#streamTitle').value = s.title;
    if (!s.game) return toast('Titre repris du planning — clique sur « Mettre à jour »');
    try {
      const list = await api('GET', '/api/categories?q=' + encodeURIComponent(s.game));
      const g = list.find((x) => x.name.toLowerCase() === s.game.toLowerCase()) || list[0];
      if (!g) throw new Error(`Catégorie « ${s.game} » introuvable sur Twitch — choisis-la à la main`);
      selectedGame = { id: g.id, name: g.name }; $('#catInput').value = g.name; $('#catList').innerHTML = '';
      toast('Titre et catégorie repris du planning — clique sur « Mettre à jour »');
    } catch (err) { toast(err.message, true); }
  });

  $('#streamSave').addEventListener('click', () => {
    const tags = $('#streamTags').value.split(',').map((t) => t.trim().replace(/\s+/g, '')).filter(Boolean);
    if (tags.length > 10) return toast('10 tags maximum', true);
    run(api('PATCH', '/api/stream', { title: $('#streamTitle').value, gameId: selectedGame?.id, tags }), 'Infos du stream mises à jour');
  });
  $('#streamReload').addEventListener('click', loadStream);
  $('#soBtn').addEventListener('click', () => { const v = $('#soInput').value.trim(); if (v) run(api('POST', '/api/admin/shoutout', { login: v }), 'Shoutout envoyé'); });
  $('#annBtn').addEventListener('click', () => { const v = $('#annInput').value.trim(); if (v) run(api('POST', '/api/admin/announce', { message: v, color: $('#annColor').value }), 'Annonce envoyée').then(() => { $('#annInput').value = ''; }); });
  $('#markerBtn').addEventListener('click', () => run(api('POST', '/api/admin/marker', { description: $('#markerInput').value.trim() }), 'Marqueur ajouté').then(() => { $('#markerInput').value = ''; }).catch(() => {}));
  $('#clipBtn').addEventListener('click', () => run(api('POST', '/api/admin/clip')).then((c) => {
    toast('Clip créé !');
    $('#clipMsg').innerHTML = c?.edit_url ? `<a href="${esc(c.edit_url)}" target="_blank" rel="noopener">Modifier le clip ↗</a>` : '';
  }).catch(() => {}));

  /* ---------------- Commandes admin ---------------- */
  let adminState = null; let adminTimer = null;
  const A = (method, url, body, okMsg) => run(api(method, url, body), okMsg).then((r) => { setTimeout(loadAdmin, 800); return r; });
  const modUser = () => { const v = $('#modUser').value.trim().replace(/^@/, ''); if (!v) { toast('Indique un pseudo', true); throw new Error('pseudo'); } return v; };

  function renderScopeWarn() {
    const st = S.status; const box = $('#scopeWarn');
    const missing = st.login ? (st.requiredScopes || []).filter((s) => !(st.scopes || []).includes(s)) : [];
    if (!st.login) { box.hidden = false; box.innerHTML = '⚠️ Connecte ton compte Twitch (onglet Réglages) pour utiliser les commandes admin.'; return; }
    if (!missing.length) { box.hidden = true; return; }
    if (box.dataset.pending) return;
    box.hidden = false;
    box.innerHTML = `<span>⚠️ Certaines commandes demandent de nouvelles autorisations Twitch (${missing.length}). Reconnecte ton compte <b>${esc(st.login)}</b> une fois :</span><button class="btn" id="rescopeBtn">Mettre à jour les autorisations</button>`;
    $('#rescopeBtn').onclick = async () => {
      try {
        const a = await api('POST', '/api/auth/start');
        box.dataset.pending = '1';
        box.innerHTML = `<span>Ouvre twitch.tv/activate et saisis :</span><div class="authcode">${esc(a.userCode)}</div><a class="btn" href="${esc(a.verificationUri)}" target="_blank" rel="noopener">Ouvrir ↗</a><span class="muted">En attente de validation…</span>`;
        window.open(a.verificationUri, '_blank', 'noopener');
        setTimeout(() => { delete box.dataset.pending; renderScopeWarn(); }, a.expiresIn * 1000);
      } catch (e) { toast(e.message, true); }
    };
  }
  onAuthHooks.push(() => { delete $('#scopeWarn').dataset.pending; renderScopeWarn(); loadAdmin(); });

  async function loadAdmin() {
    if (!S.status.login) return;
    try {
      adminState = await api('GET', '/api/admin/state');
      $('#adminMsg').textContent = adminState.isOwner ? '' : '— connecté en modo : raid, pubs, sondages, prédictions et rôles sont réservés au streamer';
      renderAdmin();
    } catch (e) { $('#adminMsg').textContent = e.message; }
  }
  function renderAdmin() {
    const s = adminState || {}; const c = s.chat || {};
    $$('[data-mode]').forEach((cb) => { cb.checked = !!c[cb.dataset.mode]; cb.closest('.mode').classList.toggle('on', cb.checked); });
    if (c.slow_mode && c.slow_mode_wait_time) $('#slowWait').value = String(c.slow_mode_wait_time);
    if (c.follower_mode && c.follower_mode_duration != null && $(`#followDur option[value="${c.follower_mode_duration}"]`)) $('#followDur').value = String(c.follower_mode_duration);
    if (c.non_moderator_chat_delay && c.non_moderator_chat_delay_duration) $('#chatDelay').value = String(c.non_moderator_chat_delay_duration);
    const shieldOn = !!s.shield?.is_active;
    $('#shieldBtn').classList.toggle('active', shieldOn);
    $('#shieldBtn').textContent = shieldOn ? '🛡️ Bouclier ACTIF — désactiver' : '🛡️ Activer le mode bouclier';
    // rôles
    $('#roleLists').innerHTML = s.isOwner
      ? `<p><b>Modos (${(s.mods || []).length}) :</b> ${esc((s.mods || []).join(', ') || 'aucun')}</p><p><b>VIP (${(s.vips || []).length}) :</b> ${esc((s.vips || []).join(', ') || 'aucun')}</p>`
      : 'Visible uniquement avec le compte du streamer.';
    // pubs
    const ads = s.ads;
    const t = (v) => (v ? new Date(/^\d+$/.test(String(v)) ? Number(v) * 1000 : v) : null);
    const next = t(ads?.next_ad_at);
    $('#adInfo').innerHTML = ads ? [
      next && next > new Date() ? `<div class="stat"><b>${next.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</b>prochaine pub</div>` : '',
      `<div class="stat"><b>${ads.snooze_count ?? 0}</b>reports dispo</div>`,
      ads.preroll_free_time ? `<div class="stat"><b>${Math.round(ads.preroll_free_time / 60)} min</b>sans pré-roll</div>` : '',
    ].join('') : (s.errors?.ads ? `<p class="muted">${esc(s.errors.ads)}</p>` : '');
    renderPoll(s.poll); renderPrediction(s.prediction);
    // pseudos récents pour l'autocomplétion
    const names = [...new Set(S.items.filter((x) => x.type === 'chat' && x.user?.login).map((x) => x.user.login))].slice(-200).reverse();
    $('#chattersList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  }
  const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);
  const remaining = (startedAt, secs) => Math.max(0, Math.round((new Date(startedAt).getTime() + secs * 1000 - Date.now()) / 1000));
  const fmtSec = (s) => (s >= 60 ? Math.floor(s / 60) + ' min ' + GC.pad(s % 60) : s + ' s');

  function renderPoll(p) {
    const active = p && p.status === 'ACTIVE';
    const recent = p && ['COMPLETED', 'TERMINATED'].includes(p.status) && Date.now() - new Date(p.ended_at || p.started_at).getTime() < 10 * 60000;
    $('#pollForm').hidden = !!active;
    if (!active && !recent) { $('#pollActive').innerHTML = s_err('poll'); return; }
    const total = p.choices.reduce((n, c) => n + (c.votes || 0), 0);
    const max = Math.max(...p.choices.map((c) => c.votes || 0));
    $('#pollActive').innerHTML = `<p><b>${esc(p.title)}</b> <span class="muted">${active ? '— reste ' + fmtSec(remaining(p.started_at, p.duration)) : '— terminé'} · ${total} vote${total > 1 ? 's' : ''}</span></p>
      <div class="bars">${p.choices.map((c) => `<div class="barrow${!active && c.votes === max && max > 0 ? ' win' : ''}"><div class="fill" style="width:${pct(c.votes, total)}%"></div><span>${esc(c.title)}</span><span>${c.votes || 0} · ${pct(c.votes, total)}%</span></div>`).join('')}</div>
      ${active ? `<div class="row wrap"><button class="btn ghost" data-poll="end">⏹️ Terminer et afficher le résultat</button><button class="btn ghost" data-poll="archive">Terminer sans afficher</button></div>` : ''}`;
  }
  function renderPrediction(p) {
    const open = p && ['ACTIVE', 'LOCKED'].includes(p.status);
    const recent = p && ['RESOLVED', 'CANCELED'].includes(p.status) && Date.now() - new Date(p.ended_at || p.created_at).getTime() < 10 * 60000;
    $('#predForm').hidden = !!open;
    if (!open && !recent) { $('#predActive').innerHTML = s_err('prediction'); return; }
    const total = p.outcomes.reduce((n, o) => n + (o.channel_points || 0), 0);
    const state = p.status === 'ACTIVE' ? '— paris ouverts, reste ' + fmtSec(remaining(p.created_at, p.prediction_window))
      : p.status === 'LOCKED' ? '— paris fermés, choisis le résultat' : p.status === 'CANCELED' ? '— annulée (points remboursés)' : '— terminée';
    $('#predActive').innerHTML = `<p><b>${esc(p.title)}</b> <span class="muted">${state}</span></p>
      <div class="bars">${p.outcomes.map((o) => `<div class="barrow${p.winning_outcome_id === o.id ? ' win' : ''}"><div class="fill" style="width:${pct(o.channel_points, total)}%"></div><span>${p.winning_outcome_id === o.id ? '🏆 ' : ''}${esc(o.title)}</span><span>${(o.channel_points || 0).toLocaleString('fr-FR')} pts · ${o.users || 0} 👤</span>
        ${open ? `<button class="btn small" style="position:relative;z-index:1" data-pred="win" data-oid="${esc(o.id)}" data-otitle="${esc(o.title)}">Gagnant</button>` : ''}</div>`).join('')}</div>
      ${open ? `<div class="row wrap">${p.status === 'ACTIVE' ? '<button class="btn ghost" data-pred="lock">🔒 Fermer les paris</button>' : ''}<button class="btn ghost" data-pred="cancel">Annuler et rembourser</button></div>` : ''}`;
  }
  const s_err = (k) => (adminState?.errors?.[k] ? `<p class="muted">${esc(adminState.errors[k])}</p>` : '');

  // champs de choix des sondages / prédictions
  $('#pollChoices').innerHTML = [1, 2, 3, 4, 5].map((i) => `<input data-choice placeholder="Choix ${i}${i > 2 ? ' (facultatif)' : ''}" maxlength="25">`).join('');
  $('#predOutcomes').innerHTML = [1, 2, 3, 4].map((i) => `<input data-outcome placeholder="${['Oui', 'Non', 'Issue 3 (facultatif)', 'Issue 4 (facultatif)'][i - 1]}" maxlength="25">`).join('');

  // modes du chat
  $$('[data-mode]').forEach((cb) => cb.addEventListener('change', () => {
    const k = cb.dataset.mode; const body = { [k]: cb.checked };
    if (k === 'slow_mode' && cb.checked) body.slow_mode_wait_time = Number($('#slowWait').value);
    if (k === 'follower_mode' && cb.checked) body.follower_mode_duration = Number($('#followDur').value);
    if (k === 'non_moderator_chat_delay' && cb.checked) body.non_moderator_chat_delay_duration = Number($('#chatDelay').value);
    A('PATCH', '/api/admin/chat-settings', body, 'Mode du chat mis à jour').catch(() => { cb.checked = !cb.checked; });
  }));
  [['#slowWait', 'slow_mode', 'slow_mode_wait_time'], ['#followDur', 'follower_mode', 'follower_mode_duration'], ['#chatDelay', 'non_moderator_chat_delay', 'non_moderator_chat_delay_duration']]
    .forEach(([sel, mode, key]) => $(sel).addEventListener('change', (e) => {
      if ($(`[data-mode=${mode}]`).checked) A('PATCH', '/api/admin/chat-settings', { [mode]: true, [key]: Number(e.target.value) }, 'Mode du chat mis à jour').catch(() => {});
    }));
  $('#shieldBtn').addEventListener('click', () => {
    const on = !adminState?.shield?.is_active;
    A('POST', '/api/admin/shield', { active: on }, on ? 'Mode bouclier activé' : 'Mode bouclier désactivé').catch(() => {});
  });
  $('#clearBtn').addEventListener('click', () => { if (confirm('Vider tout le chat pour tout le monde ?')) A('POST', '/api/admin/clear', null, 'Chat vidé').catch(() => {}); });

  // modération
  $$('[data-mod]').forEach((b) => b.addEventListener('click', () => {
    let login; try { login = modUser(); } catch { return; }
    const reason = $('#modReason').value.trim(); const k = b.dataset.mod;
    if (k === 'timeout') return A('POST', '/api/admin/ban', { login, duration: Number($('#toDur').value), reason }, `${login} exclu ${$('#toDur').selectedOptions[0].text}`).catch(() => {});
    if (k === 'ban') { if (confirm(`Bannir définitivement ${login} ?`)) A('POST', '/api/admin/ban', { login, reason }, `${login} banni`).catch(() => {}); return; }
    if (k === 'unban') return A('POST', '/api/admin/unban', { login }, `${login} débanni`).catch(() => {});
    if (k === 'warn') return A('POST', '/api/admin/warn', { login, reason }, `${login} averti`).catch(() => {});
  }));
  $$('[data-role]').forEach((b) => b.addEventListener('click', () => {
    let login; try { login = modUser(); } catch { return; }
    const k = b.dataset.role;
    const label = { mod: 'nommé modo', unmod: "n'est plus modo", vip: 'est VIP', unvip: "n'est plus VIP" }[k];
    if (k === 'unmod' && !confirm(`Retirer le rôle de modo à ${login} ?`)) return;
    A('POST', '/api/admin/role', { action: k, login }).then((r) => toast(`${r.name || login} ${label}`)).catch(() => {});
  }));

  // raid & pubs
  $('#raidBtn').addEventListener('click', () => {
    const v = $('#raidInput').value.trim().replace(/^@/, ''); if (!v) return toast('Indique la chaîne à raider', true);
    if (confirm(`Lancer un raid vers ${v} ?`)) A('POST', '/api/admin/raid', { login: v }).then((r) => toast(`Raid vers ${r.name} en préparation — confirme dans Twitch ou attends 90 s`)).catch(() => {});
  });
  $('#unraidBtn').addEventListener('click', () => A('DELETE', '/api/admin/raid', null, 'Raid annulé').catch(() => {}));
  $$('[data-ad]').forEach((b) => b.addEventListener('click', () => {
    if (confirm(`Lancer une pub de ${b.textContent} maintenant ?`)) A('POST', '/api/admin/commercial', { length: Number(b.dataset.ad) }, `Pub de ${b.textContent} lancée`).catch(() => {});
  }));
  $('#snoozeBtn').addEventListener('click', () => A('POST', '/api/admin/ads/snooze', null, 'Prochaine pub repoussée de 5 min').catch(() => {}));

  // sondages
  $('#pollStart').addEventListener('click', () => {
    const choices = $$('[data-choice]').map((i) => i.value.trim()).filter(Boolean);
    A('POST', '/api/admin/poll', { title: $('#pollTitle').value.trim(), choices, duration: Number($('#pollDur').value), pointsPerVote: Number($('#pollPoints').value) }, 'Sondage lancé')
      .then(() => { $('#pollTitle').value = ''; $$('[data-choice]').forEach((i) => { i.value = ''; }); }).catch(() => {});
  });
  $('#pollActive').addEventListener('click', (e) => {
    const b = e.target.closest('[data-poll]'); if (!b || !adminState?.poll) return;
    A('PATCH', '/api/admin/poll', { id: adminState.poll.id, archive: b.dataset.poll === 'archive' }, 'Sondage terminé').catch(() => {});
  });
  // prédictions
  $('#predStart').addEventListener('click', () => {
    const outcomes = $$('[data-outcome]').map((i) => i.value.trim() || '').filter(Boolean);
    const list = outcomes.length >= 2 ? outcomes : ['Oui', 'Non'].map((d, i) => outcomes[i] || d);
    A('POST', '/api/admin/prediction', { title: $('#predTitle').value.trim(), outcomes: list, window: Number($('#predWin').value) }, 'Prédiction lancée')
      .then(() => { $('#predTitle').value = ''; $$('[data-outcome]').forEach((i) => { i.value = ''; }); }).catch(() => {});
  });
  $('#predActive').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pred]'); const p = adminState?.prediction; if (!b || !p) return;
    const k = b.dataset.pred;
    if (k === 'lock') return A('PATCH', '/api/admin/prediction', { id: p.id, status: 'LOCKED' }, 'Paris fermés').catch(() => {});
    if (k === 'cancel') { if (confirm('Annuler la prédiction et rembourser tous les points ?')) A('PATCH', '/api/admin/prediction', { id: p.id, status: 'CANCELED' }, 'Prédiction annulée').catch(() => {}); return; }
    if (k === 'win' && confirm(`Valider « ${b.dataset.otitle} » comme résultat gagnant ?`)) A('PATCH', '/api/admin/prediction', { id: p.id, status: 'RESOLVED', winningOutcomeId: b.dataset.oid }, 'Prédiction terminée').catch(() => {});
  });

  // aide-mémoire : clic = copie dans la zone de message du chat
  $('.cmds').addEventListener('click', (e) => {
    const c = e.target.closest('code'); if (!c) return;
    const cmd = c.textContent.split(' ')[0] + ' ';
    $('#msgInput').value = cmd; toast(`« ${cmd.trim()} » mis dans la zone de message du chat`);
  });
  $('#adminReload').addEventListener('click', loadAdmin);
  // rafraîchissement auto quand l'onglet Stream est ouvert (résultats des sondages/prédictions)
  adminTimer = setInterval(() => { if ($('#tab-stream').classList.contains('active') && !document.hidden) loadAdmin(); }, 8000);

  /* ---------------- Planning ---------------- */
  let planDirty = false; let planT;
  const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
  function planChanged() {
    planDirty = true; $('#planSave').textContent = 'Enregistrer •';
    clearTimeout(planT); planT = setTimeout(savePlanning, 700);
    renderPlanning(true);
  }
  async function savePlanning() {
    clearTimeout(planT);
    try { await api('PUT', '/api/planning', S.planning); planDirty = false; $('#planSave').textContent = 'Enregistré ✓'; }
    catch (e) { toast(e.message, true); }
  }
  $('#planSave').addEventListener('click', savePlanning);
  [['#planTitle', 'title'], ['#planSubtitle', 'subtitle'], ['#planOff', 'offLabel'], ['#planAccent', 'accent']].forEach(([sel, key]) => {
    $(sel).addEventListener('input', (e) => { S.planning[key] = e.target.value; planChanged(); });
  });

  function slotHtml(s) {
    const color = s.color || S.planning.accent || 'var(--accent)';
    return `<div class="slot" data-slot="${esc(s.id)}" style="border-left-color:${esc(color)}">
      <b>${GC.fmtTime(s.start)} → ${GC.fmtTime(s.end)}</b>${esc(s.title || '')}${s.game ? `<div class="muted">🎮 ${esc(s.game)}</div>` : ''}${s.guest ? `<div class="muted">🤝 avec ${esc(s.guest)}</div>` : ''}</div>`;
  }
  function renderPlanning(skipHead) {
    const p = S.planning;
    if (!skipHead) {
      $('#planTitle').value = p.title || ''; $('#planSubtitle').value = p.subtitle || '';
      $('#planOff').value = p.offLabel || ''; $('#planAccent').value = p.accent || '#2ee59d';
    }
    const ws = GC.weekStart(); const we = new Date(ws); we.setDate(we.getDate() + 6);
    $('#planWeekLabel').textContent = `(cette semaine : ${ws.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} → ${we.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })})`;
    const today = GC.dayIndex(new Date());
    $('#week').innerHTML = GC.DAYS.map((name, i) => {
      const day = i + 1;
      const slots = (p.slots || []).filter((s) => Number(s.day) === day).sort((a, b) => a.start.localeCompare(b.start));
      return `<div class="day ${day === today ? 'today' : ''}"><h4>${name}${day === today ? '<span class="pill on">aujourd\'hui</span>' : ''}</h4>
        ${slots.length ? slots.map(slotHtml).join('') : `<div class="off">${esc(p.offLabel || 'Repos')}</div>`}
        <button class="btn small ghost add" data-addday="${day}">＋ Créneau</button></div>`;
    }).join('');
    const sp = [...(p.specials || [])].sort((a, b) => a.date.localeCompare(b.date));
    $('#specials').innerHTML = sp.length ? sp.map((s) => `<div class="special-row" data-special="${esc(s.id)}">
        <b>${new Date(s.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</b>
        ${s.cancelled ? '<span class="tag cancel">Annulé</span>' : `<span class="tag">${GC.fmtTime(s.start)} → ${GC.fmtTime(s.end)}</span>`}
        <span>${esc(s.title || '')}${s.game ? ' · 🎮 ' + esc(s.game) : ''}${s.guest ? ' · 🤝 ' + esc(s.guest) : ''}</span></div>`).join('')
      : '<p class="muted">Aucun événement ponctuel.</p>';
    renderPlanPick();
  }
  $('#week').addEventListener('click', (e) => {
    const add = e.target.closest('[data-addday]');
    if (add) return openSlot({ id: uid(), day: Number(add.dataset.addday), start: '20:30', end: '01:00', title: '', game: '', guest: '', color: '' }, 'slot', true);
    const s = e.target.closest('[data-slot]');
    if (s) openSlot(S.planning.slots.find((x) => x.id === s.dataset.slot), 'slot', false);
  });
  $('#specials').addEventListener('click', (e) => {
    const s = e.target.closest('[data-special]');
    if (s) openSlot(S.planning.specials.find((x) => x.id === s.dataset.special), 'special', false);
  });
  $('#addSpecial').addEventListener('click', () => openSlot({ id: uid(), date: GC.isoDate(new Date()), start: '20:30', end: '01:00', title: '', game: '', guest: '', color: '', cancelled: false }, 'special', true));

  $('#slotDay').innerHTML = GC.DAYS.map((d, i) => `<option value="${i + 1}">${d}</option>`).join('');
  let editing = null;
  function openSlot(slot, kind, isNew) {
    editing = { slot, kind, isNew, color: slot.color || '' };
    $('#slotModalTitle').textContent = (isNew ? 'Nouveau ' : 'Modifier ') + (kind === 'slot' ? 'créneau récurrent' : 'événement ponctuel');
    $('#slotDayWrap').hidden = kind !== 'slot'; $('#slotDateWrap').hidden = kind !== 'special'; $('#slotCancelWrap').hidden = kind !== 'special';
    $('#slotDay').value = slot.day || 1; $('#slotDate').value = slot.date || '';
    $('#slotStart').value = slot.start || ''; $('#slotEnd').value = slot.end || '';
    $('#slotTitle').value = slot.title || ''; $('#slotGame').value = slot.game || ''; $('#slotGuest').value = slot.guest || '';
    $('#slotColor').value = slot.color || S.planning.accent || '#2ee59d';
    $('#slotCancelled').checked = !!slot.cancelled;
    $('#slotDelete').hidden = isNew;
    $('#slotModal').hidden = false;
  }
  $('#slotColor').addEventListener('input', (e) => { editing.color = e.target.value; });
  $('#slotColorReset').addEventListener('click', () => { editing.color = ''; $('#slotColor').value = S.planning.accent || '#2ee59d'; });
  $('#slotOk').addEventListener('click', () => {
    const s = editing.slot;
    Object.assign(s, {
      start: $('#slotStart').value, end: $('#slotEnd').value, title: $('#slotTitle').value.trim(),
      game: $('#slotGame').value.trim(), guest: $('#slotGuest').value.trim(), color: editing.color,
    });
    if (editing.kind === 'slot') s.day = Number($('#slotDay').value);
    else { s.date = $('#slotDate').value; s.cancelled = $('#slotCancelled').checked; if (!s.date) return toast('Choisis une date', true); }
    const list = editing.kind === 'slot' ? (S.planning.slots = S.planning.slots || []) : (S.planning.specials = S.planning.specials || []);
    if (editing.isNew) list.push(s);
    $('#slotModal').hidden = true; planChanged();
  });
  $('#slotDelete').addEventListener('click', (e) => {
    if (!confirmInline(e.currentTarget)) return;
    const key = editing.kind === 'slot' ? 'slots' : 'specials';
    S.planning[key] = S.planning[key].filter((x) => x !== editing.slot);
    $('#slotModal').hidden = true; planChanged();
  });

  $('#planCopy').addEventListener('click', () => {
    const p = S.planning; const ws = GC.weekStart();
    const f = (d) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    const end = new Date(ws); end.setDate(end.getDate() + 6);
    const lines = [`📅 **${p.title || 'Planning'}** (${f(ws)} → ${f(end)})`, ''];
    for (let i = 0; i < 7; i++) {
      const d = new Date(ws); d.setDate(d.getDate() + i);
      const { items, cancelled, cancelNote } = GC.streamsForDate(p, d);
      const head = `**${GC.DAYS[i]} ${f(d)}**`;
      if (!items.length) lines.push(`${head} — ${cancelled ? '❌ ' + (cancelNote || 'Pas de live') : '😴 ' + (p.offLabel || 'Repos')}`);
      else items.forEach((s) => lines.push(`${head} — 🔴 ${GC.fmtTime(s.start)} → ${GC.fmtTime(s.end)}${s.title ? ' · ' + s.title : ''}${s.game ? ' · 🎮 ' + s.game : ''}${s.guest ? ' · 🤝 avec ' + s.guest : ''}`));
    }
    if (p.subtitle) lines.push('', p.subtitle);
    copyText(lines.join('\n')).then(() => toast('Planning copié — colle-le dans #annonces-planning'), () => toast('Copie impossible', true));
  });

  /* ---------------- OBS ---------------- */
  let baseUrl = location.origin;
  fetch('/api/info').then((r) => r.json()).then((d) => {
    if (/localhost|127\.0\.0\.1/.test(location.hostname) && d.ips?.length) { local.ipHint = `http://${d.ips[0]}:${d.port}`; }
    renderObs();
  }).catch(() => {});
  const OVERLAYS = [
    { name: 'Chat', path: '/overlay/chat.html', size: '450 × 800', w: 450, h: 600, desc: 'Le chat en transparent, avec emotes et badges.' },
    { name: 'Alertes', path: '/overlay/alerts.html', size: '1920 × 1080', w: 1920, h: 1080, desc: 'Follows, abos, raids, points, bits. Coche « Contrôler l\'audio via OBS » pour le son.' },
    { name: 'Message mis en avant', path: '/overlay/highlight.html', size: '1920 × 1080', w: 1920, h: 1080, desc: 'Le message sur lequel tu cliques ⭐ dans le chat.' },
    { name: 'Planning', path: '/overlay/planning.html', size: '1920 × 1080', w: 1920, h: 1080, desc: 'Planning de la semaine + compte à rebours. Variante : ajoute ?layout=compact pour une version bandeau (1920 × 200).' },
  ];
  function renderObs() {
    $('#overlayList').innerHTML = OVERLAYS.map((o) => `<div class="ov">
      <div class="preview checker" data-h="230"><iframe src="${o.path}?preview=1" data-w="${o.w}" data-h="${o.h}" title="${esc(o.name)}" loading="lazy"></iframe></div>
      <div class="ov-info"><h4>${esc(o.name)} <span class="muted">· ${o.size}</span></h4><div class="muted">${o.desc}</div>
      <div class="url"><input readonly value="${esc(baseUrl + o.path)}"><button class="btn small" data-copy="${esc(baseUrl + o.path)}">Copier</button></div>
      ${local.ipHint ? `<div class="url"><input readonly value="${esc(local.ipHint + o.path)}" title="Si OBS tourne sur un autre PC"><button class="btn small ghost" data-copy="${esc(local.ipHint + o.path)}">Autre PC</button></div>` : ''}
      </div></div>`).join('');
    buildForm('#formChat', 'overlayChat', [
      ['fontSize', 'Taille du texte (px)', 'number'], ['maxMessages', 'Nombre max de messages', 'number'],
      ['hideAfter', 'Masquer après (secondes, 0 = jamais)', 'number'], ['background', 'Fond des messages (CSS, ex. rgba(0,0,0,0.5) ou transparent)', 'text'],
      ['textColor', 'Couleur du texte', 'color'], ['animation', 'Animation', 'select', { slide: 'Glissement', fade: 'Fondu', none: 'Aucune' }],
      ['showBadges', 'Afficher les badges', 'checkbox'], ['showEvents', 'Afficher follows / abos / raids', 'checkbox'],
      ['hideCommands', 'Masquer les commandes (!xxx)', 'checkbox'], ['hideBots', 'Masquer les bots', 'checkbox'], ['showTime', 'Afficher l\'heure', 'checkbox'],
    ]);
    buildForm('#formAlerts', 'alerts', [
      ['duration', 'Durée d\'affichage (s)', 'number'], ['follow', 'Follows', 'checkbox'], ['sub', 'Abonnements', 'checkbox'],
      ['subgift', 'Abos offerts', 'checkbox'], ['raid', 'Raids', 'checkbox'], ['cheer', 'Bits', 'checkbox'], ['reward', 'Points de chaîne', 'checkbox'],
      ['sound', 'Son', 'checkbox'], ['volume', 'Volume (0 à 1)', 'number'],
    ]);
    buildForm('#formHl', 'overlayHighlight', [
      ['duration', 'Masquer après (s, 0 = jusqu\'à ce que tu le retires)', 'number'],
      ['position', 'Position', 'select', { 'bottom-left': 'Bas gauche', 'bottom-center': 'Bas centre', 'top-left': 'Haut gauche', 'center': 'Centre' }],
      ['scale', 'Échelle (1 = normal)', 'number'],
    ]);
    fitPreviews();
  }
  /* Les overlays sont rendus à leur taille réelle puis réduits pour l'aperçu */
  function fitPreviews() {
    $$('iframe[data-w]').forEach((f) => {
      const box = f.parentElement; const cw = box.clientWidth; if (!cw) return;
      const w = Number(f.dataset.w); const h = Number(f.dataset.h); const fixedH = Number(box.dataset.h) || 0;
      const sc = fixedH ? Math.min(cw / w, fixedH / h) : cw / w;
      Object.assign(f.style, { width: w + 'px', height: h + 'px', transform: `scale(${sc})`, transformOrigin: '0 0', marginLeft: fixedH ? (cw - w * sc) / 2 + 'px' : '0' });
      box.style.height = (fixedH || h * sc) + 'px';
    });
  }
  window.addEventListener('resize', fitPreviews);
  $('#overlayList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    copyText(b.dataset.copy).then(() => toast('URL copiée'), () => toast('Copie impossible', true));
  });
  function buildForm(sel, section, fields) {
    const cur = S.settings[section] || {};
    $(sel).innerHTML = fields.map(([k, label, type, opts]) => {
      const v = cur[k];
      if (type === 'checkbox') return `<label class="check"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}> ${label}</label>`;
      if (type === 'select') return `<label>${label}<select data-k="${k}">${Object.entries(opts).map(([ov, ol]) => `<option value="${ov}" ${ov === v ? 'selected' : ''}>${ol}</option>`).join('')}</select></label>`;
      return `<label>${label}<input type="${type}" data-k="${k}" value="${esc(v ?? '')}" ${type === 'number' ? 'step="any"' : ''}></label>`;
    }).join('');
    let t;
    $$('[data-k]', $(sel)).forEach((inp) => inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
        api('POST', '/api/settings', { [section]: { [inp.dataset.k]: v } }).catch((e) => toast(e.message, true));
      }, 300);
    }));
  }
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => run(api('POST', '/api/test-event', { kind: b.dataset.test }))));

  /* ---------------- Réglages ---------------- */
  function fillSettings() {
    $('#clientId').value = S.status.clientId || '';
    $('#channel').value = S.status.channel || '';
    $('#hlWords').value = (S.settings.highlightWords || []).join(', ');
    $('#ignored').value = (S.settings.ignoredUsers || []).join(', ');
    $('#sndFirst').checked = !!local.sndFirst; $('#sndMention').checked = !!local.sndMention; $('#sndEvent').checked = !!local.sndEvent;
  }
  let authPending = null;
  function renderAuth() {
    const st = S.status; const box = $('#authBox');
    if (st.login) {
      box.innerHTML = `<p>✅ Connecté en tant que <b>${esc(st.login)}</b></p>
        ${st.eventsubDetail ? `<p class="muted">⚠️ ${esc(st.eventsubDetail)}</p>` : ''}
        <button class="btn ghost" id="logoutBtn">Se déconnecter</button><hr style="border-color:var(--line)">`;
      $('#logoutBtn').onclick = () => run(api('POST', '/api/auth/logout'), 'Déconnecté');
      authPending = null;
    } else if (authPending) {
      box.innerHTML = `<p>Ouvre ce lien et saisis le code :</p>
        <a class="btn" href="${esc(authPending.verificationUri)}" target="_blank" rel="noopener">Ouvrir twitch.tv/activate ↗</a>
        <div class="authcode">${esc(authPending.userCode)}</div><p class="muted">En attente de ta validation sur Twitch…</p>`;
    } else {
      box.innerHTML = `<p class="muted">Non connecté : chat en lecture seule.</p><button class="btn" id="loginBtn" ${st.clientId ? '' : 'disabled title="Renseigne le Client ID d\'abord"'}>Se connecter avec Twitch</button><hr style="border-color:var(--line)">`;
      $('#loginBtn').onclick = async () => {
        try { authPending = await api('POST', '/api/auth/start'); renderAuth(); window.open(authPending.verificationUri, '_blank', 'noopener'); }
        catch (e) { toast(e.message, true); }
      };
    }
  }
  const ES_LABELS = {
    'channel.follow': 'Follows', 'channel.channel_points_custom_reward_redemption.add': 'Récompenses (points)', 'channel.ad_break.begin': 'Publicités',
    'channel.poll.begin': 'Sondage lancé', 'channel.poll.end': 'Sondage terminé', 'channel.prediction.begin': 'Prédiction lancée',
    'channel.prediction.lock': 'Prédiction fermée', 'channel.prediction.end': 'Prédiction terminée', 'channel.hype_train.begin': 'Train de la hype (début)',
    'channel.hype_train.end': 'Train de la hype (fin)', 'channel.goal.begin': 'Objectif lancé', 'channel.goal.end': 'Objectif terminé',
    'channel.charity_campaign.donate': 'Dons caritatifs', 'stream.online': 'Live commencé', 'stream.offline': 'Live terminé',
    'channel.shoutout.create': 'Shoutout envoyé', 'channel.shoutout.receive': 'Shoutout reçu', 'channel.shield_mode.begin': 'Bouclier activé',
    'channel.shield_mode.end': 'Bouclier désactivé', 'channel.unban': 'Unbans', 'channel.unban_request.create': 'Demandes de déban', 'channel.warning.send': 'Avertissements',
  };
  async function loadEsReport() {
    try {
      const r = await api('GET', '/api/eventsub');
      if (!r.items.length) { $('#esList').innerHTML = '<p class="muted">Pas encore d\'abonnement (connecte ton compte Twitch).</p>'; return; }
      const ok = r.items.filter((i) => i.ok).length;
      $('#esList').innerHTML = `<p class="muted">${ok} / ${r.items.length} actifs — vérifié à ${new Date(r.at).toLocaleTimeString('fr-FR')}</p>`
        + r.items.map((i) => `<div class="es-item ${i.ok ? 'ok' : 'ko'}"><span>${i.ok ? '✅' : '❌'} ${esc(ES_LABELS[i.type] || i.type)}</span>${i.ok ? '' : `<small>${esc(i.error)}</small>`}</div>`).join('');
    } catch (e) { $('#esList').textContent = e.message; }
  }
  $('#esReport').addEventListener('toggle', (e) => { if (e.target.open) loadEsReport(); });

  $('#saveConfig').addEventListener('click', () => run(api('POST', '/api/config', { clientId: $('#clientId').value, channel: $('#channel').value }), 'Enregistré'));
  $('#saveChatSettings').addEventListener('click', () => {
    local.sndFirst = $('#sndFirst').checked; local.sndMention = $('#sndMention').checked; local.sndEvent = $('#sndEvent').checked; saveLocal();
    const split = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
    run(api('POST', '/api/settings', { highlightWords: split($('#hlWords').value), ignoredUsers: split($('#ignored').value).map((s) => s.toLowerCase()) }), 'Réglages enregistrés')
      .then((s) => { S.settings = s; renderColumns(); });
  });
  $('#demoBtn').addEventListener('click', () => run(api('POST', '/api/demo', { on: !S.status.demo })));

  /* ---------------- Assistant de première configuration ---------------- */
  const wiz = { step: 0, auth: null, authError: '', autoShown: false, nextTimer: null };
  const WIZ_LAST = 5;
  const WIZ_OVERLAYS = [
    ['💬 Chat', '/overlay/chat.html', '450 × 800'],
    ['🔔 Alertes', '/overlay/alerts.html', '1920 × 1080'],
    ['⭐ Message mis en avant', '/overlay/highlight.html', '1920 × 1080'],
    ['📅 Planning', '/overlay/planning.html', '1920 × 1080'],
  ];
  const cleanChannel = (v) => v.trim().replace(/^#/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  function wizMsg(sel, text, kind) { const el = $(sel); el.textContent = text || ''; el.className = 'wiz-msg' + (kind ? ' ' + kind : ''); }

  function openWizard(step = 0) {
    $('#wizChannel').value = S.status.channel || '';
    $('#wizClientId').value = S.status.clientId || '';
    wizMsg('#wizChannelMsg'); wizMsg('#wizClientMsg');
    wiz.authError = '';
    $('#wizard').hidden = false;
    wizGo(step);
  }
  function closeWizard(markDone = true) {
    clearTimeout(wiz.nextTimer);
    $('#wizard').hidden = true;
    if (markDone && !S.settings.setupDone) api('POST', '/api/settings', { setupDone: true }).then((s) => { S.settings = s; }).catch(() => {});
  }
  function wizGo(step) {
    clearTimeout(wiz.nextTimer);
    wiz.step = Math.max(0, Math.min(WIZ_LAST, step));
    $$('.wiz-page').forEach((p) => p.classList.toggle('active', +p.dataset.step === wiz.step));
    $$('#wizSteps li').forEach((li, i) => { li.className = i + 1 === wiz.step ? 'cur' : i + 1 < wiz.step ? 'done' : ''; });
    wizMsg('#wizChannelMsg'); wizMsg('#wizClientMsg');
    if (wiz.step === 1) setTimeout(() => $('#wizChannel').focus(), 50);
    if (wiz.step === 2) { $('#wizAppName').textContent = cleanChannel($('#wizChannel').value) || 'perso'; setTimeout(() => $('#wizClientId').focus(), 50); }
    if (wiz.step === 3) wizRenderAuth();
    if (wiz.step === 4) wizRenderObs();
    if (wiz.step === 5) wizRenderSummary();
  }

  $('#wizard').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wiz],[data-copy],[data-copy-from]');
    if (!b) return;
    if (b.dataset.copy || b.dataset.copyFrom) {
      const text = b.dataset.copy || $('#' + b.dataset.copyFrom).textContent;
      copyText(text).then(() => { const t = b.textContent; b.textContent = '✓ Copié'; setTimeout(() => { b.textContent = t; }, 1200); }).catch(() => toast('Copie impossible : sélectionne le texte à la main', true));
      return;
    }
    const a = b.dataset.wiz;
    if (a === 'next') wizGo(wiz.step + 1);
    else if (a === 'prev') wizGo(wiz.step === 4 && !S.status.clientId ? 2 : wiz.step - 1);
    else if (a === 'readonly') wizGo(4);
    else if (a === 'skip') closeWizard(true);
    else if (a === 'finish') { closeWizard(true); $('.nav[data-tab="chat"]').click(); }
  });
  $('#wizClose').addEventListener('click', () => closeWizard(true));
  $('#wizardBtn').addEventListener('click', () => openWizard(0));

  // Étape 1 : la chaîne
  async function wizSaveChannel() {
    const ch = cleanChannel($('#wizChannel').value);
    if (!ch) return wizMsg('#wizChannelMsg', 'Indique le nom de ta chaîne.', 'err');
    if (!/^[a-z0-9_]{3,25}$/.test(ch)) return wizMsg('#wizChannelMsg', 'Un nom de chaîne Twitch fait de 3 à 25 caractères : lettres, chiffres et « _ ».', 'err');
    $('#wizChannel').value = ch;
    try {
      if (ch !== S.status.channel) await api('POST', '/api/config', { channel: ch });
      wizMsg('#wizChannelMsg', '✓ Chaîne enregistrée : le chat de #' + ch + ' arrive dans l\'onglet Chat.', 'ok');
      wiz.nextTimer = setTimeout(() => wizGo(2), 700);
    } catch (e) { wizMsg('#wizChannelMsg', e.message, 'err'); }
  }
  $('#wizChannelOk').addEventListener('click', wizSaveChannel);
  $('#wizChannel').addEventListener('keydown', (e) => { if (e.key === 'Enter') wizSaveChannel(); });

  // Étape 2 : le Client ID
  async function wizSaveClient() {
    const id = $('#wizClientId').value.trim();
    if (!id) return wizMsg('#wizClientMsg', 'Colle le Client ID de ton appli, ou choisis « Rester en lecture seule ».', 'err');
    if (!/^[a-z0-9]{30}$/i.test(id)) return wizMsg('#wizClientMsg', 'Un Client ID Twitch fait 30 lettres et chiffres. Vérifie que tu as copié le Client ID (et pas le « Secret »).', 'err');
    try {
      const changed = id !== S.status.clientId;
      if (changed) { await api('POST', '/api/config', { clientId: id }); S.status.clientId = id; wiz.auth = null; }
      wizMsg('#wizClientMsg', '✓ Client ID enregistré', 'ok');
      wiz.nextTimer = setTimeout(() => { wizGo(3); if (!S.status.login && !wiz.auth) wizStartAuth(); }, 500);
    } catch (e) { wizMsg('#wizClientMsg', e.message, 'err'); }
  }
  $('#wizClientOk').addEventListener('click', wizSaveClient);
  $('#wizClientId').addEventListener('keydown', (e) => { if (e.key === 'Enter') wizSaveClient(); });

  // Étape 3 : connexion (Device Code Flow, même mécanisme que Réglages)
  async function wizStartAuth() {
    wiz.authError = ''; wiz.auth = { loading: true }; wizRenderAuth();
    try {
      wiz.auth = await api('POST', '/api/auth/start');
      authPending = wiz.auth; renderAuth();
      window.open(wiz.auth.verificationUri, '_blank', 'noopener');
    } catch (e) {
      wiz.auth = null;
      wiz.authError = /invalid client/i.test(e.message) ? 'Twitch ne reconnaît pas ce Client ID.' : e.message;
    }
    wizRenderAuth();
  }
  function wizRenderAuth() {
    const box = $('#wizAuth'); const st = S.status; const skip = $('#wizAuthSkip');
    skip.className = 'btn ghost'; skip.textContent = 'Passer cette étape';
    if (st.login) {
      const other = st.channel && st.login.toLowerCase() !== st.channel.toLowerCase();
      box.innerHTML = `<p class="wiz-msg ok" style="font-size:15px">✅ Connecté en tant que <b>${esc(st.login)}</b></p>
        ${other ? `<p class="muted">⚠️ Ce n'est pas le compte de la chaîne <b>#${esc(st.channel)}</b> : tu pourras modérer si tu y es modo, mais les raids, pubs, sondages et prédictions demandent le compte du streamer.</p>` : '<p class="muted">Tu as accès à toutes les commandes : modération, raids, pubs, sondages, prédictions.</p>'}
        <button class="btn small ghost" id="wizReauth">Utiliser un autre compte</button>`;
      $('#wizReauth').onclick = async () => { await run(api('POST', '/api/auth/logout')); S.status.login = null; wizStartAuth(); };
      skip.className = 'btn'; skip.textContent = 'Continuer →';
    } else if (wiz.auth?.loading) {
      box.innerHTML = '<p><span class="wiz-wait"></span>Demande envoyée à Twitch…</p>';
    } else if (wiz.auth) {
      box.innerHTML = `<p>Un onglet Twitch vient de s'ouvrir. Connecte-toi avec <b>le compte du streamer</b>, puis saisis ce code :</p>
        <div class="authcode">${esc(wiz.auth.userCode)}</div>
        <div class="row wrap"><a class="btn" href="${esc(wiz.auth.verificationUri)}" target="_blank" rel="noopener">Ouvrir twitch.tv/activate ↗</a><button class="btn ghost" data-copy="${esc(wiz.auth.userCode)}">Copier le code</button></div>
        <p class="muted"><span class="wiz-wait"></span>En attente de ta validation sur Twitch… cette page avancera toute seule.</p>`;
    } else {
      box.innerHTML = `${wiz.authError ? `<p class="wiz-msg err">❌ ${esc(wiz.authError)}</p><p class="muted">Vérifie à l'étape précédente le Client ID et que l'appli est bien de type <b>Public</b>.</p>` : '<p>Dernière étape côté Twitch : autoriser GreenChat à utiliser ton compte. Rien ne quitte ta machine.</p>'}
        <button class="btn" id="wizLogin">${wiz.authError ? 'Réessayer' : 'Se connecter avec Twitch'}</button>`;
      $('#wizLogin').onclick = wizStartAuth;
    }
  }
  function wizOnAuth(m) {
    if ($('#wizard').hidden) return;
    wiz.auth = null;
    if (m.ok) { S.status.login = m.login; if (wiz.step === 3) { wizRenderAuth(); wiz.nextTimer = setTimeout(() => wizGo(4), 1500); } }
    else { wiz.authError = m.error || 'Connexion refusée'; if (wiz.step === 3) wizRenderAuth(); }
  }

  // Étape 4 : OBS
  function wizRenderObs() {
    const base = location.origin;
    $('#wizDockUrl').textContent = base + '/';
    $('#wizOverlays').innerHTML = WIZ_OVERLAYS.map(([name, p, size], i) => `<div class="wiz-url"><span style="width:150px">${name}</span><code id="wizOv${i}">${esc(base + p)}</code><small>${size}</small><button class="btn small ghost" data-copy-from="wizOv${i}">Copier</button></div>`).join('');
    $('#wizDemo').textContent = S.status.demo ? 'Arrêter la démo' : 'Activer la démo';
  }
  $('#wizDemo').addEventListener('click', () => run(api('POST', '/api/demo', { on: !S.status.demo })).then(() => { S.status.demo = !S.status.demo; wizRenderObs(); }));

  // Étape 5 : récapitulatif
  function wizRenderSummary() {
    const st = S.status;
    const rows = [
      st.channel ? `✅ Chaîne suivie : <b>#${esc(st.channel)}</b>` : '⚠️ Aucune chaîne : le chat restera vide',
      st.login ? `✅ Connecté à Twitch en tant que <b>${esc(st.login)}</b>` : '👀 Lecture seule : connecte ton compte dans Réglages pour écrire, modérer et recevoir les follows',
      st.login ? (st.eventsub === 'on' ? '✅ Événements Twitch (follows, points, sondages…) actifs' : '⏳ Événements Twitch en cours d\'activation (détail dans Réglages → diagnostic)') : '',
      '🎥 Adresses OBS : toujours disponibles dans l\'onglet OBS',
    ].filter(Boolean);
    $('#wizSummary').innerHTML = rows.map((r) => `<li>${r}</li>`).join('');
  }

  // Ouverture automatique au premier lancement (aucune chaîne configurée)
  function maybeAutoWizard() {
    if (wiz.autoShown) return;
    wiz.autoShown = true;
    if (!S.settings.setupDone && !S.status.channel) openWizard(0);
  }
})();
