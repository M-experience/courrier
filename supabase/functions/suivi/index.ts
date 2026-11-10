import { db, google, json, parLots } from "../_shared/commun.ts";

// Suivi des échanges d'un « flux » (par exemple la paie EDM avec Efficience Paie) :
// chaque conversation est analysée par Claude et rangée dans une colonne du Kanban.
// Appelé par pg_cron (en-tête x-cle) ; ne réanalyse que les conversations qui ont changé.

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PAR_PASSAGE = 30;

function entete(h: any[] = [], nom: string) {
  return h.find((x) => x.name.toLowerCase() === nom.toLowerCase())?.value ?? "";
}
function decoder(b64: string) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function texte(part: any): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decoder(part.body.data);
  for (const p of part.parts ?? []) { const t = texte(p); if (t) return t; }
  if (part.mimeType === "text/html" && part.body?.data) return decoder(part.body.data).replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return "";
}
// Retire les citations des messages précédents (« Le … a écrit : », lignes « > »).
function sansCitation(t: string) {
  const coupes = [/\n\s*Le .{5,120}a écrit\s*:/i, /\n\s*On .{5,120}wrote:/i, /\n-{2,}\s*Original Message/i, /\nDe\s*:\s.*\nEnvoyé\s*:/i, /\nFrom:\s.*\nSent:/i];
  let fin = t.length;
  for (const re of coupes) { const m = t.search(re); if (m > 0 && m < fin) fin = m; }
  return t.slice(0, fin).split("\n").filter((l) => !l.trim().startsWith(">")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TYPES = ["Déclaration nouveau salarié", "Contrat", "Paie du mois", "Demande d'un salarié", "Administratif", "Autre"];

async function analyser(contexte: string, fil: any, autres: string) {
  const cle = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!cle) return null;
  const msgs = (fil.messages ?? []).filter((m: any) => !(m.labelIds ?? []).includes("DRAFT")).slice(-8);
  const corps = msgs.map((m: any) => {
    const h = m.payload?.headers ?? [];
    return `--- ${new Date(Number(m.internalDate)).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} | De : ${entete(h, "From")} | À : ${entete(h, "To")}${entete(h, "Cc") ? " | Cc : " + entete(h, "Cc") : ""}\n${sansCitation(texte(m.payload)).slice(0, 1800)}`;
  }).join("\n\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": cle, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-5-5", max_tokens: 2500,
      system: `${contexte}\n\nTu analyses une conversation e-mail pour mon tableau de suivi. Réponds uniquement par un objet JSON, sans texte autour.`,
      messages: [{ role: "user", content:
`Objet : ${entete(msgs[0]?.payload?.headers ?? [], "Subject")}

${corps}

Autres conversations récentes avec la même interlocutrice (pour repérer une réponse donnée ailleurs) :
${autres || "(aucune)"}

Renvoie un JSON avec les clés :
- "type" : l'une de ${JSON.stringify(TYPES)},
- "personne" : le salarié ou vacataire concerné (Prénom NOM), ou "" si aucun,
- "etat" : l'un de
   "a_traiter" (j'ai une action à faire : Stéphanie ou un salarié m'a posé une question, demande une information, un document ou une correction, et je n'y ai pas encore répondu ; « dossier incomplet », « à modifier », « il manque » en font partie),
   "attente_efficience" (j'ai envoyé, ou le Portail a envoyé, quelque chose qui demande une action de Stéphanie et elle ne l'a pas encore confirmée, ni ici ni dans une autre conversation),
   "attente_salarie" (j'attends une information d'un salarié ou d'un vacataire pour pouvoir avancer),
   "clos" (traité : Stéphanie a confirmé « c'est fait », « traité », « bien reçu », « à classer », ou simple échange de remerciements, ou notification sans suite),
- "resume" : une phrase en français sur l'objet et l'état du dossier,
- "action" : la prochaine action attendue et par qui, en quelques mots (ex. « Envoyer le code postal à Stéphanie »), ou "" si clos,
- "question" : si etat = "a_traiter", la question ou la demande en attente, reformulée brièvement ; sinon "".` }],
    }),
  });
  if (!r.ok) { console.error("Claude", r.status, (await r.text()).slice(0, 200)); return null; }
  const d = await r.json();
  const txt = (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try { return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)); } catch { return null; }
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const { data: p } = await db.from("parametres").select("valeur").eq("cle", "cle_cron").maybeSingle();
  if ((req.headers.get("x-cle") ?? u.searchParams.get("cle")) !== p?.valeur) return json({ erreur: "clé" }, 401);
  const tout = u.searchParams.has("tout"); // réanalyse forcée

  const { data: flux } = await db.from("suivi_flux").select("*").eq("actif", true);
  const rapport: Record<string, unknown> = {};
  for (const f of flux ?? []) {
    // Conversations du flux (jusqu'à 150), avec leur historyId pour repérer celles qui ont changé.
    const fils: any[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ q: f.requete, maxResults: "100" });
      if (page) q.set("pageToken", page);
      const r = await google(f.compte, `${GM}/threads?${q}`);
      fils.push(...(r.threads ?? []));
      page = r.nextPageToken;
    } while (page && fils.length < 150);

    const { data: connus } = await db.from("suivi_fils").select("thread_id, history_id, objet, dernier_message_at, dernier_expediteur, extrait, analyse_at").eq("flux", f.id);
    const idx = new Map((connus ?? []).map((c) => [c.thread_id, c]));
    // « tout » : réanalyse par lots, en commençant par les conversations analysées le plus anciennement
    // (utile après la première passe, pour profiter du contexte des autres conversations).
    const aTraiter = (tout
      ? [...fils].sort((x, y) => String(idx.get(x.id)?.analyse_at ?? "").localeCompare(String(idx.get(y.id)?.analyse_at ?? "")))
      : fils.filter((t) => idx.get(t.id)?.history_id !== t.historyId)).slice(0, MAX_PAR_PASSAGE);
    const autres = (connus ?? []).filter((c) => c.objet)
      .sort((a, b) => String(b.dernier_message_at).localeCompare(String(a.dernier_message_at))).slice(0, 60)
      .map((c) => `- ${String(c.dernier_message_at).slice(0, 10)} | ${c.objet} | dernier message de ${c.dernier_expediteur} | ${String(c.extrait ?? "").slice(0, 120)}`).join("\n");

    let n = 0;
    await parLots(aTraiter, 4, async (t) => {
      const fil = await google(f.compte, `${GM}/threads/${t.id}?format=full`);
      const msgs = (fil.messages ?? []).filter((m: any) => !(m.labelIds ?? []).includes("DRAFT"));
      if (!msgs.length) return;
      const dernier = msgs[msgs.length - 1];
      const h = dernier.payload?.headers ?? [];
      const a = await analyser(f.contexte ?? "", fil, autres);
      await db.from("suivi_fils").upsert({
        flux: f.id, thread_id: t.id, compte: f.compte,
        objet: entete(msgs[0].payload?.headers ?? [], "Subject"),
        dernier_message_id: dernier.id,
        dernier_message_at: new Date(Number(dernier.internalDate)).toISOString(),
        dernier_expediteur: entete(h, "From").replace(/<.*>/, "").replace(/"/g, "").trim() || entete(h, "From"),
        nb_messages: msgs.length, history_id: t.historyId, extrait: dernier.snippet,
        ...(a ? { type: a.type, personne: a.personne, etat: a.etat, resume: a.resume, action: a.action, question: a.question, analyse_at: new Date().toISOString() } : {}),
        // Un nouveau message annule le classement manuel : l'analyse reprend la main.
        ...(idx.get(t.id)?.history_id !== t.historyId ? { etat_manuel: null } : {}),
      });
      n++;
    });
    rapport[f.id] = { conversations: fils.length, analysees: n, restantes: fils.filter((t) => idx.get(t.id)?.history_id !== t.historyId).length - n };
  }
  return json(rapport);
});
