import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export const CLIENT_ID = (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").trim();
export const CLIENT_SECRET = (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").trim();
export const REDIRECT_URI =
  `${Deno.env.get("SUPABASE_URL")}/functions/v1/oauth-callback`;

export const COMPTES_AUTORISES = (Deno.env.get("COMPTES_AUTORISES") ??
  "manuel.zacklad@gmail.com,manuel.zacklad.cnam@gmail.com,contact@ecole-edm.fr")
  .split(",").map((s) => s.trim().toLowerCase());

export const ORIGINES = [
  "https://courrier.ricod.net",
  "https://m-experience.github.io",
  "http://localhost:8000",
];

export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/drive",
].join(" ");

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-session, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Renvoie un jeton d'accès Google valide pour le compte, en le rafraîchissant si besoin. */
export async function jetonAcces(email: string): Promise<string> {
  const { data: c, error } = await db.from("comptes").select("*").eq("email", email).single();
  if (error || !c) throw new Error(`Compte inconnu : ${email}`);
  if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() > Date.now() + 60_000) {
    return c.access_token;
  }
  if (!c.refresh_token) throw new Error(`Compte ${email} à reconnecter`);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: c.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`Rafraîchissement refusé pour ${email} : ${t.error ?? r.status}`);
  const expires_at = new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString();
  await db.from("comptes").update({ access_token: t.access_token, expires_at }).eq("email", email);
  return t.access_token;
}

export async function google(email: string, url: string, init: RequestInit = {}, essai = 0): Promise<any> {
  const token = await jetonAcces(email);
  const r = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if ((r.status === 429 || r.status >= 500) && essai < 4) {
    await new Promise((ok) => setTimeout(ok, 500 * 2 ** essai + Math.random() * 300));
    return google(email, url, init, essai + 1);
  }
  if (!r.ok) {
    const txt = await r.text();
    // Quota Gmail par minute dépassé (403) : on patiente puis on réessaie (3 s, 6 s, 12 s, 24 s).
    if (r.status === 403 && /Quota exceeded|rateLimitExceeded|userRateLimitExceeded/.test(txt) && essai < 4) {
      await new Promise((ok) => setTimeout(ok, 3000 * 2 ** essai + Math.random() * 1000));
      return google(email, url, init, essai + 1);
    }
    throw new Error(`Google ${r.status} : ${txt.slice(0, 300)}`);
  }
  return r.status === 204 ? null : r.json();
}

// ---------- Dropbox ----------
export const DBX_KEY = (Deno.env.get("DROPBOX_APP_KEY") ?? "").trim();
export const DBX_SECRET = (Deno.env.get("DROPBOX_APP_SECRET") ?? "").trim();
export const DBX_REDIRECT = `${Deno.env.get("SUPABASE_URL")}/functions/v1/dropbox-callback`;

async function jetonDropbox(email: string): Promise<string> {
  const { data: c } = await db.from("comptes_dropbox").select("*").eq("email", email).single();
  if (!c) throw new Error(`Compte Dropbox inconnu : ${email}`);
  if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() > Date.now() + 60_000) return c.access_token;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: DBX_KEY, client_secret: DBX_SECRET }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`Dropbox refuse le rafraîchissement : ${t.error_description ?? t.error ?? r.status}`);
  await db.from("comptes_dropbox").update({ access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in ?? 14400) * 1000).toISOString() }).eq("email", email);
  return t.access_token;
}

// Appel à l'API Dropbox (JSON), ou envoi de contenu si « octets » est fourni.
export async function dropbox(email: string, route: string, arg: unknown, octets?: Uint8Array): Promise<any> {
  const token = await jetonDropbox(email);
  // L'en-tête Dropbox-API-Arg doit être en ASCII : les caractères accentués sont échappés.
  const argAscii = JSON.stringify(arg).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const r = octets
    ? await fetch(`https://content.dropboxapi.com/2/${route}`, { method: "POST", body: octets,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": argAscii } })
    : await fetch(`https://api.dropboxapi.com/2/${route}`, { method: "POST", body: arg === null ? undefined : JSON.stringify(arg),
        headers: { Authorization: `Bearer ${token}`, ...(arg === null ? {} : { "Content-Type": "application/json" }) } });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Dropbox ${r.status} : ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

/** Exécute des tâches avec un nombre limité d'appels simultanés (quota Gmail). */
export async function parLots<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await f(items[k]); }
  }));
  return res;
}
