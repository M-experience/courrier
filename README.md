# Courrier

Application personnelle de traitement du courrier Gmail par processus (courrier.ricod.net).

- `index.html` : interface (GitHub Pages)
- `supabase/functions/` : fonctions serveur (projet Supabase `courrier-cadrans`)
  - `oauth-start`, `oauth-callback` : connexion Google et stockage des jetons
  - `api` : lecture des messages, classement par processus

Secrets Supabase requis : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
