/* Fonctions partagées entre le panneau de contrôle et les overlays OBS */
window.GC = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function connect(onMessage, onStatus) {
    let retry = 1000;
    (function open() {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => { retry = 1000; onStatus && onStatus(true); };
      ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
      ws.onclose = () => { onStatus && onStatus(false); setTimeout(open, retry); retry = Math.min(retry * 2, 10000); };
    })();
  }

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
    return data;
  }

  const DEFAULT_COLORS = ['#FF4A4A', '#4A7BFF', '#3DDC84', '#B22222', '#FF7F50', '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];
  function nameColor(user) {
    if (user?.color) return user.color;
    const s = (user?.login || '') + '';
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length];
  }

  const BADGE_FALLBACK = { broadcaster: '🎥', moderator: '🗡️', vip: '💎', subscriber: '⭐', founder: '🏅', partner: '✔️', staff: '🔧', premium: '👑', 'bits': '🔷', 'sub-gifter': '🎁' };
  // roomId : chaîne d'origine (chat partagé) pour trouver ses badges d'abonné à elle
  function badgesHtml(user, badgeMap, roomId) {
    return (user?.badges || []).map((b) => {
      const key = b.set + '/' + b.version;
      const url = badgeMap && ((roomId && badgeMap[roomId + ':' + key]) || badgeMap[key]);
      if (url) return `<img class="badge" src="${esc(url)}" alt="${esc(b.set)}" title="${esc(b.set)}">`;
      const f = BADGE_FALLBACK[b.set];
      return f ? `<span class="badge badge-txt" title="${esc(b.set)}">${f}</span>` : '';
    }).join('');
  }

  /* Chat partagé : pastille de la chaîne d'où vient un message */
  function srcColor(ch) {
    if (ch?.color) return ch.color;
    const s = (ch?.login || ch?.id || '') + ''; let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length];
  }
  function srcHtml(source, channels) {
    if (!source) return '';
    const ch = (channels && channels[source.roomId]) || { id: source.roomId, name: 'Autre chaîne' };
    const title = 'Chat partagé : message venant de ' + (ch.login ? '#' + ch.login : 'une autre chaîne');
    return ch.avatar
      ? `<img class="src" src="${esc(ch.avatar)}" alt="" title="${esc(title)}">`
      : `<span class="src src-txt" style="background:${esc(srcColor(ch))}" title="${esc(title)}">${esc((ch.name || '?').charAt(0).toUpperCase())}</span>`;
  }
  function srcName(source, channels) {
    const ch = source && channels && channels[source.roomId];
    return ch ? (ch.name || ch.login) : 'une autre chaîne';
  }

  function toMap(obj) { return Object.assign(Object.create(null), obj || {}); }

  function renderWords(s, ctx) {
    return s.split(/(\s+)/).map((w) => {
      if (!w) return '';
      if (/^\s+$/.test(w)) return w;
      const e = ctx.emotes && ctx.emotes[w];
      if (e) return `<img class="emote" src="${esc(e.url)}" alt="${esc(w)}" title="${esc(w)} (${esc(e.src)})">`;
      if (ctx.linkify && /^https?:\/\/\S+$/i.test(w)) return `<a href="${esc(w)}" target="_blank" rel="noopener noreferrer">${esc(w)}</a>`;
      const bare = w.replace(/^@/, '').replace(/[,.!?:;]+$/, '').toLowerCase();
      if (ctx.mentionLogin && bare === ctx.mentionLogin) return `<span class="mention">${esc(w)}</span>`;
      if (w.startsWith('@')) return `<span class="at">${esc(w)}</span>`;
      return esc(w);
    }).join('');
  }

  /* Remplace les emotes Twitch (positions du tag "emotes") puis 7TV/BTTV/FFZ (par mot) */
  function renderText(text, emotesTag, ctx = {}) {
    const chars = Array.from(text || '');
    const ranges = [];
    if (emotesTag) {
      for (const part of emotesTag.split('/')) {
        const [id, pos] = part.split(':');
        if (!pos) continue;
        for (const r of pos.split(',')) { const [a, b] = r.split('-').map(Number); ranges.push({ a, b, id }); }
      }
      ranges.sort((x, y) => x.a - y.a);
    }
    let out = ''; let i = 0;
    for (const r of ranges) {
      if (r.a < i || r.b >= chars.length) continue;
      out += renderWords(chars.slice(i, r.a).join(''), ctx);
      const name = chars.slice(r.a, r.b + 1).join('');
      out += `<img class="emote" src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(r.id)}/default/dark/2.0" alt="${esc(name)}" title="${esc(name)}">`;
      i = r.b + 1;
    }
    out += renderWords(chars.slice(i).join(''), ctx);
    return out;
  }

  /* Texte en français pour chaque type d'événement */
  function eventInfo(ev) {
    const n = `<b>${esc(ev.user?.name || 'Anonyme')}</b>`;
    switch (ev.kind) {
      case 'follow': return { icon: '💚', label: 'Follow', html: `${n} suit la chaîne !` };
      case 'sub':
        if (ev.upgrade) return { icon: '⭐', label: 'Abonnement', html: `${n} continue son abonnement !` };
        return { icon: '⭐', label: 'Abonnement', html: ev.months > 1 ? `${n} se réabonne (${esc(ev.tier)}) — <b>${ev.months} mois</b> !` : `${n} s'abonne (${esc(ev.tier)}) !` };
      case 'subgift':
        return ev.community
          ? { icon: '🎁', label: 'Abos offerts', html: `${n} offre <b>${ev.count}</b> abo${ev.count > 1 ? 's' : ''} à la communauté !` }
          : { icon: '🎁', label: 'Abo offert', html: `${n} offre un abo à <b>${esc(ev.recipient || '?')}</b> !` };
      case 'raid': return { icon: '🚀', label: 'Raid', html: `${n} débarque en raid avec <b>${ev.viewers}</b> viewers !` };
      case 'reward': return { icon: '🎯', label: 'Points de chaîne', html: `${n} utilise « <b>${esc(ev.reward?.title)}</b> » (${ev.reward?.cost ?? '?'} pts)` };
      case 'ad': return { icon: '📺', label: 'Pub', html: `Coupure pub de <b>${ev.duration}s</b> lancée${ev.manual ? ' (manuellement)' : ''}` };
      case 'poll':
        return ev.phase === 'end'
          ? { icon: '📊', label: 'Sondage', html: `Sondage terminé : <b>${esc(ev.title)}</b> — ${(ev.choices || []).map((c, i) => `${i === 0 ? '🏆 ' : ''}${esc(c.title)} (${c.votes})`).join(' · ')}` }
          : { icon: '📊', label: 'Sondage', html: `Nouveau sondage : <b>${esc(ev.title)}</b> — ${esc((ev.choices || []).join(' / '))}` };
      case 'prediction': {
        const t = `<b>${esc(ev.title)}</b>`;
        const m = { begin: `Nouvelle prédiction : ${t} — ${esc((ev.outcomes || []).join(' / '))}`, lock: `Paris fermés : ${t}`, end: `Prédiction terminée : ${t} — 🏆 <b>${esc(ev.winner)}</b>`, cancel: `Prédiction annulée : ${t} (points remboursés)` };
        return { icon: '🔮', label: 'Prédiction', html: m[ev.phase] || t };
      }
      case 'hypetrain':
        return ev.phase === 'end'
          ? { icon: '🚂', label: 'Train de la hype', html: `Train de la hype terminé au <b>niveau ${ev.level}</b> !` }
          : { icon: '🚂', label: 'Train de la hype', html: `Un <b>train de la hype</b> démarre !` };
      case 'goal': {
        const prog = `${ev.current ?? 0} / ${ev.target ?? '?'}`;
        const m = { begin: `Nouvel objectif : <b>${esc(ev.description || ev.goalType)}</b> (${prog})`, achieved: `Objectif atteint : <b>${esc(ev.description || ev.goalType)}</b> 🎉 (${prog})`, end: `Objectif terminé : <b>${esc(ev.description || ev.goalType)}</b> (${prog})` };
        return { icon: '🎯', label: 'Objectif', html: m[ev.phase] || '' };
      }
      case 'charity': return { icon: '💝', label: 'Don caritatif', html: `${n} donne <b>${esc(ev.amount)}</b> pour ${esc(ev.charity || 'l\'association')} !` };
      case 'stream': return ev.phase === 'online' ? { icon: '🟢', label: 'Stream', html: 'Le live a <b>commencé</b>' } : { icon: '🔴', label: 'Stream', html: 'Le live est <b>terminé</b>' };
      case 'shoutout':
        return ev.phase === 'in'
          ? { icon: '📢', label: 'Shoutout', html: `${n} t'a fait un shoutout !` }
          : { icon: '📢', label: 'Shoutout', html: `Shoutout envoyé à ${n}${ev.viewers != null ? ` (vu par ${ev.viewers} viewers)` : ''}` };
      case 'shield': return { icon: '🛡️', label: 'Mode bouclier', html: `Mode bouclier <b>${ev.phase === 'on' ? 'activé' : 'désactivé'}</b>${ev.by ? ' par ' + esc(ev.by) : ''}` };
      case 'unban': return { icon: '♻️', label: 'Unban', html: `${n} a été débanni${ev.by ? ' par ' + esc(ev.by) : ''}` };
      case 'unbanrequest': return { icon: '🙏', label: 'Demande de déban', html: `${n} demande à être débanni` };
      case 'warn': return { icon: '⚠️', label: 'Avertissement', html: `${n} a reçu un avertissement${ev.by ? ' de ' + esc(ev.by) : ''}${ev.reason ? ' : ' + esc(ev.reason) : ''}` };
      case 'shared': {
        const list = (a) => (a || []).map((x) => `<b>${esc(x)}</b>`).join(', ');
        if (ev.phase === 'begin') return { icon: '🔗', label: 'Chat partagé', html: `Chat partagé activé avec ${list(ev.partners) || "d'autres chaînes"}${ev.host ? ` (hôte : <b>${esc(ev.host)}</b>)` : ''}` };
        if (ev.phase === 'end') return { icon: '🔗', label: 'Chat partagé', html: 'Chat partagé <b>terminé</b>' };
        const parts = [];
        if (ev.joined?.length) parts.push(`${list(ev.joined)} rejoint le chat partagé`);
        if (ev.left?.length) parts.push(`${list(ev.left)} quitte le chat partagé`);
        return { icon: '🔗', label: 'Chat partagé', html: parts.join(' · ') };
      }
      case 'watchstreak': return { icon: '🔥', label: 'Série de streams', html: `${n} a regardé <b>${ev.value} streams d'affilée</b> !` };
      default: return { icon: 'ℹ️', label: 'Info', html: esc(ev.systemText || 'Événement') };
    }
  }

  /* ---------------- Planning ---------------- */
  const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayIndex = (d) => ((d.getDay() + 6) % 7) + 1; // 1 = lundi … 7 = dimanche
  function atTime(date, hhmm) { const [h, m] = (hhmm || '00:00').split(':').map(Number); const d = new Date(date); d.setHours(h, m, 0, 0); return d; }
  function weekStart(now = new Date()) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (dayIndex(d) - 1)); return d; }
  function fmtTime(hhmm) { return (hhmm || '').replace(':', 'h'); }

  /* Liste des lives d'un jour donné (créneaux récurrents + événements ponctuels) */
  function streamsForDate(planning, date) {
    const iso = isoDate(date);
    const specials = (planning.specials || []).filter((s) => s.date === iso);
    const cancelled = specials.some((s) => s.cancelled);
    const regular = cancelled ? [] : (planning.slots || []).filter((s) => Number(s.day) === dayIndex(date));
    const extra = specials.filter((s) => !s.cancelled);
    return {
      cancelled, cancelNote: specials.find((s) => s.cancelled)?.title || '',
      items: [...regular, ...extra.map((s) => ({ ...s, special: true }))].sort((a, b) => (a.start || '').localeCompare(b.start || '')),
    };
  }
  function upcoming(planning, now = new Date()) {
    let live = null; let next = null;
    for (let off = -1; off <= 8 && !next; off++) {
      const day = new Date(now); day.setHours(12, 0, 0, 0); day.setDate(day.getDate() + off);
      for (const s of streamsForDate(planning, day).items) {
        const start = atTime(day, s.start);
        let end = atTime(day, s.end || s.start);
        if (end <= start) end.setDate(end.getDate() + 1);
        if (now >= start && now < end) live = { slot: s, start, end };
        else if (start > now && !next) next = { slot: s, start, end };
      }
    }
    return { live, next };
  }
  function countdown(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mn = m % 60;
    if (d > 0) return `${d}j ${h}h`;
    if (h > 0) return `${h}h ${pad(mn)}min`;
    return `${mn} min`;
  }

  /* Petit "ding" sans fichier audio */
  let audioCtx = null;
  function ding(volume = 0.4, notes = [880, 1320]) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = audioCtx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(volume, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.4);
      });
    } catch { /* audio indisponible */ }
  }

  function params() { return Object.fromEntries(new URLSearchParams(location.search)); }

  return { esc, connect, api, nameColor, badgesHtml, srcHtml, srcName, srcColor, renderText, eventInfo, toMap, DAYS, pad, isoDate, dayIndex, weekStart, fmtTime, streamsForDate, upcoming, countdown, ding, params };
})();
