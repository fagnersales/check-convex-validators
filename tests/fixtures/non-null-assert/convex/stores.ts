import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator omits `secret`. Handler returns the full row via non-null
// assertion `store!`. Analyzer must unwrap NonNullExpression to detect
// the drift; otherwise this slips through as UNANALYZED.
export const getOrThrow = query({
  args: { id: v.id("stores") },
  returns: v.object({
    _id: v.id("stores"),
    _creationTime: v.number(),
    name: v.string(),
  }),
  handler: async (ctx, args) => {
    const store = await ctx.db.get(args.id);
    return store!;
  },
});
