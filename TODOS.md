# PerfGuard — TODO

## Intégrations fournisseurs de preview

PerfGuard supporte actuellement : Netlify, Vercel, Cloudflare Pages.

### À faire

- [x] **Render** — `deployment_status`, turnkey, ~4,5M devs. Détection via `target_url` contenant `.onrender.com`.
- [x] **Railway** — L'URL preview est dans le commentaire du bot `railway-app` (`issue_comment` event, actions `created` et `edited`). Détection via regex `*.up.railway.app`. Le bot édite son commentaire plusieurs fois pendant le build : traitement déclenché uniquement quand le commentaire contient `✅`. Déduplication par `prNumber + sha` via `seenRailwayDeployments`.
- [ ] **AWS Amplify** — `deployment_status` mais l'URL de preview est dans un commentaire PR (pas dans `target_url`). Nécessite un handler dédié. Priorité moyenne.

### Déprioritisé

- **Fly.io** — pas turnkey, nécessite une GitHub Action manuelle pour les previews.
- **Northflank / Bunnyshell** — niches spécialisées microservices, audience trop réduite.
