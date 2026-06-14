"use node";
import { query, action } from "./_generated/server";

// QUERY_IN_NODE_FILE — a query can't run in the Node runtime.
export const inNode = query({
  args: {},
  handler: async () => 1,
});

// CLEAN — an action legitimately lives in a "use node" file.
export const okAction = action({
  args: {},
  handler: async () => 1,
});
