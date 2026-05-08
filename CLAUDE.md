# CLAUDE.md — ComfyUI Market

## Projet

**Nom :** ComfyUI Market  
**Domaine :** `linkvault.fun`  
**Objectif :** Marketplace serverless permettant aux créateurs de vendre leurs workflows ComfyUI (fichiers `.json`, `.zip`, `.png`). Le créateur uploade un fichier, fixe un prix, reçoit un lien de paiement. L'acheteur paie et télécharge le fichier.

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Frontend | HTML5 vanilla + Tailwind CSS (CDN) + Chart.js (CDN) |
| Backend | Netlify Functions (Node.js serverless) |
| Base de données | Supabase (PostgreSQL) |
| Stockage fichiers | Supabase Storage (bucket privé `private_uploads`) |
| Auth créateur | Fanvue OAuth 2.0 + PKCE |
| Hébergement | Netlify |
| Protection dashboard | HTTP Basic Auth via `_headers` |

**Dépendances npm :**
- `@supabase/supabase-js` ^2.91.1
- `busboy` ^1.6.0 (parsing multipart/form-data)
- `cookie` ^0.6.0 (gestion des cookies)

---

## Architecture des fichiers

```
/
├── index.html              Page principale — upload + génération de lien
├── unlock.html             Page acheteur — paiement + téléchargement
├── dashboard.html          Dashboard créateur — stats et transactions
├── logo.png / logo.svg
├── _headers                Basic Auth Netlify (protège /dashboard.html)
├── netlify.toml            Config build Netlify
├── package.json            Dépendances Node.js
│
├── netlify/
│   └── functions/          Source des fonctions serverless
│       ├── upload.js
│       ├── create-checkout.js
│       ├── get-link.js
│       ├── auth-login.js
│       ├── auth-callback.js
│       ├── get-fanvue-stats.js
│       ├── get-fanvue-data.js
│       └── login.js
│
└── .netlify/
    └── functions/          Fonctions compilées (auto-généré, ne pas éditer)
```

---

## Pages HTML

| Page | Accès | Rôle |
|------|-------|------|
| `index.html` | Public | Upload de fichier, saisie du prix, affichage du lien généré |
| `unlock.html` | Public via `/l/{slug}` | Affiche le produit, déclenche le paiement, affiche le lien de téléchargement |
| `dashboard.html` | Basic Auth | Analytics : ventes, revenus, transactions, top acheteurs, graphique Chart.js. Charge les données démo immédiatement, puis remplace avec les données live Fanvue via `get-fanvue-data`. Badge "Live" (vert) ou "Démo" (jaune) dans la nav. |

**Routing Netlify (`netlify.toml`) :**
- `/l/*` → `unlock.html` (status 200, SPA-style)
- `/api/*` → `/.netlify/functions/:splat`

---

## Fonctions Netlify

| Fichier | Route | Méthode | Rôle |
|---------|-------|---------|------|
| `upload.js` | `POST /api/upload` | POST | Reçoit le fichier (busboy), génère un slug unique, stocke dans Supabase Storage + DB |
| `create-checkout.js` | `POST /api/create-checkout` | POST | Simule le paiement, marque `is_paid = true` en DB |
| `get-link.js` | `GET /api/get-link?slug=` | GET | Retourne les infos produit + URL signée (1h) si payé |
| `auth-login.js` | `GET /api/auth-login` | GET | Initie le flux OAuth Fanvue (PKCE — génère verifier + state) |
| `auth-callback.js` | `GET /api/auth-callback?code=` | GET | Callback OAuth, échange le code contre les tokens, stocke en DB |
| `get-fanvue-stats.js` | `GET /api/get-fanvue-stats` | GET | Récupère les stats Fanvue (revenus, abonnés) avec refresh token auto |
| `get-fanvue-data.js` | `GET /api/get-fanvue-data` | GET | Agrège toutes les données Fanvue : transactions paginées, top spenders, calcul des stats. Retourne `{ connected: false }` si non authentifié. |
| `login.js` | — | — | Authentification interne (usage à confirmer) |

**Pattern de base de chaque fonction :**
```js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event, context) => {
  // ...
  return { statusCode: 200, body: JSON.stringify({ ... }) };
};
```

---

## Schéma Supabase

### Table `products`

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | uuid | Clé primaire |
| `filename` | text | Nom de fichier sanitisé |
| `file_path` | text | Chemin dans Supabase Storage |
| `original_name` | text | Nom original du fichier uploadé |
| `price` | numeric | Prix en euros/$ fixé par le créateur |
| `slug` | text | Identifiant unique de l'URL (`/l/{slug}`) |
| `description` | text | Description optionnelle |
| `is_paid` | boolean | `true` si le paiement a été effectué |

### Table `app_settings`

Stockage clé-valeur pour les tokens OAuth :

| `key` | Contenu |
|-------|---------|
| `fanvue_access_token` | Token d'accès Fanvue |
| `fanvue_refresh_token` | Token de rafraîchissement Fanvue |

### Bucket Storage

- **`private_uploads`** — Privé, accès uniquement via URL signées (durée 1h)

---

## Variables d'environnement

À définir dans le dashboard Netlify (onglet *Environment Variables*) :

| Variable | Rôle |
|----------|------|
| `SUPABASE_URL` | URL du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé admin Supabase (service role, pas la clé publique) |
| `FANVUE_CLIENT_ID` | ID client OAuth Fanvue |
| `FANVUE_CLIENT_SECRET` | Secret client OAuth Fanvue |
| `REDIRECT_URI` | URI de callback OAuth (ex: `https://linkvault.fun/.netlify/functions/auth-callback`) |

---

## Authentification & sécurité

### Dashboard — Basic Auth
- Configuré dans `_headers` (header `Basic-Auth`)
- Protège uniquement `/dashboard.html`
- Credentials encodés en base64 dans le fichier `_headers`

### OAuth Fanvue (créateur)
- Flux OAuth 2.0 avec PKCE
- `auth-login.js` génère un `code_verifier` et un `state`, les stocke en cookie HttpOnly (expiry 5 min)
- `auth-callback.js` valide le state, échange le code, stocke les tokens dans `app_settings`
- `get-fanvue-stats.js` gère le refresh automatique du token expiré
- `get-fanvue-data.js` agrège toutes les données (transactions paginées `/insights/earnings`, top spenders `/insights/fans/top-spenders`) et gère aussi le refresh token

### Fichiers privés
- Stockés dans le bucket `private_uploads` (accès interdit sans signature)
- `get-link.js` génère une URL signée valable 1h seulement après confirmation `is_paid = true`

---

## Conventions de code

- **Nommage fichiers :** kebab-case (`auth-callback.js`, `create-checkout.js`)
- **Slugs produits :** chaîne alphanumérique aléatoire, générée dans `upload.js`
- **Async/await** partout, avec blocs `try/catch`
- **Supabase client** instancié en dehors du handler (optimisation cold start Lambda)
- **Réponses HTTP :** toujours `{ statusCode, body: JSON.stringify(...) }`
- **CORS :** à vérifier si l'API est appelée depuis un autre domaine

### UI (pages HTML)
- Design dark-first, grain texture overlay
- Composants glass (blur + transparence)
- Tailwind CSS via CDN (pas de build step)
- Material Icons (Google Fonts CDN)
- Pas de framework JS — tout en vanilla JS

---

## Déploiement

```toml
# netlify.toml
[build]
  publish = "."              # Racine = site statique
  functions = "netlify/functions"

[dev]
  framework = "#static"
```

- **Déploiement :** push sur la branche principale → Netlify déploie automatiquement
- **Fonctions :** compilées automatiquement depuis `netlify/functions/` vers `.netlify/functions/`
- **Ne jamais committer** `.netlify/functions/` (fichiers compilés, auto-générés)

---

## Points d'attention

1. **`SUPABASE_SERVICE_ROLE_KEY`** — Clé admin, ne jamais l'exposer côté client.
2. **`REDIRECT_URI` hardcodé** dans `auth-callback.js` (`https://linkvault.fun/...`) — penser à le mettre en variable d'env si on change de domaine.
3. **`create-checkout.js` simule le paiement** — en production, remplacer par une vraie intégration Stripe (webhook de confirmation).
4. **`dashboard.custom.bak.html`** — fichier de backup, ne pas déployer en production ni y toucher sans vérifier.
5. **`.netlify/functions/`** — ne pas éditer manuellement, ces fichiers sont générés par Netlify CLI.
6. **Basic Auth en clair dans `_headers`** — si les credentials changent, mettre à jour ce fichier ET pousser.
