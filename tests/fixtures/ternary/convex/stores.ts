import { v } from "convex/values";
import { action } from "./_generated/server";

// Without expanding both branches, only the whenTrue branch is checked
// (clean against the validator). The whenFalse branch returns a literal
// missing the required `value` field — must be flagged.
export const op = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    value: v.string(),
  }),
  handler: async () => {
    return Math.random() > 0.5
      ? { ok: true, value: "ok" }
      : { ok: false }; // missing `value`
  },
});
