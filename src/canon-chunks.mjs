// Pure: the Aether Canon as embeddable chunks for the aether-canon index (phase A4). One chunk per
// doctrine rule, agent role, definition section, KB v4 field and KB v4 decision-policy rule. Ids
// are stable within a canon version: m:<canon sha8>:<n> (at most 64 bytes, a Vectorize limit).
import { CANON } from "./canon.generated.mjs";

const MAX_TEXT = 1500;
const clip = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
const str = (v) => (typeof v === "string" ? v : JSON.stringify(v));

export function canonChunks(canon = CANON) {
  const sha8 = canon.content_sha256.slice(0, 8);
  const out = [];
  const add = (part, ref, text) => out.push({ id: `m:${sha8}:${out.length}`, text: clip(text), metadata: { kind: "master", part, ref: String(ref).slice(0, 120), canon: sha8 } });
  for (const r of canon.doctrine.rules) add("doctrine", r.id, `Owner rule (${r.id}): ${r.rule} Source: ${r.source}.`);
  for (const a of canon.roles.agents) add("role", a.id, `Agent ${a.name} (${a.id}, ${a.kind}, family ${a.family}) reads ${a.reads ?? "its own data"}; rooms ${(a.rooms || []).join(", ") || "none"}; reference ${a.reference}.`);
  for (const [k, v] of Object.entries(canon.definitions)) if (k !== "version" && k !== "note") add("definition", k, `Definition ${k}: ${str(v)}`);
  const kb = canon.indicator.kb;
  for (const [source, block] of Object.entries(kb.field_dictionary || {})) {
    for (const [field, f] of Object.entries(block.fields || {})) {
      const values = f.values ? " Values: " + Object.entries(f.values).map(([v, m]) => `${v} = ${m}`).join("; ") + "." : "";
      add("indicator", `${source}.${field}`, `Field ${field} of ${source}: ${f.meaning ?? f.description ?? ""}${values} ${f.note ?? ""}`);
    }
  }
  for (const [k, v] of Object.entries(kb.decision_policy || {})) add("policy", k, `Decision policy ${k}: ${str(v)}`);
  return out;
}
