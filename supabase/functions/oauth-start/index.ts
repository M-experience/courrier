import { CLIENT_ID, db, ORIGINES, REDIRECT_URI, SCOPES } from "../_shared/commun.ts";

// GET /oauth-start?retour=<origine>&session=<jeton existant, pour ajouter un compte>&compte=<email suggéré>
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const retour = u.searchParams.get("retour") ?? ORIGINES[0];
  const session = u.searchParams.get("session");
  const compte = u.searchParams.get("compte") ?? "";
  if (!ORIGINES.some((o) => retour.startsWith(o))) {
    return new Response("Origine de retour non autorisée", { status: 400 });
  }
  const etat = crypto.randomUUID();
  await db.from("oauth_etats").insert({
    etat,
    session_token: JSON.stringify({ session, retour }),
  });
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: etat,
  });
  if (compte) p.set("login_hint", compte);
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
});
