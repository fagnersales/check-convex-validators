import { v } from "convex/values";
import { query } from "./_generated/server";

// Handler adds `cancelledByEmail` via an optional-chain `cancelledByUser?.email`
// — the value is `string | undefined`. Validator correctly declares it as
// optional. Without optional-chain detection, analyzer treats the add as
// required and emits a bogus OPTIONALITY_MISMATCH.
export const listLoans = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("loans"),
      _creationTime: v.number(),
      amount: v.number(),
      cancelledBy: v.optional(v.id("users")),
      cancelledByEmail: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const loans = await ctx.db.query("loans").collect();
    return await Promise.all(
      loans.map(async (loan) => {
        const cancelledByUser = loan.cancelledBy
          ? await ctx.db.get(loan.cancelledBy)
          : null;
        return {
          ...loan,
          cancelledByEmail: cancelledByUser?.email,
        };
      }),
    );
  },
});
