import { v } from "convex/values";
import { action } from "./_generated/server";

export const op = action({
  args: {},
  returns: v.union(
    v.object({ ok: v.literal(true), value: v.string() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async () => {
    if (Math.random() > 0.5) return { ok: true as const, value: "yay" };
    return { ok: false as const, error: "nope" };
  },
});
