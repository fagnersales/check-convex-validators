import { v } from "convex/values";
import { query } from "./_generated/server";
import schema from "./schema";
import { getPointHandler } from "./handlers";

// FIX A — String()/Number()/Boolean() coercion. The handler coerces the numeric
// `sortKey` to a string, which the v.number() validator rejects at runtime.
// Previously fell through to `any` and was missed (geospatial/workpool/expo-push).
export const coerced = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.id("points"),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.number(),
  }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) throw new Error("missing");
    return { ...p, sortKey: String(p.sortKey) };
  },
});

// FIX B — a named-reference handler imported from another module. The resolved
// body returns a `points` row whose `sortKey` is a number, but the validator
// declares it v.string() → drift. Previously the function was silently skipped
// (never analyzed, never reported) (aggregate/launchdarkly/rag).
export const getPointNamed = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.id("points"),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.string(),
  }),
  handler: getPointHandler,
});

// FIX C — an extra field added by the handler that the validator (an unresolved
// `...schema.tables.X.validator.fields` spread) cannot possibly cover. The spread
// only contributes the table's own fields, never `bogus` → Convex rejects the
// extra field. Previously suppressed by the unresolved-spread guard (aggregate).
export const extraBehindSpread = query({
  args: { id: v.id("nodes") },
  returns: v.object({
    ...schema.tables.nodes.validator.fields,
    _id: v.id("nodes"),
    _creationTime: v.number(),
  }),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.id);
    if (!n) throw new Error("missing");
    return { ...n, bogus: 1 };
  },
});

// FIX B guardrail — a handler genuinely wrapped in a call we can't follow
// statically must degrade to UNANALYZED (honest coverage), NOT silently vanish
// and NOT crash the run.
const wrap = (fn: any) => fn;
export const wrappedHandler = query({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: wrap(async () => ({ ok: true })),
});
