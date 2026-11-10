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
  "manuel.zacklad@gmail.com,manuel.zacklad.cnam@gmail.com")
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
    throw new Error(`Google ${r.status} : ${txt.slice(0, 300)}`);
  }
  return r.status === 204 ? null : r.json();
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
