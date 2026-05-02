import { v } from "convex/values";
import { query } from "./_generated/server";

// Outer return is { total, sum }. The inner .map callback returns
// { label, qty }, but that nested return MUST NOT be classified as a
// return path of this query.
export const summarize = query({
  args: {},
  returns: v.object({
    total: v.number(),
    sum: v.number(),
  }),
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const labels = items.map((it) => {
      return { label: it.label, qty: it.qty };
    });
    const sum = labels.reduce((a, b) => a + b.qty, 0);
    return { total: items.length, sum };
  },
});
