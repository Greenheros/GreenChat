# GreenChat — chat Twitch local façon Twitchat

Un poste de contrôle pour ton live, 100 % local : chat multi-colonnes, modération, message mis en avant sur le stream, alertes, infos du stream et planning, avec des overlays pour OBS.

## Installation (une seule fois)

1. Installe **Node.js 18 ou plus** (version LTS) : https://nodejs.org
2. Dézippe le dossier `greenchat` où tu veux (par ex. sur le mini PC).
3. Double-clique sur **`start.bat`**. Au premier lancement, il installe les dépendances tout seul.
4. Ouvre **http://localhost:3500** (ou `http://IP-du-mini-PC:3500` depuis le PC de stream).

> Le pare-feu Windows peut demander l'autorisation pour Node.js : accepte sur « Réseau privé » pour pouvoir l'ouvrir depuis un autre PC.
> Pour un autre port : `set PORT=4000` avant `node server.js`.

## Connexion Twitch

Sans connexion, le chat s'affiche en lecture seule. Pour écrire, modérer, voir les follows et les points de chaîne :

1. https://dev.twitch.tv/console/apps → **Enregistrer votre application**
   - URL de redirection : `http://localhost`
   - Catégorie : *Chat Bot*
   - Type de client : **Public** (important, sinon la connexion échoue)
2. Dans GreenChat → **Réglages** : colle le **Client ID**, mets le nom de ta chaîne, **Enregistrer**.
3. **Se connecter avec Twitch** → une page twitch.tv/activate s'ouvre avec un code à valider.

Connecte-toi avec **ton compte de streamer** : les follows, les points de chaîne et les pubs ne sont disponibles que pour le propriétaire de la chaîne (les follows aussi pour un modo).

## Ce que ça fait

| Onglet | Fonctions |
|---|---|
| **Chat** | Colonnes configurables (⚙️ filtres : messages, événements, mentions, premiers messages, modos/VIP, points, bits, masquer bots et commandes). Emotes Twitch + 7TV + BTTV + FFZ, badges, réponses, recherche. Au survol d'un message : ⭐ afficher sur le stream, répondre, copier, supprimer, timeout, ban. Clic sur un pseudo → fiche (ancienneté, follow, historique, TO/ban/shoutout). Commandes : `/timeout pseudo 600`, `/ban`, `/unban`, `/so`, `/announce`, `/clear`, `/me`. Tab = complétion des pseudos, ↑ = historique. |
| **Stream** | Titre et catégorie du live, shoutout, annonce, viewers et durée du live. |
| **Planning** | Semaine type (créneaux récurrents), événements ponctuels (live spécial, annulation), bouton **Copier pour Discord** (format prêt pour #annonces-planning), aperçu de l'overlay. |
| **OBS** | URLs des overlays, aperçus, réglages en direct, boutons de test des alertes. |
| **Réglages** | Compte Twitch, mots surlignés, bots masqués, sons de notification, **mode démo** (faux chat pour régler tes overlays hors live). |

## Overlays OBS (Sources → ＋ → Navigateur)

| Overlay | URL | Taille |
|---|---|---|
| Chat | `/overlay/chat.html` | 450 × 800 |
| Alertes | `/overlay/alerts.html` | 1920 × 1080 (cocher « Contrôler l'audio via OBS ») |
| Message mis en avant | `/overlay/highlight.html` | 1920 × 1080 |
| Planning | `/overlay/planning.html` (ou `?layout=compact` en bandeau 1920 × 200) | 1920 × 1080 |

Les réglages peuvent être forcés par l'URL, par ex. `/overlay/chat.html?fontSize=28&hideAfter=30` ou `/overlay/highlight.html?position=bottom-center`.
Pour changer le style de tous les overlays : `public/css/overlay-custom.css`.

## Fichiers

- `server.js` : serveur (chat Twitch, EventSub, API Twitch, WebSocket vers les pages)
- `public/` : panneau de contrôle et overlays
- `data/` : créé au premier lancement — `config.json` (contient ton token Twitch : ne le partage pas), `settings.json`, `planning.json`

Le serveur écoute sur tout ton réseau local (pour le PC de stream). N'ouvre pas le port 3500 sur Internet.
