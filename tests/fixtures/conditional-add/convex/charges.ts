import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator declares an enrichment field that is NOT a table column. The handler
// adds it via a conditional spread on one branch only, and omits it on the other.
// Because it's v.optional, this is correct — must NOT fire STALE_FIELD (the
// spokpay charges.ts false positive).
const chargeWithQr = v.object({
  _id: v.id("charges"),
  _creationTime: v.number(),
  status: v.string(),
  amount: v.number(),
  checkoutImageBase64: v.optional(v.string()),
});

export const getChargeConditionalAdd = query({
  args: { id: v.id("charges") },
  returns: v.union(chargeWithQr, v.null()),
  handler: async (ctx, args) => {
    const charge = await ctx.db.get(args.id);
    if (!charge) return null;
    if (charge.status === "pending") {
      return { ...charge, checkoutImageBase64: "data:image/png;base64,xxx" };
    }
    return charge;
  },
});

// Control: a validator field that is neither a column nor added on ANY path is
// genuinely stale — must STILL fire (optional → info).
const chargeWithGhost = v.object({
  _id: v.id("charges"),
  _creationTime: v.number(),
  status: v.string(),
  amount: v.number(),
  neverProduced: v.optional(v.string()),
});

export const getChargeStaleControl = query({
  args: { id: v.id("charges") },
  returns: v.union(chargeWithGhost, v.null()),
  handler: async (ctx, args) => {
    const charge = await ctx.db.get(args.id);
    if (!charge) return null;
    return charge;
  },
});
