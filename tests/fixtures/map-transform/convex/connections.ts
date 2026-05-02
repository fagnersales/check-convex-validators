import { v } from "convex/values";
import { query } from "./_generated/server";

// Direct return of .map(c => ({...})) — must classify as literalArray, not rows<T>.
export const projectedList = query({
  args: {},
  returns: v.array(
    v.object({
      displayName: v.string(),
      username: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query("connections").collect();
    return all.map((c) => ({
      displayName: c.displayName,
      username: c.username,
    }));
  },
});

// .map(c => ({...c, extra})) — should preserve row<T> with `secret` dropped
// is NOT modeled here; that's the spread-extras case. Test covers only the
// no-spread literal case for now.
