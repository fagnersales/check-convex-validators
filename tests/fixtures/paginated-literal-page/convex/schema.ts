import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  reviews: defineTable({
    storeId: v.id("stores"),
    rating: v.optional(v.number()),
    secret: v.string(),
    attachments: v.array(v.id("_storage")),
  }),
});
