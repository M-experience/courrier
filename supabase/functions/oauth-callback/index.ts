import { CLIENT_ID, CLIENT_SECRET, COMPTES_AUTORISES, db, ORIGINES, REDIRECT_URI } from "../_shared/commun.ts";

let RETOUR = ORIGINES[0];

// Les fonctions Supabase ne servent pas de HTML : on renvoie l'erreur à l'application.
function page(msg: string, _status = 400) {
  return Response.redirect(`${RETOUR}#erreur=${encodeURIComponent(msg)}`, 302);
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const etat = u.searchParams.get("state");
  if (u.searchParams.get("error")) return page(`Connexion annulée : ${u.searchParams.get("error")}`);
  if (!code || !etat) return page("Paramètres manquants.");

  const { data: e } = await db.from("oauth_etats").select("*").eq("etat", etat).single();
  if (!e) return page("État OAuth inconnu ou expiré. Recommencez la connexion.");
  await db.from("oauth_etats").delete().eq("etat", etat);
  const { session, retour } = JSON.parse(e.session_token ?? "{}");
  if (retour) RETOUR = retour;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const t = await r.json();
  if (!r.ok) return page(`Échange du code refusé par Google : ${t.error ?? r.status} ${t.error_description ?? ""}`);

  const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${t.access_token}` },
  }).then((x) => x.json());
  const email = String(ui.email ?? "").toLowerCase();
  if (!COMPTES_AUTORISES.includes(email)) {
    return page(`Le compte ${email} n'est pas autorisé dans Courrier.`, 403);
  }

  const ligne: Record<string, unknown> = {
    email,
    access_token: t.access_token,
    expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    role: email === "manuel.zacklad.cnam@gmail.com" ? "recrutement" : "principal",
  };
  if (t.refresh_token) ligne.refresh_token = t.refresh_token;
  await db.from("comptes").upsert(ligne);

  // Session : on réutilise celle qui a demandé l'ajout d'un compte, sinon on en crée une.
  let jeton = session as string | null;
  if (jeton) {
    const { data: s } = await db.from("sessions").select("token").eq("token", jeton)
      .gt("expires_at", new Date().toISOString()).maybeSingle();
    if (!s) jeton = null;
  }
  if (!jeton) {
    const { data: s } = await db.from("sessions").insert({ email }).select("token").single();
    jeton = s!.token;
  }
  await db.from("journal").insert({ type: "connexion", details: { email } });
  return Response.redirect(`${retour}#session=${jeton}`, 302);
});
