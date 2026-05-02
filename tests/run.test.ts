import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import type { Issue, RunOptions } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

function go(fixture: string): { issues: Issue[]; codes: string[] } {
  const opts: RunOptions = {
    convexDir: `${FIX}${fixture}/convex`,
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
  };
  const r = run(opts);
  return { issues: r.issues, codes: r.issues.map((i) => i.code) };
}

describe("clean fixture", () => {
  test("emits no issues", () => {
    const { issues } = go("clean");
    expect(issues).toEqual([]);
  });
});

describe("missing field (R1)", () => {
  test("flags missing schema fields in returns validator", () => {
    const { codes, issues } = go("missing-field");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedAvailableBalance");
    expect(missing.severity).toBe("error");
  });
});

describe("null branch missing (R5)", () => {
  test("flags handler returning .first() without v.null() in validator", () => {
    const { codes } = go("null-branch");
    expect(codes).toContain("NULL_BRANCH_MISSING");
  });
});

describe("cardinality mismatch (R6)", () => {
  test("flags .collect() returning array against single-object validator", () => {
    const { codes } = go("cardinality");
    expect(codes).toContain("CARDINALITY_MISMATCH");
  });
});

describe("spread + drop (R10)", () => {
  test("clean when handler drops a field that validator omits", () => {
    const { issues } = go("spread-drop");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("imported validator (R12)", () => {
  test("follows symbol import to detect drift in another file", () => {
    const { codes, issues } = go("imported-validator");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedBalance");
  });
});

describe("literal returns (R8)", () => {
  test("flags extra fields in literal return", () => {
    const { codes, issues } = go("literal");
    expect(codes).toContain("EXTRA_LITERAL_FIELD");
    const extra = issues.find((i) => i.code === "EXTRA_LITERAL_FIELD")!;
    expect(extra.message).toContain("total");
  });

  test("flags missing required fields in literal return", () => {
    const { issues } = go("literal");
    const missing = issues.filter((i) => i.code === "MISSING_LITERAL_FIELD");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.message).toContain("total");
  });
});

describe("optionality mismatch (R3)", () => {
  test("flags schema-optional vs validator-required", () => {
    const { codes, issues } = go("optionality");
    expect(codes).toContain("OPTIONALITY_MISMATCH");
    const opt = issues.find((i) => i.code === "OPTIONALITY_MISMATCH")!;
    expect(opt.message).toContain("description");
  });
});

describe("stale field (R2)", () => {
  test("warns about validator field not in schema", () => {
    const { codes, issues } = go("stale-field");
    expect(codes).toContain("STALE_FIELD");
    const stale = issues.find((i) => i.code === "STALE_FIELD")!;
    expect(stale.message).toContain("legacyField");
    expect(stale.severity).toBe("warn");
  });
});

describe("validator spread (...x.fields)", () => {
  test("clean — spread of plain object inlines fields", () => {
    const { issues } = go("validator-spread");
    const errors = issues.filter(
      (i) => i.severity === "error" && i.function === "getStoreA",
    );
    expect(errors).toEqual([]);
  });

  test("clean — spread of validator .fields inlines fields", () => {
    const { issues } = go("validator-spread");
    const errors = issues.filter(
      (i) => i.severity === "error" && i.function === "getStoreB",
    );
    expect(errors).toEqual([]);
  });

  test("no STALE_FIELD noise from synthetic __spread: keys", () => {
    const { issues } = go("validator-spread");
    const stale = issues.filter((i) => i.code === "STALE_FIELD");
    expect(stale).toEqual([]);
  });
});

describe("discriminated union (R14)", () => {
  test("matches each literal return to the branch whose literal discriminator agrees", () => {
    const { issues } = go("discriminated-union");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe(".map(c => ({...})) direct return (R11)", () => {
  test("classifies as literalArray of literal — no MISSING_FIELD against schema", () => {
    const { issues } = go("map-transform");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("nested callback returns", () => {
  test("ignores returns inside nested arrow callbacks (.map(d => return ...))", () => {
    const { issues } = go("nested-returns");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("barrel re-export", () => {
  test("follows `export { x } from \"./y\"` to the original definition", () => {
    const { codes, issues } = go("barrel-reexport");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedBalance");
  });
});

describe("const-binding for ctx.db.get", () => {
  test("traces table through `const id = args.storeId; ctx.db.get(id)`", () => {
    const { codes, issues } = go("const-binding");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedAvailableBalance");
  });
});

describe("paginated (R7)", () => {
  test("diffs paginated row shape against schema", () => {
    const { codes, issues } = go("paginated");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("secret");
  });
});
