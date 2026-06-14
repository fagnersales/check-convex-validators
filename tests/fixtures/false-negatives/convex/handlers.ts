// A handler body factored out into its own module and referenced by name from
// a function definition in funcs.ts — the common Convex component pattern
// (`handler: getPointHandler`). ccv must follow this cross-file reference.
export const getPointHandler = async (ctx: any, args: any) => {
  const p = await ctx.db.get(args.id);
  if (!p) throw new Error("missing");
  return p; // row<points>: { name: string, sortKey: number, ... }
};
