// Aether's own check of every decision card it receives (defence in depth: xauusd builds the cards
// without levels, and Aether refuses any card that still carries one). Advisory only: a card never
// carries an entry, stop, target, plan, zone, key level, close, ATR or size, and its text never
// carries a price-like number.
import { CANON } from "./canon.generated.mjs";

export const CARD_VERSION = CANON.definitions.decision_card.version;
export const FORBIDDEN_KEYS = Object.freeze(CANON.definitions.decision_card.never_present);
const CHARTS = Object.freeze(["15", "60", "240", "1D"]);
const KINDS = Object.freeze(["room_conclusion", "h1_decision", "agent_episode"]);
const PRICE = /\b(?:\d{1,2},\d{3}|\d{3,5})(?:\.\d+)?\b/;
const EXEMPT = /^(?:card_id|chart|bar_open|bar_close|kb_sha|scoring_version|learned_pack_sha)$/;
const MAX_BYTES = 16 * 1024;

/** Pure: every forbidden key or price-like number in a card (empty for a clean card). */
export function cardLeaks(card) {
  const leaks = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.includes(k)) leaks.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
    else if (typeof v === "string" && !EXEMPT.test(p.split(".").at(-1)) && PRICE.test(v)) leaks.push(`${p}: price-like number`);
  };
  walk(card, "card");
  return leaks;
}

/** Pure: why a card is refused (empty when it is accepted). */
export function validateCard(card) {
  const errors = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) return ["not_an_object"];
  if (card.version !== CARD_VERSION) errors.push("unsupported_version");
  if (typeof card.card_id !== "string" || !/^d:[0-9A-Za-z]+:\d+:\d+$/.test(card.card_id)) errors.push("card_id_invalid");
  if (!KINDS.includes(card.kind)) errors.push("kind_invalid");
  if (!CHARTS.includes(card.chart)) errors.push("chart_invalid");
  if (typeof card.bar_open !== "string" || Number.isNaN(Date.parse(card.bar_open))) errors.push("bar_open_invalid");
  if (JSON.stringify(card).length > MAX_BYTES) errors.push("card_too_large");
  for (const leak of cardLeaks(card)) errors.push("leak:" + leak);
  return errors;
}
