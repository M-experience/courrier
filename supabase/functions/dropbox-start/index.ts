import { DBX_KEY, DBX_REDIRECT, db, ORIGINES } from "../_shared/commun.ts";

// GET /dropbox-start?session=<jeton Courrier>&retour=<origine> : lance l'autorisation Dropbox.
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const retour = u.searchParams.get("retour") ?? ORIGINES[0];
  const session = u.searchParams.get("session");
  if (!ORIGINES.some((o) => retour.startsWith(o))) return new Response("Origine de retour non autorisée", { status: 400 });
  const { data: s } = await db.from("sessions").select("token").eq("token", session ?? "").gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!s) return Response.redirect(`${retour}#erreur=${encodeURIComponent("Session Courrier expirée : reconnectez-vous puis recommencez.")}`, 302);
  if (!DBX_KEY) return Response.redirect(`${retour}#erreur=${encodeURIComponent("Le secret DROPBOX_APP_KEY n'est pas encore enregistré dans Supabase.")}`, 302);
  const etat = crypto.randomUUID();
  await db.from("oauth_etats").insert({ etat, session_token: JSON.stringify({ session, retour, fournisseur: "dropbox" }) });
  const p = new URLSearchParams({ client_id: DBX_KEY, response_type: "code", redirect_uri: DBX_REDIRECT, token_access_type: "offline", state: etat });
  return Response.redirect(`https://www.dropbox.com/oauth2/authorize?${p}`, 302);
});
