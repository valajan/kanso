# PerfGuard — TODO

## Intégrations fournisseurs de preview

PerfGuard supporte actuellement : Netlify, Vercel, Cloudflare Pages.

### À faire

- [x] **Render** — `deployment_status`, turnkey, ~4,5M devs. Détection via `target_url` contenant `.onrender.com`.
- [x] **Railway** — L'URL preview est dans le commentaire du bot `railway-app` (`issue_comment` event, actions `created` et `edited`). Détection via regex `*.up.railway.app`. Le bot édite son commentaire plusieurs fois pendant le build : traitement déclenché uniquement quand le commentaire contient `✅`. Déduplication par `prNumber + sha` via `seenRailwayDeployments`.
- [x] **AWS Amplify** — `check_run` event. L'URL preview (`*.amplifyapp.com`) est dans `check_run.details_url`, identifié par `check_run.name` contenant `"amplify"`. Handler mutualisé avec Cloudflare Pages. Repo GitHub doit être privé (condition Amplify pour les PR previews).

### Déprioritisé

- **Fly.io** — pas turnkey, nécessite une GitHub Action manuelle pour les previews.
- **Northflank / Bunnyshell** — niches spécialisées microservices, audience trop réduite.
