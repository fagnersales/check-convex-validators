import { action } from "./_generated/server";
"use node"; // MISPLACED_USE_NODE — comes after an import, so the bundler ignores it.

export const afterImport = action({
  args: {},
  handler: async () => 1,
});
