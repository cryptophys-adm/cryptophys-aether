// Aether's Workers AI metering (owner 2026-11-14: "learning tidak boleh dibatasi siapa pun, itu adalah mandat
// tertinggi"). Every Workers AI request is counted per UTC day in D1 (table ai_usage, shared by every isolate)
// so the cost stays visible on /health, the Aether page and the sync checks. It is a meter, not a budget:
// nothing here refuses, defers or queues a request. (Until 2026-11-14 a daily limit, AI_DAILY_LIMIT, refused
// embeddings past 60 requests a day; the owner's mandate removed it.)
export const USAGE_TABLE = "ai_usage";
export const USAGE_UNIT = "requests";

// Per database object, so each isolate creates the table once (and a test's fresh database gets its own).
const ready = new WeakSet();
export async function ensureUsageSchema(db) {
  if (ready.has(db)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0)").run();
  ready.add(db);
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Records `n` Workers AI requests against today. Never refuses; returns today's count after recording. */
export async function recordUsage(env, n = 1, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  await ensureUsageSchema(db);
  const day = dayOf(now);
  const row = await db.prepare("INSERT INTO ai_usage (day, requests) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests RETURNING requests").bind(day, n).first();
  return Number(row?.requests) || 0;
}

/** Today's recorded Workers AI requests (UTC day). */
export async function usageToday(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  await ensureUsageSchema(db);
  const row = await db.prepare("SELECT requests FROM ai_usage WHERE day = ?").bind(dayOf(now)).first();
  return Number(row?.requests) || 0;
}
