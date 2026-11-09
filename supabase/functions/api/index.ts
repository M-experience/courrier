import { cors, db, google, json } from "../_shared/commun.ts";

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

type Corps = Record<string, any>;

async function verifierSession(req: Request) {
  const jeton = req.headers.get("x-session");
  if (!jeton) return null;
  const { data } = await db.from("sessions").select("email")
    .eq("token", jeton).gt("expires_at", new Date().toISOString()).maybeSingle();
  return data;
}

function entete(h: { name: string; value: string }[] = [], nom: string) {
  return h.find((x) => x.name.toLowerCase() === nom.toLowerCase())?.value ?? "";
}

function decoder(b64: string) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// Parcourt les parties MIME : corps HTML, corps texte, pièces jointes.
function analyser(part: any, out: { html: string; texte: string; pj: any[] }) {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.filename && part.body?.attachmentId) {
    out.pj.push({
      nom: part.filename,
      mime,
      taille: part.body.size,
      attachmentId: part.body.attachmentId,
    });
  } else if (mime === "text/html" && part.body?.data) {
    out.html += decoder(part.body.data);
  } else if (mime === "text/plain" && part.body?.data) {
    out.texte += decoder(part.body.data);
  }
  for (const p of part.parts ?? []) analyser(p, out);
}

async function resume(email: string, id: string) {
  const m = await google(
    email,
    `${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Delivered-To`,
  );
  const h = m.payload?.headers ?? [];
  return {
    id: m.id,
    thread_id: m.threadId,
    expediteur: entete(h, "From"),
    destinataires: entete(h, "To"),
    objet: entete(h, "Subject"),
    date: new Date(Number(m.internalDate)).toISOString(),
    extrait: m.snippet,
    labels: m.labelIds ?? [],
    non_lu: (m.labelIds ?? []).includes("UNREAD"),
  };
}

const actions: Record<string, (b: Corps, s: { email: string }) => Promise<unknown>> = {
  async moi(_b, s) {
    const [{ data: comptes }, { data: processus }] = await Promise.all([
      db.from("comptes").select("email, role, created_at"),
      db.from("processus").select("*").order("casquette").order("ordre"),
    ]);
    const { data: compteurs } = await db.from("messages").select("processus_id")
      .eq("statut", "nouveau");
    const nb: Record<string, number> = {};
    for (const m of compteurs ?? []) if (m.processus_id) nb[m.processus_id] = (nb[m.processus_id] ?? 0) + 1;
    return { session: s.email, comptes, processus, compteurs: nb };
  },

  async liste(b) {
    const compte = b.compte as string;
    const p = new URLSearchParams({ maxResults: String(b.max ?? 40), q: b.q ?? "in:inbox" });
    if (b.pageToken) p.set("pageToken", b.pageToken);
    const r = await google(compte, `${GM}/messages?${p}`);
    const ids: string[] = (r.messages ?? []).map((m: any) => m.id);
    const msgs = await Promise.all(ids.map((id) => resume(compte, id)));
    const { data: classes } = await db.from("messages").select("id, processus_id, statut").in("id", ids);
    const idx = Object.fromEntries((classes ?? []).map((c) => [c.id, c]));
    return {
      messages: msgs.map((m) => ({ ...m, processus_id: idx[m.id]?.processus_id ?? null, statut: idx[m.id]?.statut ?? null })),
      pageToken: r.nextPageToken ?? null,
    };
  },

  async processus_messages(b) {
    const { data } = await db.from("messages").select("*")
      .eq("processus_id", b.processus_id).order("date_reception", { ascending: false }).limit(100);
    return { messages: (data ?? []).map((m) => ({ ...m, date: m.date_reception, non_lu: false })) };
  },

  async message(b) {
    const m = await google(b.compte, `${GM}/messages/${b.id}?format=full`);
    const out = { html: "", texte: "", pj: [] as any[] };
    analyser(m.payload, out);
    const h = m.payload?.headers ?? [];
    return {
      id: m.id,
      thread_id: m.threadId,
      expediteur: entete(h, "From"),
      destinataires: entete(h, "To"),
      cc: entete(h, "Cc"),
      objet: entete(h, "Subject"),
      date: new Date(Number(m.internalDate)).toISOString(),
      livre_a: entete(h, "Delivered-To"),
      html: out.html,
      texte: out.texte,
      pieces_jointes: out.pj,
    };
  },

  async marquer_lu(b) {
    await google(b.compte, `${GM}/messages/${b.id}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    });
    return { ok: true };
  },

  async classer(b) {
    const m = await resume(b.compte, b.id);
    await db.from("messages").upsert({
      id: m.id,
      compte_email: b.compte,
      thread_id: m.thread_id,
      expediteur: m.expediteur,
      destinataires: m.destinataires,
      objet: m.objet,
      extrait: m.extrait,
      date_reception: m.date,
      labels: m.labels,
      processus_id: b.processus_id,
      statut: b.statut ?? "nouveau",
      maj_at: new Date().toISOString(),
    });
    await db.from("journal").insert({
      type: "classement",
      message_id: m.id,
      details: { processus_id: b.processus_id, manuel: true },
    });
    return { ok: true };
  },

  async statut(b) {
    await db.from("messages").update({ statut: b.statut, maj_at: new Date().toISOString() }).eq("id", b.id);
    return { ok: true };
  },

  async identites(b) {
    const r = await google(b.compte, `${GM}/settings/sendAs`);
    return { identites: (r.sendAs ?? []).map((x: any) => ({ email: x.sendAsEmail, nom: x.displayName, defaut: !!x.isDefault })) };
  },

  async deconnexion(b, _s) {
    await db.from("sessions").delete().eq("token", b._jeton);
    return { ok: true };
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const s = await verifierSession(req);
    if (!s) return json({ erreur: "session" }, 401);
    const b = await req.json().catch(() => ({}));
    b._jeton = req.headers.get("x-session");
    const f = actions[b.action];
    if (!f) return json({ erreur: `action inconnue : ${b.action}` }, 400);
    return json(await f(b, s));
  } catch (e) {
    return json({ erreur: String((e as Error).message ?? e) }, 500);
  }
});
