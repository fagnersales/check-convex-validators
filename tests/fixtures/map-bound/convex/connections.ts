import { v } from "convex/values";
import { query } from "./_generated/server";

// Same as map-transform but the .map result is bound to a const before
// being returned. Currently the binding inherits rowsOf<T> from the
// receiver, ignoring the callback transform, and emits bogus errors
// against the schema row.
export const projectedListBound = query({
  args: {},
  returns: v.array(
    v.object({
      displayName: v.string(),
      username: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query("connections").collect();
    const projected = all.map((c) => ({
      displayName: c.displayName,
      username: c.username,
    }));
    return projected;
  },
});
