// This dir intentionally has NO schema.ts — a valid *schemaless* Convex project
// (schema is optional). ccv must analyze it instead of aborting the whole run
// with an ANALYZER_ERROR. (Regression: convex-demos/args-validation.)
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// returns: v.null() with an empty handler → Convex coerces undefined → null.
export const ping = mutation({
  args: {},
  returns: v.null(),
  handler: async () => {},
});

// Literal-returns drift with NO schema involved: the validator types `status`
// as a number but the handler returns the string "ok". Schemaless mode must
// still catch this — it needs no schema to do so.
export const badLiteral = query({
  args: {},
  returns: v.object({ status: v.number() }),
  handler: async () => {
    return { status: "ok" };
  },
});

// A db-backed read with no schema → the row shape can't be resolved → the
// function degrades to UNANALYZED (conservative), NOT a crash and NOT a false
// pass.
export const listThings = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("things"), name: v.string() })),
  handler: async (ctx) => {
    return await ctx.db.query("things").collect();
  },
});
