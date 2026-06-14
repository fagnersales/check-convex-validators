import { v } from "convex/values";
import { query, mutation, action, internalQuery } from "./_generated/server";
import { internal, components } from "./_generated/api";

// FLOATING_CTX_PROMISE — un-awaited database write.
export const floatWrite = mutation({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    ctx.db.patch(args.id, { user: "x" });
  },
});

// CLEAN — awaited write.
export const awaitedWrite = mutation({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { user: "x" });
  },
});

// CLEAN — deliberate fire-and-forget is voided, not floating.
export const voidedSchedule = mutation({
  args: {},
  handler: async (ctx) => {
    void ctx.scheduler.runAfter(0, internal.bodyrules.helper, {});
  },
});

// FETCH_IN_QUERY — fetch() in a query.
export const fetchInQuery = query({
  args: {},
  handler: async () => {
    const r = await fetch("https://example.com");
    return r.status;
  },
});

// CLEAN — fetch() in an action is fine.
export const fetchInAction = action({
  args: {},
  handler: async () => {
    const r = await fetch("https://example.com");
    return r.status;
  },
});

// DB_IN_ACTION — ctx.db used in an action.
export const dbInAction = action({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// DB_IN_ACTION — db destructured from an action's ctx.
export const dbDestructured = action({
  args: {},
  handler: async ({ db }) => {
    return db;
  },
});

export const helper = internalQuery({
  args: {},
  handler: async () => 1,
});

// CTX_RUN_IN_QUERY_OR_MUTATION — ctx.runQuery inside a query.
export const runInQuery = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(internal.bodyrules.helper, {});
  },
});

// CLEAN — components can only be reached via ctx.runQuery (documented exception).
export const runComponent = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.runQuery(components.foo.bar, {});
  },
});
