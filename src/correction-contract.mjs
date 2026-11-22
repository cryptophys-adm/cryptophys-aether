// The correction.v1 contract (platform docs/design/HAIC-H3.md §4; cryptophys-cloud-platform
// workers/control-plane-shared/src/correction.ts at 62e5167), ported verbatim in behaviour and checked against the
// shared fixtures in test/fixtures/correction-v1. The same port lives in xauusd (src/owner-corrections.mjs). Pure.

export const CORRECTION_SCHEMA = "correction.v1";
export const CORRECTION_DEDUP_VERSION = "cryptophys.correction-dedup.v1";
export const CORRECTION_SIDES = Object.freeze(["cerebrum", "nexus"]);
export const CORRECTION_SOURCES = Object.freeze(["chat_rating", "council", "typed_proposal", "knowledge_review", "nexus_card", "nexus_room", "nexus_engine", "nexus_council"]);
export const CORRECTION_LABELS = Object.freeze(["owner_rating", "owner_correction", "owner_decision", "reviewer_correction"]);
export const CORRECTION_CATEGORIES = Object.freeze([
  "reading_wrong", "invalidation_too_tight", "invalidation_too_loose", "evidence_wrong", "evidence_missing",
  "overconfident", "underconfident", "rule_broken", "good_call", "other"
]);
export const CORRECTION_ATTESTATIONS = Object.freeze(["cerebrum_access", "xauusd_nexus_access"]);
export const CORRECTION_REDACTIONS = Object.freeze(["secret", "price", "truncated"]);
export const CORRECTION_TEXT_MAX = 500;
export const CORRECTION_REFS_MAX = 10;
export const LABEL_WEIGHT = Object.freeze({ owner_rating: 3, owner_correction: 3, owner_decision: 1, reviewer_correction: 2 });
export const NON_OWNER_WEIGHT = 1;

const ID = /^cor_[0-9a-f]{16}$/;
const SUBJECT = /^(agent|model|seat):[A-Za-z0-9_.:-]{1,100}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PRICE_G = /(?:\d{1,3}(?:[.,\s_'’]\d{3})+(?:[.,]\d+)?|\d{3,}(?:[.,]\d+)?)/g;
const PRICE = new RegExp(PRICE_G.source);
const FORBIDDEN_KEYS = new Set(["params", "parameters", "values", "value", "change", "changes", "patch", "set", "weight_delta"]);
const PRICE_KEY_PARTS = new Set(["price", "prices", "level", "levels", "size", "sizing", "entry", "entries", "stop", "order", "orders", "lot", "lots", "sl", "tp", "tp1", "tp2"]);
const ALLOWED_KEYS = new Set([
  "schema", "correction_id", "side", "source", "label", "rating", "category", "target", "text", "evidence_refs", "actor", "attested_by",
  "weight", "supersedes", "redactions", "created_at", "content_sha256", "dedup_sha256", "category_raw", "invalid_refs"
]);

// ------------------------------------------------------------ evidence refs (platform council.ts §4.6)
const REF = /^ev:(platform|xauusd|aether|adr|ssot)\/(?:([a-z][a-z0-9_.-]{0,63})\/)?([^@#\s]{1,200})(?:@([^#\s]{1,40}))?(?:#([A-Za-z0-9_.]{1,80}))?$/;
const PRICE_WORDS = /^(price|entry|stoploss|stop|takeprofit|sl|tp\d?|level|bid|ask|open|high|low|close|mid)$/i;
export function parseRef(ref) {
  if (typeof ref !== "string") return null;
  const m = REF.exec(ref);
  if (!m) return null;
  const [, side, source, id, asOf, field] = m;
  return { side, source: source ?? side, id, as_of: asOf ?? null, field: field ?? null };
}
export const refCarriesPrice = (ref) => ref.field !== null && PRICE_WORDS.test(ref.field.split(/[._]/).pop() ?? "");

// ------------------------------------------------------------ secrets (platform conversation.ts and http.ts)
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const SECRET_SHAPES = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:cf|CF)[A-Za-z0-9_-]*_(?:token|TOKEN)\s*[=:]\s*\S{20,}/
]);
const redactValue = (text) => text.replace(SECRET_VALUE, "[redacted]");
export const secretInText = (text) => redactValue(text) !== text || SECRET_SHAPES.some((re) => re.test(text));
export function redactText(text) {
  let out = redactValue(String(text));
  for (const re of SECRET_SHAPES) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]");
  return out;
}

// ------------------------------------------------------------ the contract (platform correction.ts)
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** Trim and collapse every whitespace run; case is kept. */
export const normalizeText = (s) => s.trim().replace(/\s+/g, " ");

/** Keys that name a parameter or a price, anywhere in a value. */
export function forbiddenCorrectionKeys(value, path = "correction") {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenCorrectionKeys(v, `${path}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const parts = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]/);
    const bad = FORBIDDEN_KEYS.has(k.toLowerCase()) || parts.some((p) => PRICE_KEY_PARTS.has(p));
    return [...(bad ? [`${path}.${k}`] : []), ...forbiddenCorrectionKeys(v, `${path}.${k}`)];
  });
}

function safeRef(raw) {
  const ref = parseRef(raw);
  if (!ref || typeof raw !== "string") return null;
  return refCarriesPrice(ref) ? { ref: raw.slice(0, raw.indexOf("#")), priced: true } : { ref: raw, priced: false };
}

/** Text as stored: secrets redacted, prices masked, at most CORRECTION_TEXT_MAX characters; each step flagged. */
export function safeText(raw, redactions) {
  if (typeof raw !== "string") return null;
  let text = normalizeText(raw);
  if (!text) return null;
  if (secretInText(text)) { text = redactText(text); redactions.add("secret"); }
  if (PRICE.test(text)) { text = text.replace(PRICE_G, "[level]"); redactions.add("price"); }
  if (text.length > CORRECTION_TEXT_MAX) { text = text.slice(0, CORRECTION_TEXT_MAX); redactions.add("truncated"); }
  return text;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

/** §4.3: the same actor, target, label, rating, category, normalized text and sorted refs; ids, times, supersedes left out. */
export function correctionDedupHash(c) {
  return sha256Hex(JSON.stringify([CORRECTION_DEDUP_VERSION, c.actor, c.target.ref, c.label, c.rating, c.category, normalizeText(c.text ?? ""), [...c.evidence_refs].sort()]));
}
/** The record's content: everything but its id, its time, its weight and its two hashes. */
export function correctionContentHash(c) {
  const { correction_id: _i, created_at: _c, weight: _w, content_sha256: _h, dedup_sha256: _d, ...content } = c;
  return sha256Hex(JSON.stringify(canonical(content)));
}

/**
 * An input into a record (§4.4). Structural errors only: an unknown side, source or label, a target that is not an ev:
 * ref or names no subject, a parameter key, or nothing to learn (no rating, category or text). Everything else is made
 * safe. ctx = { actor, owner, attested_by, now, correction_id } comes from the caller's authentication, never the input.
 */
export async function buildCorrection(input, ctx) {
  if (!isObject(input)) return { ok: false, error: "invalid_request" };
  const bad = forbiddenCorrectionKeys(input, "input").filter((k) => !/^input\.target\.(ref|subject|as_of)$/.test(k));
  if (bad.length) return { ok: false, error: `forbidden_key: ${bad[0]}` };
  if (!CORRECTION_SIDES.includes(input.side)) return { ok: false, error: "invalid_side" };
  if (!CORRECTION_SOURCES.includes(input.source)) return { ok: false, error: "invalid_source" };
  const redactions = new Set();
  const target = isObject(input.target) ? input.target : null;
  const tref = target ? safeRef(target.ref) : null;
  if (!tref) return { ok: false, error: "invalid_target" };
  if (tref.priced) redactions.add("price");
  const subject = typeof target.subject === "string" ? target.subject : "";
  if (!SUBJECT.test(subject)) return { ok: false, error: "invalid_subject" };
  const asOf = typeof target.as_of === "string" && ISO.test(target.as_of) ? target.as_of : null;
  const rating = input.rating === "up" || input.rating === "down" ? input.rating : null;
  let category = null;
  let categoryRaw;
  if (typeof input.category === "string" && input.category.trim()) {
    if (CORRECTION_CATEGORIES.includes(input.category)) category = input.category;
    else { category = "other"; categoryRaw = input.category.slice(0, 60); }
  }
  const text = safeText(input.text, redactions);
  if (!rating && !category && !text) return { ok: false, error: "empty" };
  const label = CORRECTION_LABELS.includes(input.label) ? input.label
    : input.label === undefined ? (category || text ? "owner_correction" : "owner_rating") : "";
  if (!label) return { ok: false, error: "invalid_label" };
  if (label === "owner_rating" && !rating) return { ok: false, error: "rating_required" };
  const refs = [];
  let invalid = 0;
  for (const r of Array.isArray(input.evidence_refs) ? input.evidence_refs : []) {
    const s = safeRef(r);
    if (!s) { invalid += 1; continue; }
    if (s.priced) redactions.add("price");
    if (!refs.includes(s.ref) && refs.length < CORRECTION_REFS_MAX) refs.push(s.ref);
  }
  const supersedes = typeof input.supersedes === "string" && ID.test(input.supersedes) ? input.supersedes : null;
  const base = {
    schema: CORRECTION_SCHEMA, correction_id: ctx.correction_id, side: input.side, source: input.source,
    label, rating, category, target: { ref: tref.ref, subject, as_of: asOf }, text, evidence_refs: refs,
    actor: ctx.actor, attested_by: ctx.attested_by, weight: ctx.owner ? LABEL_WEIGHT[label] : NON_OWNER_WEIGHT,
    supersedes, redactions: CORRECTION_REDACTIONS.filter((r) => redactions.has(r)), created_at: ctx.now,
    ...(categoryRaw ? { category_raw: categoryRaw } : {}), ...(invalid ? { invalid_refs: invalid } : {})
  };
  return { ok: true, correction: { ...base, content_sha256: await correctionContentHash(base), dedup_sha256: await correctionDedupHash(base) } };
}

/** Every rule a stored or sent record must hold (the shared fixtures are checked with it). */
export function validateCorrection(c) {
  if (!isObject(c)) return ["not_an_object"];
  const errors = [];
  for (const k of Object.keys(c)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown_key: ${k}`);
  for (const k of forbiddenCorrectionKeys(c).filter((k) => !/^correction\.target\.(ref|subject|as_of)$/.test(k))) errors.push(`forbidden_key: ${k}`);
  if (c.schema !== CORRECTION_SCHEMA) errors.push("schema");
  if (typeof c.correction_id !== "string" || !ID.test(c.correction_id)) errors.push("correction_id");
  if (!CORRECTION_SIDES.includes(c.side)) errors.push("side");
  if (!CORRECTION_SOURCES.includes(c.source)) errors.push("source");
  const label = c.label;
  if (!CORRECTION_LABELS.includes(label)) errors.push("label");
  if (!(c.rating === null || c.rating === "up" || c.rating === "down")) errors.push("rating");
  if (!(c.category === null || CORRECTION_CATEGORIES.includes(c.category))) errors.push("category");
  const t = isObject(c.target) ? c.target : null;
  const ref = t ? parseRef(t.ref) : null;
  if (!t || !ref) errors.push("target.ref");
  else if (refCarriesPrice(ref)) errors.push("target.ref_carries_price");
  if (!t || typeof t.subject !== "string" || !SUBJECT.test(t.subject)) errors.push("target.subject");
  if (t && !(t.as_of === null || (typeof t.as_of === "string" && ISO.test(t.as_of)))) errors.push("target.as_of");
  if (c.text !== null) {
    if (typeof c.text !== "string" || !c.text.trim()) errors.push("text");
    else {
      if (c.text.length > CORRECTION_TEXT_MAX) errors.push("text_too_long");
      if (secretInText(c.text)) errors.push("text_carries_secret");
      if (PRICE.test(c.text)) errors.push("text_carries_price");
    }
  }
  if (!Array.isArray(c.evidence_refs) || c.evidence_refs.length > CORRECTION_REFS_MAX) errors.push("evidence_refs");
  else for (const r of c.evidence_refs) {
    const p = parseRef(r);
    if (!p) errors.push("evidence_refs.unparsed");
    else if (refCarriesPrice(p)) errors.push("evidence_refs.carries_price");
  }
  if (typeof c.actor !== "string" || c.actor.length < 3 || c.actor.length > 200) errors.push("actor");
  if (!CORRECTION_ATTESTATIONS.includes(c.attested_by)) errors.push("attested_by");
  if (!(c.weight === NON_OWNER_WEIGHT || (CORRECTION_LABELS.includes(label) && c.weight === LABEL_WEIGHT[label]))) errors.push("weight");
  if (!(c.supersedes === null || (typeof c.supersedes === "string" && ID.test(c.supersedes)))) errors.push("supersedes");
  if (!Array.isArray(c.redactions) || !c.redactions.every((r) => CORRECTION_REDACTIONS.includes(r))) errors.push("redactions");
  if (typeof c.created_at !== "string" || !ISO.test(c.created_at)) errors.push("created_at");
  if (typeof c.content_sha256 !== "string" || !HEX64.test(c.content_sha256)) errors.push("content_sha256");
  if (typeof c.dedup_sha256 !== "string" || !HEX64.test(c.dedup_sha256)) errors.push("dedup_sha256");
  if (label === "owner_rating" && c.rating === null) errors.push("owner_rating_without_rating");
  if (label === "owner_correction" && c.category === null && c.text === null) errors.push("owner_correction_without_content");
  if (label === "owner_decision" && c.text === null) errors.push("owner_decision_without_reason");
  if (c.category_raw !== undefined && (c.category !== "other" || typeof c.category_raw !== "string")) errors.push("category_raw");
  if (c.invalid_refs !== undefined && !(Number.isInteger(c.invalid_refs) && c.invalid_refs > 0)) errors.push("invalid_refs");
  return errors;
}

