import { cors, db, dropbox, google, json, parLots } from "../_shared/commun.ts";

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
    const { data: signatures } = await db.from("signatures").select("id, nom").order("ordre");
    const { data: dropbox_comptes } = await db.from("comptes_dropbox").select("email, nom");
    return { session: s.email, comptes, processus, compteurs: nb, signatures, dropbox: dropbox_comptes ?? [] };
  },

  // Liste par conversations, comme la boîte de réception Gmail.
  async fils(b) {
    const compte = b.compte as string;
    const p = new URLSearchParams({ maxResults: String(b.max ?? 50), q: b.q ?? "in:inbox category:primary" });
    if (b.pageToken) p.set("pageToken", b.pageToken);
    const r = await google(compte, `${GM}/threads?${p}`);
    const ids: string[] = (r.threads ?? []).map((t: any) => t.id);
    const fils = await parLots(ids, 8, async (id) => {
      const t = await google(compte,
        `${GM}/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
      const msgs = t.messages ?? [];
      const dernier = msgs[msgs.length - 1] ?? {};
      const h = dernier.payload?.headers ?? [];
      const labels = new Set<string>(msgs.flatMap((m: any) => m.labelIds ?? []));
      const noms: string[] = [];
      for (const m of msgs) {
        const de = entete(m.payload?.headers ?? [], "From").replace(/<.*>/, "").replace(/"/g, "").trim();
        const court = de.split(/\s+/)[0] || de;
        if ((m.labelIds ?? []).includes("SENT")) { if (!noms.includes("moi")) noms.push("moi"); }
        else if (court && !noms.includes(court)) noms.push(court);
      }
      return {
        id: dernier.id,
        thread_id: id,
        expediteur: entete(h, "From"),
        participants: noms,
        nb: msgs.length,
        destinataires: entete(h, "To"),
        objet: entete(msgs[0]?.payload?.headers ?? [], "Subject") || entete(h, "Subject"),
        date: new Date(Number(dernier.internalDate)).toISOString(),
        extrait: dernier.snippet,
        labels: [...labels],
        non_lu: labels.has("UNREAD"),
        suivi: labels.has("STARRED"),
        important: labels.has("IMPORTANT"),
      };
    });
    const { data: classes } = await db.from("messages").select("thread_id, processus_id").in("thread_id", ids);
    const idx = Object.fromEntries((classes ?? []).map((c) => [c.thread_id, c.processus_id]));
    return {
      messages: fils.map((f) => ({ ...f, processus_id: idx[f.thread_id] ?? null })),
      pageToken: r.nextPageToken ?? null,
    };
  },

  // Compteurs « nouveaux » des onglets de la réception.
  async compteurs_onglets(b) {
    const cats = ["primary", "promotions", "social", "updates", "forums"];
    const res: Record<string, number> = {};
    await parLots(cats, 2, async (c) => {
      const r = await google(b.compte, `${GM}/threads?maxResults=100&q=${encodeURIComponent(`in:inbox category:${c} is:unread`)}`);
      res[c] = (r.threads ?? []).length;
    });
    return res;
  },

  // Conversation complète.
  async fil(b) {
    const t = await google(b.compte, `${GM}/threads/${b.thread_id}?format=full`);
    // Brouillons du fil : on retrouve l'identifiant de brouillon (nécessaire pour l'envoyer).
    const brouillons: Record<string, string> = {};
    if ((t.messages ?? []).some((m: any) => (m.labelIds ?? []).includes("DRAFT"))) {
      const d = await google(b.compte, `${GM}/drafts?maxResults=200`);
      for (const x of d.drafts ?? []) if (x.message?.threadId === t.id) brouillons[x.message.id] = x.id;
    }
    return {
      thread_id: t.id,
      messages: (t.messages ?? []).map((m: any) => {
        const out = { html: "", texte: "", pj: [] as any[] };
        analyser(m.payload, out);
        const h = m.payload?.headers ?? [];
        return {
          id: m.id,
          expediteur: entete(h, "From"),
          destinataires: entete(h, "To"),
          cc: entete(h, "Cc"),
          objet: entete(h, "Subject"),
          date: new Date(Number(m.internalDate)).toISOString(),
          extrait: m.snippet,
          non_lu: (m.labelIds ?? []).includes("UNREAD"),
          html: out.html,
          texte: out.texte,
          pieces_jointes: out.pj,
          brouillon: (m.labelIds ?? []).includes("DRAFT"),
          draft_id: brouillons[m.id] ?? null,
        };
      }),
    };
  },

  // Envoi d'un brouillon existant (préparé par Courrier ou dans Gmail), à la demande de l'utilisateur.
  async envoyer_brouillon(b) {
    const r = await google(b.compte, `${GM}/drafts/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.draft_id }),
    });
    await db.from("journal").insert({ type: "envoi", message_id: r.id, details: { draft_id: b.draft_id, depuis: "Courrier" } });
    return { ok: true, id: r.id };
  },

  // Change (ou retire) la signature d'un brouillon : on réécrit le brouillon avec la nouvelle signature.
  async changer_signature(b) {
    const d = await google(b.compte, `${GM}/drafts/${b.draft_id}?format=full`);
    const m = d.message;
    const out = { html: "", texte: "", pj: [] as any[] };
    analyser(m.payload, out);
    if (out.pj.length) throw new Error("Ce brouillon contient des pièces jointes : changez la signature dans Gmail ou Mimestream.");
    let html = out.html || `<div>${out.texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`;
    const { data: sig } = b.signature_id ? await db.from("signatures").select("html").eq("id", b.signature_id).maybeSingle() : { data: null };
    const bloc = `<div class="courrier-signature">${sig?.html ? "<br>" + sig.html : ""}</div>`;
    const re = /<div class="courrier-signature">[\s\S]*?<\/div>/;
    if (re.test(html)) html = html.replace(re, bloc);
    else if (html.includes('<div class="gmail_quote"')) html = html.replace('<div class="gmail_quote"', bloc + '<br><div class="gmail_quote"');
    else html += bloc;
    const h = m.payload?.headers ?? [];
    const enc = (v: string) => /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=`;
    const lignes = ["From", "To", "Cc", "Bcc", "Subject", "In-Reply-To", "References"]
      .map((n) => [n, entete(h, n)]).filter(([, v]) => v).map(([n, v]) => `${n}: ${n === "Subject" ? enc(v) : v}`);
    const raw = [...lignes, "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", html].join("\r\n");
    const bytes = new TextEncoder().encode(raw); let bin = ""; for (const x of bytes) bin += String.fromCharCode(x);
    await google(b.compte, `${GM}/drafts/${b.draft_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.draft_id, message: { threadId: m.threadId, raw: btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") } }),
    });
    return { ok: true };
  },

  // Suppression d'un brouillon, à la demande de l'utilisateur.
  async supprimer_brouillon(b) {
    await google(b.compte, `${GM}/drafts/${b.draft_id}`, { method: "DELETE" });
    await db.from("journal").insert({ type: "brouillon_supprime", details: { draft_id: b.draft_id, depuis: "Courrier" } });
    return { ok: true };
  },

  // ---------- Rangement des pièces jointes dans Drive ----------
  // Sous-dossiers d'un dossier (parent = "root", "partages" ou un identifiant), ou recherche par nom.
  async drive_dossiers(b) {
    const { data: rec } = await db.from("parametres").select("valeur").eq("cle", "drive_recents").maybeSingle();
    const recents = JSON.parse(rec?.valeur ?? "[]");
    // Dropbox : compte « dropbox:<email> », dossiers désignés par leur chemin ("" = racine).
    if (String(b.compte).startsWith("dropbox:")) {
      const email = b.compte.slice(8);
      let entrees: any[];
      if (b.recherche) {
        const r = await dropbox(email, "files/search_v2", { query: b.recherche, options: { file_categories: [{ ".tag": "folder" }], max_results: 100 } });
        entrees = (r.matches ?? []).map((x: any) => x.metadata?.metadata).filter(Boolean);
      } else {
        const r = await dropbox(email, "files/list_folder", { path: b.parent === "root" ? "" : b.parent, limit: 2000 });
        entrees = r.entries ?? [];
      }
      const dossiers = entrees.filter((x) => x[".tag"] === "folder")
        .map((x) => ({ id: x.path_lower, name: x.name })).sort((x, y) => x.name.localeCompare(y.name, "fr"));
      return { dossiers, recents };
    }
    const DOSSIER = "mimeType='application/vnd.google-apps.folder' and trashed=false";
    const q = b.recherche
      ? `${DOSSIER} and name contains '${String(b.recherche).replace(/\\/g, "").replace(/'/g, "\\'")}'`
      : b.parent === "partages" ? `${DOSSIER} and sharedWithMe=true`
      : `${DOSSIER} and '${b.parent ?? "root"}' in parents`;
    const p = new URLSearchParams({
      q, orderBy: "name", pageSize: "200", fields: "files(id,name,folderColorRgb)",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    const r = await google(b.compte, `https://www.googleapis.com/drive/v3/files?${p}`);
    return { dossiers: r.files ?? [], recents };
  },

  // Crée un sous-dossier (Drive ou Dropbox) et renvoie son identifiant.
  async creer_dossier(b) {
    const nom = String(b.nom ?? "").trim();
    if (!nom) throw new Error("Nom de dossier vide.");
    if (String(b.compte).startsWith("dropbox:")) {
      const parent = b.parent === "root" ? "" : b.parent;
      const r = await dropbox(b.compte.slice(8), "files/create_folder_v2", { path: `${parent}/${nom}`, autorename: false });
      return { id: r.metadata.path_lower, name: r.metadata.name };
    }
    const f = await google(b.compte, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nom, mimeType: "application/vnd.google-apps.folder", parents: [b.parent ?? "root"] }),
    });
    return { id: f.id, name: f.name };
  },

  // Copie une pièce jointe Gmail dans un dossier Drive (éventuellement d'un autre compte).
  async ranger_pj(b) {
    const pj = await google(b.compte, `${GM}/messages/${b.message_id}/attachments/${b.attachment_id}`);
    const bin = atob(pj.data.replace(/-/g, "+").replace(/_/g, "/"));
    const octets = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    let lien: string | null = null, fichierId: string;
    if (String(b.drive_compte).startsWith("dropbox:")) {
      // Dropbox : renommage automatique si un fichier du même nom existe déjà.
      const f = await dropbox(b.drive_compte.slice(8), "files/upload",
        { path: `${b.dossier_id}/${b.nom}`, mode: "add", autorename: true, mute: true }, octets);
      fichierId = f.id;
    } else {
    const limite = "courrier" + crypto.randomUUID();
    const enc = new TextEncoder();
    const debut = enc.encode(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: b.nom, parents: [b.dossier_id] }) +
      `\r\n--${limite}\r\nContent-Type: ${b.mime || "application/octet-stream"}\r\n\r\n`);
    const fin = enc.encode(`\r\n--${limite}--`);
    const corps = new Uint8Array(debut.length + octets.length + fin.length);
    corps.set(debut, 0); corps.set(octets, debut.length); corps.set(fin, debut.length + octets.length);
    const f = await google(b.drive_compte,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink", {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${limite}` }, body: corps,
      });
    lien = f.webViewLink; fichierId = f.id;
    }
    // Dossiers récents (8 au plus), pour les proposer en premier la fois suivante.
    const { data } = await db.from("parametres").select("valeur").eq("cle", "drive_recents").maybeSingle();
    const recents = [{ compte: b.drive_compte, id: b.dossier_id, nom: b.dossier_nom },
      ...JSON.parse(data?.valeur ?? "[]").filter((x: any) => x.id !== b.dossier_id)].slice(0, 8);
    await db.from("parametres").upsert({ cle: "drive_recents", valeur: JSON.stringify(recents) });
    await db.from("journal").insert({ type: "rangement_drive", message_id: b.message_id,
      details: { fichier: b.nom, compte: b.drive_compte, dossier: b.dossier_nom, fichier_id: fichierId } });
    return { ok: true, lien };
  },

  // Fichiers de suivi (Google Sheets) alimentés par les règles.
  async fichiers() {
    const { data } = await db.from("parametres").select("cle, valeur").like("cle", "sheet:%");
    return { fichiers: (data ?? []).map((x) => ({ nom: x.cle.slice(6), url: `https://docs.google.com/spreadsheets/d/${x.valeur}/edit` }))
      .sort((a, b) => a.nom.localeCompare(b.nom)) };
  },

  async fil_lu(b) {
    await google(b.compte, `${GM}/threads/${b.thread_id}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    });
    return { ok: true };
  },

  async suivre(b) {
    await google(b.compte, `${GM}/threads/${b.thread_id}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b.oui ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] }),
    });
    return { ok: true };
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
