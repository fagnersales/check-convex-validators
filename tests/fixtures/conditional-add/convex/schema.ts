import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  charges: defineTable({
    status: v.string(),
    amount: v.number(),
  }),
});
