# Recap — parallélisation Lighthouse mobile + desktop

## Ce qui a changé

L'audit Lighthouse passe de **1 run mobile séquentiel** à **4 runs en parallèle**
(mobile + desktop × preview + prod), chacun isolé dans son propre worker thread
pour éviter la corruption du namespace `perf_hooks` (cause historique de la
contrainte « run sequentially » dans le runner).

Le commentaire PR rend désormais une **section Mobile** et une **section
Desktop**, chacune avec sa table de comparaison main vs PR. Le statut de commit
GitHub combine les deux form factors en prenant le pire niveau par métrique
(`fail > warn > pass`). L'AI analysis reçoit l'union des régressions
significatives (>10% sur l'un ou l'autre form factor) et le prompt distingue
chaque régression par son form factor.

## Architecture du flux

```
webhook → orchestrator
            │
            ├─ runLighthouse(preview, mobile)   ┐
            ├─ runLighthouse(preview, desktop)  │  Promise.allSettled
            ├─ runLighthouse(prod,    mobile)   │  (4 worker threads)
            └─ runLighthouse(prod,    desktop)  ┘
                      │
                      ▼
            scores = { mobile: { pr, ref }, desktop: { pr, ref } }
                      │
        ┌─────────────┼──────────────────┐
        ▼             ▼                  ▼
   formatComment  combineStatuses   detectSignificantRegressions
   (2 tables)     → commit status   (union mobile+desktop)
                                         │
                                         ▼
                                   analyzePerformanceRegression
                                   (1 appel OpenAI, prompt enrichi
                                    du form factor par régression)
```

## Fichiers modifiés / ajoutés

| Fichier | Changement |
|---|---|
| `src/lighthouse/runner.js` | Devient un thin wrapper qui spawn un `Worker` ; signature `runLighthouse(url, { formFactor })` |
| `src/lighthouse/runner.worker.js` *(nouveau)* | Exécution Lighthouse + chrome-launcher, presets desktop standard |
| `src/pipeline/orchestrator.js` | `Promise.allSettled` sur 4 audits, scores restructurés, `combineStatuses` worst-of |
| `src/report/comment.js` | `formatComment(scores, opts)` rend deux sections (📱 Mobile / 💻 Desktop) ; affiche `Lighthouse audit failed` si un form factor a échoué |
| `src/ai-analysis/index.js` | `detectSignificantRegressions` propage `formFactor` dans chaque entrée |
| `src/ai-analysis/prompt-builder.js` | Suffix `— 📱 mobile`/`— 💻 desktop` par régression, prompt expliquant qu'une métrique peut apparaître deux fois |
| `src/ai-analysis/report-formatter.js` | `formatPendingNote` déduplique les métriques |
| `src/report/__tests__/comment.test.js` | Nouvelle signature, nouveaux cas (sections, fallback audit raté) |
| `Dockerfile` *(nouveau)* | `node:20-slim` + Chromium + libs ; `CHROME_PATH` pointé sur `/usr/bin/chromium` |
| `.dockerignore` *(nouveau)* | Exclut `node_modules`, `.env`, `*.pem`, `workflows`, `__tests__`, etc. |

## Validation

- ✅ `npm test` — 73/73 passent
- ⚠️ **Non testé** : un run end-to-end avec un vrai webhook GitHub + Chrome.
  Les tests unitaires ne lancent pas Lighthouse réel. À valider avant prod.

## Next steps

### Avant le premier déploiement

1. **Test bout-en-bout local**
   ```bash
   npm run dev
   # Déclencher un webhook GitHub sur un repo de test, vérifier :
   # - les 4 audits tournent en parallèle (logs)
   # - le commentaire affiche bien Mobile + Desktop côte à côte
   # - le commit status est correct
   ```

2. **Build et test de l'image Docker en local**
   ```bash
   docker build -t kanso .
   docker run -p 8080:8080 --env-file .env -v $(pwd)/perfguard-dev.*.pem:/secrets/key.pem \
     -e GITHUB_PRIVATE_KEY_PATH=/secrets/key.pem kanso
   ```

3. **Déploiement Cloud Run** (4 vCPU obligatoire pour la vraie parallélisation)
   ```bash
   gcloud run deploy kanso-api \
     --source . \
     --region <region> \
     --cpu 4 --memory 4Gi \
     --port 8080 \
     --min-instances 0 \
     --max-instances 5 \
     --timeout 300s
   ```

4. **Secrets Cloud Run** : monter la clé privée GitHub comme secret, pas dans
   l'image.
   ```bash
   gcloud secrets create github-private-key --data-file=perfguard-dev.*.pem
   gcloud run services update kanso-api \
     --update-secrets=/secrets/github-key=github-private-key:latest \
     --set-env-vars=GITHUB_PRIVATE_KEY_PATH=/secrets/github-key
   ```

### Cleanup à faire

5. **Mettre à jour `CLAUDE.md`** : la section Architecture mentionne encore
   « sequential because parallel runs corrupt Node's `performance` namespace ».
   À remplacer par la nouvelle archi worker_threads.

6. **Supprimer la `.kanso.yml` côté repo client** si elle référence des
   commentaires anciens (rien à changer côté schéma, les budgets restent
   identiques pour mobile et desktop).

### Améliorations potentielles (post-MVP)

7. **Observabilité** : exposer la durée des 4 audits dans les logs structurés
   pour mesurer le gain réel vs séquentiel et détecter les contentions CPU sur
   Cloud Run.

8. **Coût AI** : si beaucoup de PR régressent sur les deux form factors,
   surveiller la taille des prompts (l'union double potentiellement le nombre
   de régressions à analyser, mais c'est 1 seul appel — pas de doublement de
   coût par appel).

9. **Budgets par form factor** : reporté volontairement (YAGNI). À ajouter le
   jour où un repo client demande des seuils desktop plus stricts que mobile.
   Le hook serait dans `mergeConfig` (`src/config/repo-config.js`) et
   `evaluateStatuses` (`src/metrics/status.js`).

10. **Stress test** : déclencher 2-3 PR simultanées sur Cloud Run pour valider
    que les 4 workers × N requêtes concurrentes ne saturent pas la machine.
    Si oui, baisser `max-instances` ou augmenter à 8 vCPU.
