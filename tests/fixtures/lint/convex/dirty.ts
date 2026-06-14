import { v } from "convex/values";
import {
  query,
  mutation,
  action,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { api, internal } from "./_generated/api";

// AWAIT_IN_LOOP — read (warn). Independent gets, fully parallelizable.
export const wealth = query({
  args: { id: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.id);
    let total = 0;
    for (const inv of agent!.inventory) {
      const item = await ctx.db.get(inv.itemId);
      if (item) total += item.basePrice * inv.qty;
    }
    return total;
  },
});

// AWAIT_IN_LOOP — write (info, OCC caveat).
export const markAll = mutation({
  args: { ids: v.array(v.id("agents")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.patch(id, { name: "x" });
    }
  },
});

// LOOP-CARRIED — must NOT flag: iteration N feeds N+1 (the await reads `cur`).
export const chained = mutation({
  args: { start: v.id("agents") },
  handler: async (ctx, args) => {
    let cur = await ctx.db.get(args.start);
    for (let i = 0; i < 5; i++) {
      cur = await ctx.db.get(cur!.ownerId as unknown as typeof args.start);
    }
    return cur;
  },
});

// CLEAN — Promise.all is the fix; the .map await is in a nested arrow, not a loop.
export const wealthClean = query({
  args: { id: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.id);
    const items = await Promise.all(agent!.inventory.map((inv) => ctx.db.get(inv.itemId)));
    return items.length;
  },
});

// FILTER_IN_QUERY — .filter on a ctx.db.query chain.
export const byFilter = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("name"), "x"))
      .first();
  },
});

// CLEAN — `.filter()` on a PAGINATED query is a documented exception (code
// filtering can produce incomplete pages), so it must NOT be flagged.
export const byFilterPaginated = query({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("name"), "x"))
      .paginate({ numItems: 10, cursor: args.cursor });
  },
});

// UNBOUNDED_COLLECT — collect with no index narrowing.
export const allAgents = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("agents").collect();
  },
});

// CLEAN — collect bounded by an index.
export const byOwner = query({
  args: { ownerId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .collect();
  },
});

// CLEAN — JS array .filter on an already-collected array is fine.
export const jsFilter = query({
  args: { ownerId: v.id("users") },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    return all.filter((a) => a.name === "x");
  },
});

// NONDETERMINISTIC_QUERY — Date.now() and Math.random() in a query.
export const trending = query({
  args: {},
  handler: async (ctx) => {
    const since = Date.now() - 1000;
    const jitter = Math.random();
    return since + jitter;
  },
});

// CLEAN — Date.now() in a mutation is fine (not cached/reactive).
export const stamp = mutation({
  args: {},
  handler: async (ctx) => {
    return Date.now();
  },
});

// SEQUENTIAL_CTX_RUN — two separate-transaction runMutations in an action.
export const orchestrate = action({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.dirty.markInternal, {});
    await ctx.runMutation(internal.dirty.markInternal, {});
  },
});

// MISSING_ARG_VALIDATOR — public, no args (warn).
export const noArgs = query({
  handler: async () => {
    return 1;
  },
});

// MISSING_ARG_VALIDATOR — internal, no args (info).
export const noArgsInternal = internalQuery({
  handler: async () => {
    return 1;
  },
});

// CLEAN target for the SEQUENTIAL_CTX_RUN action above.
export const markInternal = internalMutation({
  args: {},
  handler: async () => {},
});

// OLD_FUNCTION_SYNTAX — bare function, no validators possible.
export const legacy = query(async () => {
  return 1;
});

// SCHEDULE_PUBLIC_FN — scheduling / calling a public api.* function (info).
export const schedulePublic = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, api.dirty.allAgents, {});
    await ctx.runQuery(api.dirty.allAgents, {});
  },
});

// CLEAN — scheduling an internal.* function.
export const scheduleInternal = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.dirty.markInternal, {});
  },
});
