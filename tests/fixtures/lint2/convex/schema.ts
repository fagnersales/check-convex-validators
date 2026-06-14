import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema(
  {
    events: defineTable({
      user: v.string(),
      time: v.number(),
      a: v.string(),
      b: v.string(),
      x: v.string(),
      y: v.string(),
    })
      // REDUNDANT: by_user [user] is a prefix of by_user_and_time [user, time].
      .index("by_user", ["user"])
      .index("by_user_and_time", ["user", "time"])
      // NOT redundant: distinct single-field indexes.
      .index("by_a", ["a"])
      .index("by_b", ["b"])
      // NOT redundant: [x, y] vs [y, x] — order differs, neither is a prefix.
      .index("by_xy", ["x", "y"])
      .index("by_yx", ["y", "x"]),
  },
  // SCHEMA_VALIDATION_DISABLED
  { schemaValidation: false },
);
