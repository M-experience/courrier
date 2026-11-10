import { DBX_KEY, DBX_REDIRECT, DBX_SECRET, db, ORIGINES } from "../_shared/commun.ts";

// Retour de l'autorisation Dropbox : on enregistre les jetons, puis on revient dans Courrier.
Deno.serve(async (req) => {
  const u = new URL(req.url);
  let retour = ORIGINES[0];
  const erreur = (m: string) => Response.redirect(`${retour}#erreur=${encodeURIComponent(m)}`, 302);
  const etat = u.searchParams.get("state"), code = u.searchParams.get("code");
  const { data: e } = await db.from("oauth_etats").select("*").eq("etat", etat ?? "").maybeSingle();
  if (e) { await db.from("oauth_etats").delete().eq("etat", etat); retour = JSON.parse(e.session_token ?? "{}").retour ?? retour; }
  if (u.searchParams.get("error")) return erreur(`Autorisation Dropbox annulée : ${u.searchParams.get("error_description") ?? u.searchParams.get("error")}`);
  if (!e || !code) return erreur("Autorisation Dropbox incomplète ou expirée. Recommencez.");
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: DBX_REDIRECT, client_id: DBX_KEY, client_secret: DBX_SECRET }),
  });
  const t = await r.json();
  if (!r.ok) return erreur(`Dropbox refuse l'échange : ${t.error_description ?? t.error ?? r.status}`);
  const moi = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST", headers: { Authorization: `Bearer ${t.access_token}` },
  }).then((x) => x.json());
  await db.from("comptes_dropbox").upsert({
    email: String(moi.email ?? t.account_id).toLowerCase(), account_id: t.account_id, nom: moi.name?.display_name ?? null,
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in ?? 14400) * 1000).toISOString(),
  });
  await db.from("journal").insert({ type: "connexion_dropbox", details: { email: moi.email } });
  return Response.redirect(`${retour}#dropbox=ok`, 302);
});
