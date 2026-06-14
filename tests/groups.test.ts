import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import { computeGroups, reportGroupsJson } from "../src/report.ts";
import { AUTOFIX } from "../src/rules.ts";
import type { RunOptions } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

function runFix(fixture: string, lint = true) {
  const opts: RunOptions = {
    convexDir: `${FIX}${fixture}/convex`,
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "json",
    strict: false,
    lint,
  };
  return run(opts);
}

describe("computeGroups", () => {
  test("groups issues by code, one group per distinct code", () => {
    const r = runFix("lint");
    const groups = computeGroups(r.issues);
    const codes = new Set(r.issues.map((i) => i.code));
    expect(groups.length).toBe(codes.size);
    // counts add up to the underlying issues
    const total = groups.reduce((n, g) => n + g.count, 0);
    expect(total).toBe(r.issues.length);
  });

  test("is sorted by priority ascending (errors → warns → info)", () => {
    const groups = computeGroups(runFix("lint").issues);
    const prios = groups.map((g) => g.priority);
    expect(prios).toEqual([...prios].sort((a, b) => a - b));
    // severity follows priority bands
    const sevRank = { error: 0, warn: 1, info: 2 };
    for (let i = 1; i < groups.length; i++) {
      expect(sevRank[groups[i]!.severity]).toBeGreaterThanOrEqual(sevRank[groups[i - 1]!.severity]);
    }
  });

  test("every group carries a valid autofix capability matching the registry", () => {
    for (const g of computeGroups(runFix("lint").issues)) {
      expect(["mechanical", "guided", "manual"]).toContain(g.autofix);
      expect(g.autofix).toBe(AUTOFIX[g.code]);
    }
  });

  test("STALE_FIELD is tagged mechanical", () => {
    const groups = computeGroups(runFix("stale-field").issues);
    const stale = groups.find((g) => g.code === "STALE_FIELD");
    expect(stale).toBeDefined();
    expect(stale!.autofix).toBe("mechanical");
  });

  test("per-severity counts sum to the group count", () => {
    for (const g of computeGroups(runFix("lint").issues)) {
      expect(g.errors + g.warns + g.infos).toBe(g.count);
    }
  });
});

describe("reportGroupsJson", () => {
  test("clean fixture → done:true, groupCount:0", () => {
    const r = runFix("clean");
    const j = JSON.parse(reportGroupsJson(r.issues, r.scannedFunctions));
    expect(j.done).toBe(true);
    expect(j.groupCount).toBe(0);
    expect(j.remaining).toBe(0);
    expect(j.groups).toEqual([]);
  });

  test("dirty fixture → done:false, groupCount matches", () => {
    const r = runFix("lint");
    const j = JSON.parse(reportGroupsJson(r.issues, r.scannedFunctions));
    expect(j.done).toBe(false);
    expect(j.groupCount).toBeGreaterThan(0);
    expect(j.remaining).toBe(r.issues.length);
  });
});

// ── CLI wiring (spawn the binary so the subcommand/flag plumbing is covered) ──
function cli(args: string[]) {
  const p = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

describe("CLI: groups / --only / agent-guide", () => {
  const dir = `${FIX}lint/convex`;

  test("`groups --json` emits the group menu", () => {
    const { out } = cli(["groups", "--convex-dir", dir, "--json"]);
    const j = JSON.parse(out);
    expect(j.groups.length).toBe(j.groupCount);
    expect(j.groups[0].code).toBeDefined();
    expect(j.groups[0].autofix).toBeDefined();
  });

  test("`--only <CODE>` narrows issues + summary to that code", () => {
    const { out } = cli(["--only", "AWAIT_IN_LOOP", "--convex-dir", dir, "--json"]);
    const j = JSON.parse(out);
    expect(new Set(j.issues.map((i: { code: string }) => i.code))).toEqual(
      new Set(["AWAIT_IN_LOOP"]),
    );
    // summary recomputed for the filtered set
    expect(j.summary.byCode.AWAIT_IN_LOOP).toBe(j.issues.length);
  });

  test("`--only <category>` narrows to a category", () => {
    const { out } = cli(["--only", "performance", "--convex-dir", dir, "--json"]);
    const j = JSON.parse(out);
    expect(new Set(j.issues.map((i: { category: string }) => i.category))).toEqual(
      new Set(["performance"]),
    );
  });

  test("`--only <bogus>` exits 2", () => {
    const { code } = cli(["--only", "NOT_A_CODE", "--convex-dir", dir]);
    expect(code).toBe(2);
  });

  test("`agent-guide` prints the loop recipe and exits 0", () => {
    const { code, out } = cli(["agent-guide"]);
    expect(code).toBe(0);
    expect(out).toContain("agentic fix loop");
    expect(out).toContain("--only <CODE>");
    expect(out).toContain("One group per commit");
  });
});
