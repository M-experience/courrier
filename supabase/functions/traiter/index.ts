import { db, google, json } from "../_shared/commun.ts";

// Traitement automatique : applique les règles actives aux nouveaux messages.
// Appelé toutes les 10 minutes par pg_cron (en-tête x-cle = parametres.cle_cron),
// ou manuellement avec ?simulation=1 pour voir ce qui serait fait sans rien écrire.

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEMANDE = /je me permets|je souhaite|je souhaiterais|serait-il possible|j.aimerais|je voudrais|pourriez-vous|je vous contacte|je vous ecris|\?/;
const CONTEXTE = ["candidat", "candidature", "admission", "intégrer", "integrer", "inscription", "inscrire", "rentrée", "rentree", "session", "formation continue", "vapp", "vae", "suivre", "parcours"];

function entete(h: any[] = [], nom: string) {
  return h.find((x) => x.name.toLowerCase() === nom.toLowerCase())?.value ?? "";
}
function decoder(b64: string) {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function texte(part: any): string {
  if (!part) return "";
  let t = "";
  if (part.mimeType === "text/plain" && part.body?.data) t += decoder(part.body.data);
  for (const p of part.parts ?? []) t += "\n" + texte(p);
  if (!t && part.mimeType === "text/html" && part.body?.data) t = decoder(part.body.data).replace(/<[^>]+>/g, " ");
  return t;
}
function norm(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function encoderEntete(s: string) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;
}

async function param(cle: string) {
  const { data } = await db.from("parametres").select("valeur").eq("cle", cle).maybeSingle();
  return data?.valeur ?? null;
}
async function setParam(cle: string, valeur: string) {
  await db.from("parametres").upsert({ cle, valeur });
}

const ENTETES_SHEET = ["Nom", "Prénom", "Date d'envoi", "Formation visée", "Profil", "Résumé de la demande", "E-mail", "Lien Gmail", "Avis après entretien"];

// Crée le Google Sheet de suivi (dans le dossier Drive indiqué) à la première utilisation.
async function fichierSheet(compte: string, nom: string, dossier?: string) {
  const cle = `sheet:${nom}`;
  const existant = await param(cle);
  if (existant) return existant;
  const f = await google(compte, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nom, mimeType: "application/vnd.google-apps.spreadsheet", ...(dossier ? { parents: [dossier] } : {}) }),
  });
  await google(compte, `https://sheets.googleapis.com/v4/spreadsheets/${f.id}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [
      { updateSheetProperties: { properties: { sheetId: 0, title: "Candidats", gridProperties: { frozenRowCount: 1 } }, fields: "title,gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    ] }),
  });
  await google(compte, `https://sheets.googleapis.com/v4/spreadsheets/${f.id}/values/Candidats!A1:append?valueInputOption=RAW`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [ENTETES_SHEET] }),
  });
  await setParam(cle, f.id);
  return f.id as string;
}

// Sépare nom et prénom à partir de l'en-tête From (« Prénom Nom » ou « NOM Prénom »).
function nomPrenom(nomComplet: string) {
  const p = nomComplet.trim().split(/\s+/);
  if (p.length < 2) return { nom: nomComplet, prenom: "" };
  const majuscules = p.filter((x) => x.length > 1 && x === x.toUpperCase() && /[A-Z]/.test(x));
  if (majuscules.length && majuscules.length < p.length) {
    return { nom: majuscules.join(" "), prenom: p.filter((x) => !majuscules.includes(x)).join(" ") };
  }
  return { prenom: p[0], nom: p.slice(1).join(" ") };
}

function formationVisee(objet: string, corps: string) {
  // L'objet prime : il dit le plus souvent ce que vise le candidat.
  const o = norm(objet), t = norm(`${objet}\n${corps}`);
  const cherche = (re: RegExp) => re.test(o) || re.test(t);
  const certif = cherche(/certificat|cs3600|\buxi\b|service design|design de service|cce24[789]/);
  // Dans l'objet, le premier niveau cité est celui visé (« Admission en M2 CIME – M1 Journalisme »).
  const posM1 = o.search(/master ?1|\bm1\b|premiere annee/), posM2 = o.search(/master ?2|\bm2\b|deuxieme annee/);
  let m1: boolean, m2: boolean;
  if (posM1 >= 0 || posM2 >= 0) {
    m1 = posM1 >= 0 && (posM2 < 0 || posM1 < posM2);
    m2 = !m1;
  } else {
    m2 = /master ?2|\bm2\b|deuxieme annee de master|directement en (deuxieme|m2)|admission directe/.test(t);
    m1 = !m2 && /master ?1|\bm1\b|premiere annee de master/.test(t);
  }
  const cime = cherche(/\bcime\b|communication,? innovation|mediation/);
  const tnr = cherche(/transition numerique|co-?design|codesign|numerique responsable|mr05901|1604785/) || (/numerique2/.test(o) && !cime);
  const parcours = cime && !tnr ? "CIME" : tnr && !cime ? "Transition numérique & co-design" : cime && tnr ? "CIME ou Transition numérique" : "parcours non précisé";
  const niveau = m1 ? "M1" : m2 ? "M2" : "Master (niveau non précisé)";
  const master = `${niveau} ${parcours}`;
  if (certif && !m1 && !m2 && !/master/.test(t)) return "Certificat UX (CS3600A)";
  if (certif) return `Certificat UX (CS3600A) et/ou ${master}`;
  return master;
}

function profil(corps: string, objet: string) {
  const t = norm(`${objet}\n${corps}`);
  const annees = [...t.matchAll(/(\d{1,2})\s*(?:ans|annees) d.experience/g)].map((m) => Number(m[1]));
  const maxAns = annees.length ? Math.max(...annees) : 0;
  let pro = 0, init = 0;
  if (maxAns >= 3) pro += 3;
  if (/depuis (de nombreuses|plusieurs|plus de \d+|\d+) annees|depuis \d+ ans|nombreuses annees/.test(t)) pro += 2;
  for (const re of [/directeur|directrice|responsable (de|du|des)|manager|chef de projet|cheffe de projet|consultant|freelance|independant|entrepreneur/, /salarie|en poste|ma carriere|mon parcours professionnel|experience professionnelle/, /reconversion|evolution professionnelle|formation continue|\bcpf\b|\bvapp\b|\bvae\b/]) if (re.test(t)) pro += 2;
  for (const re of [/\betudiant|\betudiante|actuellement en (l3|licence|m1|master|bachelor)/, /licence|bachelor|\bl3\b|bac ?\+ ?3/, /je termine|en cours de (licence|master)|annee universitaire|stage de fin/, /diplome(e)? (en|de) 202[4-7]|promotion 202[5-7]/, /alternance|contrat d.apprentissage/]) if (re.test(t)) init += 1.5;
  const detail = maxAns ? ` (${maxAns} ans d'expérience)` : "";
  if (pro >= 3 && pro > init) return `Professionnel expérimenté${detail}`;
  if (init > pro) return "Formation initiale (étudiant)";
  return pro > 0 ? `Profil mixte, à préciser${detail}` : "À préciser";
}

const CLE_CLAUDE = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const FORMATIONS = ["M1 Transition numérique & co-design", "M2 Transition numérique & co-design", "M1 CIME", "M2 CIME",
  "Master (niveau non précisé)", "Certificat UX (CS3600A)", "Certificat UX (CS3600A) et/ou M2 Transition numérique & co-design", "Autre"];

// Analyse fine par Claude : formation, profil, résumé, nom et prénom. Renvoie null si indisponible.
async function analyseClaude(de: string, objet: string, corps: string) {
  if (!CLE_CLAUDE) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": CLE_CLAUDE, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 500,
        system: "Tu analyses des demandes d'admission adressées au Master Information-Communication du Cnam (parcours Transition numérique & co-design, et parcours CIME) et au certificat de spécialisation Design UX CS3600A. Réponds uniquement par un objet JSON, sans texte autour.",
        messages: [{ role: "user", content:
`Expéditeur : ${de}
Objet : ${objet}
Message :
${corps.slice(0, 6000)}

Renvoie un JSON avec les clés :
- "nom" et "prenom" du candidat (d'après la signature ou l'expéditeur),
- "formation" : l'une de ${JSON.stringify(FORMATIONS)},
- "profil" : "Formation initiale (étudiant)", "Professionnel expérimenté" ou "À préciser",
- "annees_experience" : nombre ou null,
- "resume" : une ou deux phrases en français résumant la situation du candidat et ses questions.` }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const txt = d.content?.[0]?.text ?? "";
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    const ans = j.annees_experience ? ` (${j.annees_experience} ans d'expérience)` : "";
    return {
      nom: j.nom ?? "", prenom: j.prenom ?? "",
      formation: j.formation ?? "Autre",
      profil: j.profil === "Professionnel expérimenté" ? `${j.profil}${ans}` : (j.profil ?? "À préciser"),
      resume: j.resume ?? "",
    };
  } catch { return null; }
}

function analyserCandidat(corps: string, objet: string) {
  const t = norm(`${objet}\n${corps}`);
  const formation = formationVisee(objet, corps);
  const q: string[] = [];
  if (/directement en (deuxieme annee|m2)|admission directe|niveau avance|en m2/.test(t)) q.push("admission directe en M2");
  if (/vapp|vae|validation d.acquis|equivalence/.test(t)) q.push("validation des acquis / équivalence");
  if (/cce24[789]|\bue\b|unites? d.enseignement/.test(t)) q.push("UE suivies à la carte");
  if (/prochaine session|session/.test(t)) q.push("date de la prochaine session");
  if (/alternance|apprentissage|professionnalisation/.test(t)) q.push("alternance");
  if (/bourse|financ|exoner/.test(t)) q.push("financement / bourses");
  if (/etranger|nationalite|visa|campus france|hors de l.union|extra.?communautaire/.test(t)) q.push("candidat international");
  if (/echanger|rendez.vous|entretien|appel/.test(t)) q.push("souhaite un échange");
  const resume = q.length ? `Demande d'informations : ${q.join(" ; ")}.` : "Demande d'informations sur la formation.";
  return { formation, profil: profil(corps, objet), questions: q.join(", "), resume };
}

function isoParis(date: Date) {
  return date.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
}
function ligneSheet(np: { nom: string; prenom: string }, date: Date, a: any, email: string, lien: string) {
  return [np.nom, np.prenom, isoParis(date), a.formation, a.profil, a.resume,
    email, `=HYPERLINK("${lien}";"Ouvrir le mail")`];
}

// Analyse complète d'un message : Claude si disponible, sinon heuristiques.
async function analyser(de: string, objet: string, corps: string) {
  const email = (de.match(/<([^>]+)>/)?.[1] ?? de).trim().toLowerCase();
  const nom = de.replace(/<.*>/, "").replace(/"/g, "").trim() || email;
  const h = analyserCandidat(corps, objet);
  const c = await analyseClaude(de, objet, corps);
  const np = c && (c.nom || c.prenom) ? { nom: c.nom, prenom: c.prenom } : nomPrenom(nom);
  return { email, np, a: c ? { ...h, formation: c.formation, profil: c.profil, resume: c.resume || h.resume } : h, parClaude: !!c };
}

// Réécrit tout le Sheet à partir des messages déjà classés par une règle (après un changement de colonnes).
async function reconstruire(compte: string, r: any) {
  const action = (r.actions ?? []).find((x: any) => x.type === "sheet");
  if (!action) return 0;
  const sid = await fichierSheet(compte, action.fichier, action.dossier);
  const { data: msgs } = await db.from("messages").select("id").eq("traite_par", r.id).order("date_reception");
  const parEmail = new Map<string, { ligne: any[]; n: number; dates: string[] }>();
  for (const x of msgs ?? []) {
    const m = await google(compte, `${GM}/messages/${x.id}?format=full`);
    const h = m.payload?.headers ?? [];
    const res = await analyser(entete(h, "From"), entete(h, "Subject"), texte(m.payload));
    const date = new Date(Number(m.internalDate));
    const lien = `https://mail.google.com/mail/?authuser=${encodeURIComponent(compte)}#all/${m.threadId}`;
    const exist = parEmail.get(res.email);
    if (!exist) parEmail.set(res.email, { ligne: ligneSheet(res.np, date, res.a, res.email, lien), n: 1, dates: [isoParis(date)] });
    else { exist.n++; exist.dates.push(isoParis(date)); exist.ligne[5] = `${exist.ligne[5]} | Nouveau message du ${isoParis(date)} : ${res.a.resume}`; }
  }
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}`;
  // Les avis saisis à la main (colonne I) sont conservés, rattachés à l'e-mail du candidat.
  const ancien = await google(compte, `${base}/values/Candidats!A1:I10000`);
  const avis = new Map<string, string>();
  for (const l of (ancien.values ?? []).slice(1)) if (l[8]) avis.set((l[6] ?? "").toLowerCase(), l[8]);
  const lignes = [...parEmail.values()].map((v) => [...v.ligne, avis.get(String(v.ligne[6]).toLowerCase()) ?? ""]);
  await google(compte, `${base}/values/Candidats!A1:I10000:clear`, { method: "POST" });
  await google(compte, `${base}/values/Candidats!A1?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: [ENTETES_SHEET, ...lignes] }),
  });
  await formaterSheet(compte, sid);
  return lignes.length;
}

async function formaterSheet(compte: string, sid: string) {
  await google(compte, `https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [
      { repeatCell: { range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 },
        cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" } } }, fields: "userEnteredFormat.numberFormat" } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
      { repeatCell: { range: { sheetId: 0, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 300 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 260 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 420 }, fields: "pixelSize" } },
      { updateDimensionProperties: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 8, endIndex: 9 }, properties: { pixelSize: 220 }, fields: "pixelSize" } },
      { setDataValidation: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 8, endColumnIndex: 9 },
        rule: { condition: { type: "ONE_OF_LIST", values: ["Favorable", "Favorable avec réserves", "Défavorable", "Entretien à programmer", "Sans suite"].map((v) => ({ userEnteredValue: v })) },
          strict: false, showCustomUi: true } } },
    ] }),
  });
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const simulation = u.searchParams.has("simulation");
  const cle = req.headers.get("x-cle") ?? u.searchParams.get("cle");
  if (cle !== await param("cle_cron")) return json({ erreur: "clé" }, 401);

  const { data: regles } = await db.from("regles").select("*").eq("actif", true).order("priorite");
  const { data: comptes } = await db.from("comptes").select("email, role").eq("role", "principal");
  const compte = comptes?.[0]?.email;
  if (!compte) return json({ erreur: "aucun compte principal connecté" }, 400);
  const requeteForcee = u.searchParams.get("q");
  if (u.searchParams.has("reconstruire")) {
    const res: Record<string, number> = {};
    for (const r of regles ?? []) res[r.nom] = await reconstruire(compte, r);
    return json({ reconstruit: res });
  }

  const rapport: any[] = [];
  for (const r of regles ?? []) {
    const c = r.conditions ?? {};
    const liste = await google(compte, `${GM}/messages?maxResults=50&q=${encodeURIComponent(requeteForcee ?? c.requete_gmail ?? "in:inbox newer_than:1d")}`);
    const ids: string[] = (liste.messages ?? []).map((m: any) => m.id);
    if (!ids.length) continue;
    const { data: deja } = await db.from("messages").select("id").in("id", ids).not("traite_par", "is", null);
    const vus = new Set((deja ?? []).map((x) => x.id));

    for (const id of ids.filter((i) => !vus.has(i))) {
      const m = await google(compte, `${GM}/messages/${id}?format=full`);
      const h = m.payload?.headers ?? [];
      const objet = entete(h, "Subject");
      const corps = texte(m.payload);
      const t = norm(`${objet}\n${corps}`);

      if (c.premier_message_seulement) {
        const fil = await google(compte, `${GM}/threads/${m.threadId}?format=minimal`);
        if ((fil.messages ?? []).length > 1 && fil.messages[0].id !== id) continue;
      }
      // Écarte les envois de masse (lettres d'information, notifications), sauf la liste numerique2.0.
      const listId = norm(entete(h, "List-Id") + entete(h, "List-Unsubscribe"));
      const deNorm = norm(entete(h, "From"));
      if (listId && !listId.includes("numerique2")) continue;
      if (/no-?reply|newsletter|notification|mailer|zoom\.us|legavote/.test(deNorm)) continue;
      // Mot-clé en mot entier + contexte de candidature + forme de demande personnelle.
      const motCle = (c.mots_cles ?? []).find((k: string) => new RegExp(`(^|[^a-z0-9])${norm(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
      if (!motCle || !CONTEXTE.some((k) => t.includes(norm(k)))) continue;
      if (!DEMANDE.test(t)) continue;

      const de = entete(h, "From");
      const nom = de.replace(/<.*>/, "").replace(/"/g, "").trim();
      const date = new Date(Number(m.internalDate));
      const lien = `https://mail.google.com/mail/?authuser=${encodeURIComponent(compte)}#all/${m.threadId}`;
      const { email, np, a, parClaude } = simulation ? { email: "", np: nomPrenom(nom), a: analyserCandidat(corps, objet), parClaude: false } : await analyser(de, objet, corps);
      const fait: string[] = parClaude ? ["analysé par Claude"] : [];

      for (const action of r.actions ?? []) {
        if (simulation) { fait.push(`(simulation) ${action.type}`); continue; }
        try {
          if (action.type === "classer") {
            await db.from("messages").upsert({
              id, compte_email: compte, thread_id: m.threadId, expediteur: de, destinataires: entete(h, "To"),
              objet, extrait: m.snippet, date_reception: date.toISOString(), labels: m.labelIds ?? [],
              processus_id: r.processus_id, statut: "nouveau", traite_par: r.id, maj_at: new Date().toISOString(),
            });
            fait.push("classé");
          } else if (action.type === "sheet") {
            const sid = await fichierSheet(compte, action.fichier, action.dossier);
            const base = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values`;
            const col = await google(compte, `${base}/Candidats!G1:G10000`);
            const k = (col.values ?? []).findIndex((v: string[]) => (v[0] ?? "").toLowerCase() === email);
            if (k > 0) {
              const cell = await google(compte, `${base}/Candidats!F${k + 1}`);
              const avant = cell.values?.[0]?.[0] ?? "";
              await google(compte, `${base}/Candidats!F${k + 1}?valueInputOption=RAW`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ values: [[`${avant} | Nouveau message du ${isoParis(date)} : ${a.resume}`]] }),
              });
              fait.push("ligne existante complétée (même candidat)");
            } else {
              await google(compte, `${base}/Candidats!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ values: [ligneSheet(np, date, a, email, lien)] }),
              });
              fait.push("ligne ajoutée au Sheet");
            }
          } else if (action.type === "brouillon") {
            const usage = action.modele ?? (a.formation.startsWith("Certificat UX (CS3600A)") && !a.formation.includes("et/ou")
              ? action.modeles?.certificat : action.modeles?.master);
            const { data: modele } = await db.from("modeles").select("*").eq("usage", usage).maybeSingle();
            if (!modele || modele.corps.includes("[À COMPLÉTER")) { fait.push("pas de brouillon : modèle de réponse à compléter"); continue; }
            const sujet = (modele.sujet ?? "Re: {objet}").replace("{objet}", objet.replace(/^(re|tr|fwd?)\s*:\s*/i, ""));
            const { data: copies } = await db.from("processus_copies")
              .select("interlocuteurs(nom, email, actif)").eq("processus_id", r.processus_id);
            const cc = [
              ...(copies ?? []).map((x: any) => x.interlocuteurs).filter((i: any) => i?.actif)
                .map((i: any) => `${encoderEntete(i.nom)} <${i.email}>`),
              ...(action.cc ? [action.cc] : []),
            ];
            const lignes = [
              `From: ${modele.identite}`,
              `To: ${de}`,
              ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
              `Subject: ${encoderEntete(sujet)}`,
              `In-Reply-To: ${entete(h, "Message-ID")}`,
              `References: ${entete(h, "Message-ID")}`,
              "MIME-Version: 1.0",
              `Content-Type: text/${modele.format === "html" ? "html" : "plain"}; charset=UTF-8`,
              "Content-Transfer-Encoding: 8bit",
              "",
              modele.format === "html" ? `<div style="font-family:Arial,sans-serif;font-size:14px">${modele.corps}</div>` : modele.corps,
            ];
            await google(compte, `${GM}/drafts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: { raw: b64url(lignes.join("\r\n")), threadId: m.threadId } }),
            });
            fait.push(`brouillon de réponse créé (modèle ${usage})`);
          }
        } catch (e) {
          fait.push(`ERREUR ${action.type} : ${(e as Error).message}`);
        }
      }
      if (!simulation) {
        await db.from("journal").insert({ type: "regle", message_id: id, details: { regle: r.nom, mot_cle: motCle, actions: fait } });
      }
      rapport.push({ regle: r.nom, objet, de: nom, mot_cle: motCle, ...a, actions: fait });
    }
  }
  return json({ traites: rapport.length, rapport });
});
