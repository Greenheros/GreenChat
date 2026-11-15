# 💚 GreenChat

**Le poste de contrôle de ton live Twitch, 100 % local.**
Chat multi-colonnes, modération, commandes de streamer, sondages, alertes et overlays OBS, réunis dans un seul panneau qui tourne sur ton PC.

> Gratuit · en français · aucun serveur tiers : ta connexion Twitch reste sur ta machine.

---

## Sommaire

- [Fonctions](#-fonctions)
- [Installation](#-installation)
- [Connexion à Twitch](#-connexion-à-twitch)
- [Utilisation dans OBS](#-utilisation-dans-obs)
- [Commandes du chat](#-commandes-du-chat)
- [Dépannage](#-dépannage)
- [Structure du projet](#-structure-du-projet)
- [Feuille de route](#-feuille-de-route)
- [Licence](#-licence)

---

## ✨ Fonctions

| Onglet | Ce qu'on peut faire |
|---|---|
| 💬 **Chat** | Colonnes illimitées, chacune avec son **panneau de filtres** : messages (mentions, premiers messages, modos/VIP, abonnés), follows, abos, bits, raids, points de chaîne, sondages, prédictions, train de la hype, objectifs, modération… Aperçu de chaque type, préréglages, couleur de fond. Emotes Twitch, 7TV, BTTV et FFZ, badges, réponses, recherche, complétion des pseudos avec Tab. Au survol d'un message : ⭐ afficher sur le stream, répondre, copier, supprimer, timeout, ban. Clic sur un pseudo : fiche du viewer. **Chat partagé** : bandeau des chaînes participantes, pastille d'origine sur chaque message, filtre « Origine » par colonne. |
| 🎬 **Stream** | Titre, catégorie et tags. Shoutout, annonces en couleur, marqueurs, clips. **Commandes admin** : modes du chat (lent, followers, abonnés, emotes, messages uniques, délai), mode bouclier, vider le chat, timeout/ban/unban/avertissement, modos et VIP, raid, publicités, sondages et prédictions avec résultats en direct. |
| 📅 **Planning** | Semaine type, événements ponctuels (live spécial, annulation), overlay planning et bouton **Copier pour Discord**. |
| 🖥️ **OBS** | Adresses des overlays, aperçus, réglages en direct, boutons de test des alertes. |
| ⚙️ **Réglages** | Compte Twitch, mots surlignés, bots masqués, sons de notification, mode démo, simulation de chat partagé, diagnostic des événements Twitch reçus. |

---

## 📦 Installation

**Prérequis :** Windows 10/11, [Node.js](https://nodejs.org) 18 ou plus récent (version LTS), un compte Twitch.

1. Télécharge le projet (bouton **Code → Download ZIP**) et dézippe-le où tu veux.
2. Double-clique sur **`start.bat`**. Au premier lancement, les dépendances s'installent toutes seules.
3. Le panneau s'ouvre sur **http://localhost:3500**.
4. Au premier lancement, un **assistant** te guide pas à pas : ta chaîne, ton appli Twitch, la connexion et l'ajout à OBS. Tu peux le relancer à tout moment depuis **Réglages → Assistant de configuration**.

> 💡 GreenChat peut tourner sur un **PC dédié ou un mini-PC** : ouvre alors `http://IP-du-PC:3500` depuis le PC de stream.
> Le pare-feu Windows doit autoriser Node.js sur les **réseaux privés**.
> Pour changer de port : `set PORT=4000` avant `node server.js`.

---

## 🔑 Connexion à Twitch

Sans connexion, le chat s'affiche en lecture seule. L'assistant de première configuration fait ces étapes avec toi ; pour les faire à la main :

1. Va sur [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Enregistrer votre application**.
   - URL de redirection : `http://localhost`
   - Catégorie : *Chat Bot*
   - Type de client : **Public** (important)
2. Dans GreenChat → **Réglages** : colle le **Client ID**, indique ta chaîne, **Enregistrer**.
3. Clique sur **Se connecter avec Twitch** et valide le code sur twitch.tv/activate.

Connecte-toi avec **le compte du streamer** : raids, pubs, sondages, prédictions, rôles et certains événements sont réservés au propriétaire de la chaîne.
Si une mise à jour demande de nouvelles autorisations, un bandeau orange apparaît dans l'onglet Stream : un clic suffit pour les accorder.

---

## 🎥 Utilisation dans OBS

### Le panneau comme dock

1. Dans OBS Studio : **Docks → Docks de navigateur personnalisés…**
2. Nom : `GreenChat`, URL : `http://localhost:3500` → **Appliquer**.
3. Place le panneau où tu veux dans l'interface d'OBS.

### Les overlays (Sources → ＋ → Navigateur)

| Overlay | Adresse | Taille |
|---|---|---|
| 💬 Chat | `http://localhost:3500/overlay/chat.html` | 450 × 800 |
| 🔔 Alertes | `http://localhost:3500/overlay/alerts.html` | 1920 × 1080 (cocher « Contrôler l'audio via OBS ») |
| ⭐ Message mis en avant | `http://localhost:3500/overlay/highlight.html` | 1920 × 1080 |
| 📅 Planning | `http://localhost:3500/overlay/planning.html` (`?layout=compact` pour un bandeau 1920 × 200) | 1920 × 1080 |

Les réglages peuvent être forcés dans l'adresse, par exemple `chat.html?fontSize=28&hideAfter=30` ou `highlight.html?position=bottom-center`.
Le style de tous les overlays se personnalise dans `public/css/overlay-custom.css`.
Le **mode démo** (Réglages) génère un faux chat pour régler les overlays hors live.
Pendant un **chat partagé**, l'overlay chat affiche les messages des chaînes partenaires avec leur pastille (`chat.html?showShared=0` pour les masquer). Les abos, bits et raids des partenaires ne déclenchent jamais tes alertes.

---

## ⌨️ Commandes du chat

À taper dans la zone de message de l'onglet Chat :

| Modération | Modes du chat | Stream |
|---|---|---|
| `/timeout pseudo 10m raison` | `/slow 30` · `/slowoff` | `/raid pseudo` · `/unraid` |
| `/ban pseudo raison` | `/followers 10m` · `/followersoff` | `/commercial 60` |
| `/unban pseudo` | `/subscribers` · `/subscribersoff` | `/marker texte` |
| `/warn pseudo raison` | `/emoteonly` · `/emoteonlyoff` | `/clip` |
| `/mod` · `/unmod pseudo` | `/uniquechat` · `/uniquechatoff` | `/so pseudo` |
| `/vip` · `/unvip pseudo` | `/shieldmode` · `/shieldmodeoff` | `/announce message` (`/announceblue`, `green`, `orange`, `purple`) |
| `/clear` | | `/me action` |

---

## 🛠️ Dépannage

| Problème | Solution |
|---|---|
| La page ne s'ouvre pas depuis un autre PC (délai dépassé) | Autorise le port 3500 dans le pare-feu du PC qui fait tourner GreenChat (profil **Privé**). |
| Firefox affiche `SSL_ERROR_RX_RECORD_TOO_LONG` | Tape l'adresse avec **`http://`** : GreenChat ne fonctionne pas en https. |
| Un type d'événement n'arrive pas | **Réglages → Compte Twitch → Événements Twitch reçus (diagnostic)** : chaque abonnement y est affiché avec ✅ ou ❌ et la raison. |
| Sondages, prédictions ou pubs refusés | Ces fonctions demandent une chaîne **affiliée ou partenaire** et le compte du streamer. |

---

## 📁 Structure du projet

```
greenchat/
├── server.js            Serveur : chat Twitch (IRC), EventSub, API Twitch, WebSocket vers les pages
├── start.bat            Lancement en double-clic (installe les dépendances au besoin)
├── package.json
├── public/
│   ├── index.html       Panneau de contrôle
│   ├── js/              app.js (panneau), common.js (partagé avec les overlays)
│   ├── css/             app.css, overlay-custom.css
│   └── overlay/         chat, alerts, highlight, planning
├── LICENSE              Licence MIT
└── data/                Créé au premier lancement, jamais publié (voir .gitignore)
```

> 🔒 `data/config.json` contient ton jeton Twitch. Ne le partage jamais : il est exclu du dépôt par le `.gitignore`.

---

## 🗺️ Feuille de route

- [ ] Installateur Windows (`GreenChat-Setup.exe`) avec icône près de l'horloge et démarrage automatique
- [x] Assistant de première configuration
- [ ] Vue « dock » compacte pour les panneaux étroits d'OBS
- [ ] Pilotage d'OBS via obs-websocket (changement de scène sur raid ou pub…)

---

## 📄 Licence

GreenChat est distribué sous **licence MIT** : tu peux l'utiliser, le modifier et le partager librement, à condition de garder la mention de copyright. Voir [LICENSE](LICENSE).

---

*Twitch est une marque de Twitch Interactive, Inc. GreenChat n'est ni affilié ni approuvé par Twitch.*
