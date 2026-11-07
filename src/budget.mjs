// Aether's own daily Workers AI budget (RFC §0.8 A6, owner approval 2026-11-07), counted in D1 so
// every isolate shares it. A request that would pass the limit is refused, never queued.
export const DEFAULT_DAILY_LIMIT = 60;

export async function ensureBudgetSchema(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0)").run();
}

/** Takes `n` requests from today's budget; false (and nothing taken) when the limit would be passed. */
export async function takeBudget(env, n = 1, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  await ensureBudgetSchema(db);
  const limit = Number.parseInt(env.AI_DAILY_LIMIT ?? "", 10) > 0 ? Number.parseInt(env.AI_DAILY_LIMIT, 10) : DEFAULT_DAILY_LIMIT;
  const day = new Date(now).toISOString().slice(0, 10);
  await db.prepare("INSERT OR IGNORE INTO ai_usage (day, requests) VALUES (?, 0)").bind(day).run();
  const res = await db.prepare("UPDATE ai_usage SET requests = requests + ? WHERE day = ? AND requests + ? <= ?").bind(n, day, n, limit).run();
  return Number(res?.meta?.changes) === 1;
}

export async function budgetUsed(env, { now = Date.now() } = {}) {
  const db = env.AETHER_DB;
  await ensureBudgetSchema(db);
  const row = await db.prepare("SELECT requests FROM ai_usage WHERE day = ?").bind(new Date(now).toISOString().slice(0, 10)).first();
  return Number(row?.requests) || 0;
}
