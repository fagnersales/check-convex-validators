/**
 * Best-practice / lint rules — the "convex-doctor" layer.
 *
 * These rules fire on EVERY Convex codebase, independent of whether the project
 * opted into `returns:` validators (which the drift matcher needs). They encode
 * the Convex best-practices guide plus the rules the official
 * `@convex-dev/eslint-plugin` ships, so a user gets the whole sweep from one CLI
 * without ever installing or configuring ESLint.
 *
 * Design notes
 * ------------
 * - This module does its OWN discovery walk and is fully decoupled from the
 *   drift pipeline (scan.ts → match.ts). It only emits `Issue`s via `makeIssue`.
 * - Two passes:
 *     1. Registration-level rules — need the `query/mutation/...` call + its
 *        config object + handler (missing arg validator, old syntax, query/action
 *        body rules scoped by function kind).
 *     2. File-level rules — anchored on `ctx.db` / `ctx.*` patterns that only
 *        ever appear in Convex code, so scanning the whole file is FP-safe and
 *        also catches logic factored into `convex/model` helper functions.
 * - FP discipline mirrors the matcher: every rule has explicit guards (loop-
 *   carried dependency, pagination cursors, index-narrowed collects, JS array
 *   `.filter`, write-vs-read severity, etc.). Under-reporting beats crying wolf.
 */
import { Node, SyntaxKind } from "ts-morph";
import type { CallExpression, ObjectLiteralExpression, SourceFile } from "ts-morph";
import { makeIssue } from "./rules.ts";
import type { FunctionInfo, Issue } from "./types.ts";

const PUBLIC_KINDS = new Set(["query", "mutation", "action"]);
const ALL_KINDS = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

/** ctx methods that WRITE — sequential awaits of these in a loop carry an OCC
 *  caveat (parallel writes to the same doc can conflict), so we soften to info. */
const WRITE_METHODS = new Set(["insert", "patch", "replace", "delete", "runMutation"]);

/** Promise-returning surfaces of ctx.db / ctx.storage and the db-query terminators
 *  — the closed allow-list for FLOATING_CTX_PROMISE. */
const DB_PROMISE_METHODS = new Set(["insert", "patch", "replace", "delete", "get"]);
const STORAGE_METHODS = new Set(["store", "getUrl", "delete", "generateUploadUrl"]);
const QUERY_TERMINATORS = new Set(["collect", "first", "unique", "take", "paginate"]);

/** Cron registration methods on a cronJobs() instance. */
const CRON_METHODS = new Set(["interval", "cron", "hourly", "daily", "weekly", "monthly"]);

/** Node builtins that are unambiguous when imported bare (no `node:` prefix).
 *  Deliberately EXCLUDES polyfill-ambiguous names (crypto, util, events, buffer,
 *  assert, url, querystring, string_decoder, process) — a `node:`-prefixed import
 *  of any builtin is still flagged separately. */
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "child_process", "stream", "http", "https", "net", "tls",
  "dgram", "dns", "zlib", "readline", "worker_threads", "perf_hooks", "vm",
  "cluster", "inspector",
]);

export interface LintInput {
  sourceFiles: SourceFile[];
  /** Absolute path of schema.ts, skipped for handler-body rules. */
  schemaFilePath?: string;
}

export function lintProject(input: LintInput): Issue[] {
  const issues: Issue[] = [];
  const useNodeCache = new Map<string, boolean>();

  for (const sf of input.sourceFiles) {
    // The schema file gets its own pass (index / schemaValidation rules); it has
    // no handlers so the ctx-anchored passes don't apply.
    if (input.schemaFilePath && sf.getFilePath() === input.schemaFilePath) {
      lintSchemaFile(sf, issues);
      continue;
    }

    // Pass 1 — registration-level rules.
    const regs = collectRegistrations(sf);
    for (const reg of regs) {
      lintRegistration(reg, issues);
    }
    lintQueryInNodeFile(sf, regs, issues, useNodeCache);

    // Pass 2 — file-level rules (ctx-anchored; safe across helpers too).
    lintAwaitInLoop(sf, issues);
    lintQueryChains(sf, issues);
    lintSchedulePublic(sf, issues);
    lintCrons(sf, issues);
    lintFloatingPromise(sf, issues);
    lintRuntimeImports(sf, issues, useNodeCache);
    lintMisplacedUseNode(sf, issues, useNodeCache);
  }

  return issues;
}

// ── Discovery ───────────────────────────────────────────────────────────────

interface Registration {
  sf: SourceFile;
  call: CallExpression;
  fnKind: FunctionInfo["kind"];
  exportName: string;
  declLine: number;
  /** null when the function was registered with the legacy bare-function form. */
  cfg: ObjectLiteralExpression | null;
  handlerFn: Node | null;
}

function collectRegistrations(sf: SourceFile): Registration[] {
  const out: Registration[] = [];
  for (const stmt of sf.getStatements()) {
    if (!Node.isVariableStatement(stmt) || !stmt.isExported()) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || !Node.isCallExpression(init)) continue;
      const fnKind = registrationKind(init);
      if (!fnKind) continue;

      const arg0 = init.getArguments()[0];
      const cfg = arg0 && Node.isObjectLiteralExpression(arg0) ? arg0 : null;
      let handlerFn: Node | null = null;
      if (cfg) {
        for (const prop of cfg.getProperties()) {
          if (Node.isPropertyAssignment(prop) && prop.getName() === "handler") {
            handlerFn = resolveFn(prop.getInitializer() ?? null);
          }
        }
      } else if (arg0) {
        handlerFn = resolveFn(arg0); // legacy: query(async (ctx) => {...})
      }

      out.push({
        sf,
        call: init,
        fnKind,
        exportName: decl.getName(),
        declLine: decl.getStartLineNumber(),
        cfg,
        handlerFn,
      });
    }
  }
  return out;
}

function registrationKind(call: CallExpression): FunctionInfo["kind"] | null {
  const expr = call.getExpression();
  let name: string | null = null;
  if (Node.isIdentifier(expr)) name = expr.getText();
  else if (Node.isPropertyAccessExpression(expr)) name = expr.getName();
  if (!name || !ALL_KINDS.has(name)) return null;
  return name as FunctionInfo["kind"];
}

/** Resolve a handler value to an analyzable function node (inline or named). */
function resolveFn(node: Node | null): Node | null {
  if (!node) return null;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isFunctionDeclaration(node) && node.getBody()) return node;
  if (Node.isIdentifier(node)) {
    let defs: Node[] = [];
    try {
      defs = node.getDefinitionNodes();
    } catch {
      defs = [];
    }
    for (const d of defs) {
      if (Node.isFunctionDeclaration(d) && d.getBody()) return d;
      if (Node.isVariableDeclaration(d)) {
        const di = d.getInitializer();
        if (di && (Node.isArrowFunction(di) || Node.isFunctionExpression(di))) return di;
      }
    }
  }
  return null;
}

// ── Pass 1: registration-level rules ─────────────────────────────────────────

function lintRegistration(reg: Registration, issues: Issue[]): void {
  const isPublic = PUBLIC_KINDS.has(reg.fnKind);

  // OLD_FUNCTION_SYNTAX — registered with a bare function, no validators possible.
  if (!reg.cfg) {
    issues.push(
      makeIssue("OLD_FUNCTION_SYNTAX", {
        severity: "warn",
        filePath: reg.sf.getFilePath(),
        line: reg.declLine,
        function: reg.exportName,
        message: `${reg.exportName} is registered as ${reg.fnKind}(fn) instead of ${reg.fnKind}({ handler }), so it can't declare args or returns validators.`,
        pointer: pointerAt(reg.call.getExpression()),
        fixCode: { before: firstLines(registrationStatement(reg.call), 3) },
      }),
    );
  } else {
    // MISSING_ARG_VALIDATOR — object syntax but no `args`.
    const hasArgs = reg.cfg.getProperties().some(
      (p) => Node.isPropertyAssignment(p) && p.getName() === "args",
    );
    if (!hasArgs) {
      issues.push(
        makeIssue("MISSING_ARG_VALIDATOR", {
          severity: isPublic ? "warn" : "info",
          filePath: reg.sf.getFilePath(),
          line: reg.declLine,
          function: reg.exportName,
          message: isPublic
            ? `Public ${reg.fnKind} ${reg.exportName} has no \`args\` validator — client input reaches the handler unchecked.`
            : `${reg.fnKind} ${reg.exportName} has no \`args\` validator.`,
          why: isPublic ? undefined : "An args validator documents and type-checks the call signature; without it the arguments are typed `any`.",
          pointer: pointerAt(reg.call.getExpression()),
          fixCode: { before: firstLines(registrationStatement(reg.call), 3) },
        }),
      );
    }
  }

  if (!reg.handlerFn) return;
  const body = handlerBody(reg.handlerFn);
  if (!body) return;

  const isQuery = reg.fnKind === "query" || reg.fnKind === "internalQuery";
  const isMutation = reg.fnKind === "mutation" || reg.fnKind === "internalMutation";
  const isAction = reg.fnKind === "action" || reg.fnKind === "internalAction";

  // NONDETERMINISTIC_QUERY — only meaningful inside a (cached) query.
  if (isQuery) lintNondeterministic(reg, body, issues);

  // FETCH_IN_QUERY / CTX_RUN_IN_QUERY_OR_MUTATION — queries and mutations only.
  if (isQuery || isMutation) {
    lintFetchInQuery(reg, body, issues);
    lintCtxRunInQueryOrMutation(reg, body, issues);
  }

  // SEQUENTIAL_CTX_RUN / DB_IN_ACTION — actions only.
  if (isAction) {
    lintSequentialRun(reg, body, issues);
    lintDbInAction(reg, body, issues);
  }
}

function lintNondeterministic(reg: Registration, body: Node, issues: Issue[]): void {
  const seen = new Set<number>();
  for (const desc of body.getDescendants()) {
    let hit: Node | null = null;
    let label = "";
    if (Node.isCallExpression(desc)) {
      const e = desc.getExpression();
      if (Node.isPropertyAccessExpression(e)) {
        const recv = e.getExpression();
        if (Node.isIdentifier(recv) && recv.getText() === "Date" && e.getName() === "now") {
          hit = e;
          label = "Date.now()";
        } else if (Node.isIdentifier(recv) && recv.getText() === "Math" && e.getName() === "random") {
          hit = e;
          label = "Math.random()";
        }
      }
    } else if (Node.isNewExpression(desc)) {
      const e = desc.getExpression();
      if (Node.isIdentifier(e) && e.getText() === "Date" && (desc.getArguments()?.length ?? 0) === 0) {
        hit = desc;
        label = "new Date()";
      }
    }
    if (!hit) continue;
    const line = hit.getStartLineNumber();
    if (seen.has(line)) continue;
    seen.add(line);
    issues.push(
      makeIssue("NONDETERMINISTIC_QUERY", {
        severity: "warn",
        filePath: reg.sf.getFilePath(),
        line,
        function: reg.exportName,
        message: `${reg.exportName} reads ${label} inside a query. The value is fixed when the query runs, so the result won't update as time passes.`,
        pointer: pointerAt(hit),
        fixCode: { before: excerpt(enclosingStatement(hit), 4) },
      }),
    );
  }
}

function lintSequentialRun(reg: Registration, body: Node, issues: Issue[]): void {
  // Count statement-level `await ctx.runMutation(...)` that are NOT inside a loop
  // (a loop of runMutations is its own pattern, already covered by AWAIT_IN_LOOP).
  const runs: Node[] = [];
  for (const aw of body.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const inner = aw.getExpression();
    if (!Node.isCallExpression(inner)) continue;
    if (!isCtxMethodCall(inner, "runMutation")) continue;
    if (enclosingLoop(aw, body)) continue;
    runs.push(aw);
  }
  if (runs.length < 2) return;
  const first = runs[0]!;
  issues.push(
    makeIssue("SEQUENTIAL_CTX_RUN", {
      severity: "info",
      filePath: reg.sf.getFilePath(),
      line: first.getStartLineNumber(),
      function: reg.exportName,
      message: `${reg.exportName} runs ${runs.length} ctx.runMutation calls sequentially, each its own transaction. Consider one mutation so they commit atomically.`,
      pointer: pointerAt(first),
      fixCode: {
        before: runs.map((r) => excerpt(enclosingStatement(r), 3)).join("\n"),
      },
    }),
  );
}

/** FETCH_IN_QUERY — bare `fetch(...)` inside a query/mutation handler. */
function lintFetchInQuery(reg: Registration, body: Node, issues: Issue[]): void {
  const seen = new Set<number>();
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const e = call.getExpression();
    if (!Node.isIdentifier(e) || e.getText() !== "fetch") continue; // bare identifier only
    if (isShadowedByProject(e)) continue; // a local/import/param named fetch
    const line = call.getStartLineNumber();
    if (seen.has(line)) continue;
    seen.add(line);
    issues.push(
      makeIssue("FETCH_IN_QUERY", {
        severity: "error",
        filePath: reg.sf.getFilePath(),
        line,
        function: reg.exportName,
        message: `${reg.exportName} calls fetch() inside a ${reg.fnKind}. Queries and mutations run in a V8 isolate with no fetch, so this throws at runtime. Move the third-party call into an action.`,
        pointer: pointerAt(e),
        fixCode: { before: excerpt(enclosingStatement(call), 4) },
      }),
    );
  }
}

/** CTX_RUN_IN_QUERY_OR_MUTATION — ctx.runQuery/runMutation inside a query/mutation. */
function lintCtxRunInQueryOrMutation(reg: Registration, body: Node, issues: Issue[]): void {
  const seen = new Set<number>();
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const isRunQuery = isCtxMethodCall(call, "runQuery");
    const isRunMutation = isCtxMethodCall(call, "runMutation");
    if (!isRunQuery && !isRunMutation) continue;
    // Components can ONLY be reached via ctx.runQuery/runMutation — documented exception.
    const arg0 = call.getArguments()[0];
    if (arg0 && leftmostIdentifier(arg0) === "components") continue;
    const which = isRunQuery ? "runQuery" : "runMutation";
    const line = call.getStartLineNumber();
    if (seen.has(line)) continue;
    seen.add(line);
    const caveat = isRunMutation ? " (unless you need partial rollback on error)" : "";
    issues.push(
      makeIssue("CTX_RUN_IN_QUERY_OR_MUTATION", {
        severity: "info",
        filePath: reg.sf.getFilePath(),
        line,
        function: reg.exportName,
        message: `${reg.exportName} calls ctx.${which} inside a ${reg.fnKind}. It runs in the same transaction with extra overhead — prefer a plain TypeScript helper${caveat}.`,
        pointer: pointerAt(call.getExpression()),
        fixCode: { before: excerpt(enclosingStatement(call), 4) },
      }),
    );
  }
}

/** DB_IN_ACTION — ctx.db.* inside an action handler (ActionCtx has no db). */
function lintDbInAction(reg: Registration, body: Node, issues: Issue[]): void {
  const fn = reg.handlerFn;
  if (!fn || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn))) return;
  const param = fn.getParameters()[0];
  if (!param) return;
  const nameNode = param.getNameNode();

  // Case A: destructured ctx — `handler: async ({ db }) => ...`
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
      if (prop === "db") {
        issues.push(
          makeIssue("DB_IN_ACTION", {
            severity: "error",
            filePath: reg.sf.getFilePath(),
            line: el.getStartLineNumber(),
            function: reg.exportName,
            message: `${reg.exportName} is an ${reg.fnKind} that destructures \`db\` from ctx — actions have no database handle. Use ctx.runQuery / ctx.runMutation instead.`,
            pointer: pointerAt(el),
            fixCode: { before: excerpt(enclosingStatement(el), 3) },
          }),
        );
        return;
      }
    }
    return;
  }

  // Case B: identifier ctx param — flag the first `<ctx>.db` not shadowed by an
  // inner function param of the same name.
  if (!Node.isIdentifier(nameNode)) return;
  const ctxName = nameNode.getText();
  for (const pa of body.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.getName() !== "db") continue;
    const recv = pa.getExpression();
    if (!Node.isIdentifier(recv) || recv.getText() !== ctxName) continue;
    if (paramShadowedBetween(pa, ctxName, fn)) continue;
    issues.push(
      makeIssue("DB_IN_ACTION", {
        severity: "error",
        filePath: reg.sf.getFilePath(),
        line: pa.getStartLineNumber(),
        function: reg.exportName,
        message: `${reg.exportName} is an ${reg.fnKind} that uses ${ctxName}.db — actions have no database handle. Read/write the database via ctx.runQuery / ctx.runMutation.`,
        pointer: pointerAt(pa),
        fixCode: { before: excerpt(enclosingStatement(pa), 4) },
      }),
    );
    return; // one finding per action
  }
}

// ── Pass 2: file-level, ctx-anchored rules ───────────────────────────────────

function lintAwaitInLoop(sf: SourceFile, issues: Issue[]): void {
  // Group qualifying awaits by their innermost enclosing for-loop, emit once each.
  const byLoop = new Map<Node, { awaits: Node[]; anyRead: boolean }>();
  for (const aw of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const loop = enclosingForLoop(aw);
    if (!loop) continue;
    const inner = aw.getExpression();
    if (!inner) continue;
    if (leftmostIdentifier(inner) !== "ctx") continue; // only ctx round-trips
    const methods = methodNamesIn(inner);
    if (methods.has("paginate")) continue; // cursor loops are inherently sequential
    if (isLoopCarried(aw)) continue; // accumulator: iteration N needs N-1
    const isWrite = [...methods].some((m) => WRITE_METHODS.has(m));
    const entry = byLoop.get(loop) ?? { awaits: [], anyRead: false };
    entry.awaits.push(aw);
    if (!isWrite) entry.anyRead = true;
    byLoop.set(loop, entry);
  }

  for (const [loop, entry] of byLoop) {
    const first = entry.awaits[0]!;
    const n = entry.awaits.length;
    const plural = n === 1 ? "an awaited database call" : `${n} awaited database calls`;
    const before = excerpt(loop, 12);
    if (entry.anyRead) {
      issues.push(
        makeIssue("AWAIT_IN_LOOP", {
          severity: "warn",
          filePath: sf.getFilePath(),
          line: first.getStartLineNumber(),
          function: enclosingName(first),
          message: `This loop runs ${plural} sequentially, one round-trip per iteration. Issue them together with Promise.all so they run in parallel.`,
          pointer: pointerAt(first),
          fixCode: { before },
        }),
      );
    } else {
      // Writes only — softer, with the OCC caveat.
      issues.push(
        makeIssue("AWAIT_IN_LOOP", {
          severity: "info",
          filePath: sf.getFilePath(),
          line: first.getStartLineNumber(),
          function: enclosingName(first),
          message: `This loop awaits ${n} database write(s) sequentially. Promise.all parallelizes them, but only do so if the writes touch different documents (parallel writes to the same doc can conflict).`,
          why: "Sequential awaited writes are N round-trips. Batching with Promise.all parallelizes the latency; the OCC caveat is why this is info, not a warning.",
          pointer: pointerAt(first),
          fixCode: { before },
        }),
      );
    }
  }
}

function lintQueryChains(sf: SourceFile, issues: Issue[]): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (method !== "filter" && method !== "collect") continue;

    const chain = dbQueryChain(call);
    if (!chain.isDbQuery) continue; // not a ctx.db.query(...) chain → skip (JS array etc.)

    if (method === "filter") {
      // Documented exception: ".filter() benefits paginated queries since code
      // filtering may produce incomplete pages." Skip when the chain paginates.
      if (outerChainMethods(call).has("paginate")) continue;
      issues.push(
        makeIssue("FILTER_IN_QUERY", {
          severity: "warn",
          filePath: sf.getFilePath(),
          line: callee.getNameNode().getStartLineNumber(),
          function: enclosingName(call),
          message: `\`.filter()\` on a database query reads every matching row and filters in memory. Use an index (\`.withIndex\`) or filter the array in TypeScript.`,
          pointer: pointerAt(callee.getNameNode()),
          fixCode: { before: excerpt(enclosingStatement(call), 16) },
        }),
      );
    } else if (method === "collect" && !chain.methods.has("withIndex")) {
      issues.push(
        makeIssue("UNBOUNDED_COLLECT", {
          severity: "warn",
          filePath: sf.getFilePath(),
          line: callee.getNameNode().getStartLineNumber(),
          function: enclosingName(call),
          message: `\`.collect()\` on a query with no index loads every matching document. Narrow with \`.withIndex\`, cap with \`.take(n)\`, or page with \`.paginate()\`.`,
          pointer: pointerAt(callee.getNameNode()),
          fixCode: { before: excerpt(enclosingStatement(call), 16) },
        }),
      );
    }
  }
}

function lintSchedulePublic(sf: SourceFile, issues: Issue[]): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const name = callee.getName();

    // ctx.scheduler.runAfter(delay, fnRef, ...) / runAt(time, fnRef, ...) → arg[1]
    // ctx.runQuery/runMutation/runAction(fnRef, ...)                       → arg[0]
    let fnRefIdx = -1;
    if ((name === "runAfter" || name === "runAt") && isCtxSchedulerCall(callee)) fnRefIdx = 1;
    else if (
      (name === "runQuery" || name === "runMutation" || name === "runAction") &&
      isCtxReceiver(callee)
    )
      fnRefIdx = 0;
    if (fnRefIdx < 0) continue;

    const ref = call.getArguments()[fnRefIdx];
    if (!ref || leftmostIdentifier(ref) !== "api") continue; // internal.* / components.* are fine

    issues.push(
      makeIssue("SCHEDULE_PUBLIC_FN", {
        // Security best practice, documented verbatim in the Convex guide:
        // "Ensure all [ctx.run* / ctx.scheduler] use internal.foo.bar instead
        // of api.foo.bar." A public function is reachable by any client, so a
        // server-internal step left on api.* keeps an attack-surface function
        // exposed. Hence warn (matches MISSING_ARG_VALIDATOR on public fns).
        severity: "warn",
        filePath: sf.getFilePath(),
        line: ref.getStartLineNumber(),
        function: enclosingName(call),
        message: `This ${name} targets a public \`api.*\` function. Server-internal steps should reference \`internal.*\` so they aren't exposed on your public API.`,
        pointer: pointerAt(ref),
        fixCode: { before: excerpt(enclosingStatement(call), 5) },
      }),
    );
  }
}

/** WRONG_RUNTIME_IMPORT (relative import into a use-node file) + the inverse,
 *  NODE_BUILTIN_WITHOUT_USE_NODE (a Node builtin in a non-use-node file). The two
 *  never fire on the same import (one is relative, the other bare/node:). */
function lintRuntimeImports(sf: SourceFile, issues: Issue[], cache: Map<string, boolean>): void {
  if (isUseNode(sf, cache)) return; // a Node file may import Node code freely
  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec.startsWith(".")) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target || !isUseNode(target, cache)) continue;
      issues.push(
        makeIssue("WRONG_RUNTIME_IMPORT", {
          severity: "warn",
          filePath: sf.getFilePath(),
          line: imp.getStartLineNumber(),
          function: sf.getBaseNameWithoutExtension(),
          message: `Importing from "${spec}", a "use node" module, into a default-runtime file. The Node-runtime code can't load in Convex's V8 isolate.`,
          pointer: pointerAt(imp.getModuleSpecifier()),
          fixCode: { before: imp.getText() },
        }),
      );
      continue;
    }
    // Bare specifier — flag a Node builtin in a V8 file.
    if (imp.isTypeOnly()) continue; // type-only imports are erased at compile time
    const isNodeProtocol = spec.startsWith("node:");
    const base = (isNodeProtocol ? spec.slice(5) : spec).split("/")[0]!;
    if (!isNodeProtocol && !NODE_BUILTINS.has(base)) continue;
    issues.push(
      makeIssue("NODE_BUILTIN_WITHOUT_USE_NODE", {
        severity: "warn",
        filePath: sf.getFilePath(),
        line: imp.getStartLineNumber(),
        function: sf.getBaseNameWithoutExtension(),
        message: `Importing the Node builtin "${spec}" in a file with no "use node" directive. Convex's V8 isolate has no Node builtins, so this fails to load. Add "use node" (actions only) or use a runtime-neutral alternative.`,
        pointer: pointerAt(imp.getModuleSpecifier()),
        fixCode: { before: imp.getText() },
      }),
    );
  }
}

/** FLOATING_CTX_PROMISE — a promise-returning ctx.* call left un-awaited at
 *  statement position (no await / void / return / assignment / .then). */
function lintFloatingPromise(sf: SourceFile, issues: Issue[]): void {
  for (const stmt of sf.getDescendantsOfKind(SyntaxKind.ExpressionStatement)) {
    const expr = stmt.getExpression();
    // The statement-expression must BE the call itself — this single structural
    // check excludes `await x`, `void x`, `p = x`, `const p = x`, `return x`, and
    // `promises.push(x)` (there the statement-expression is push(...), not the ctx call).
    if (!Node.isCallExpression(expr)) continue;
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const n = callee.getName();
      if (n === "then" || n === "catch" || n === "finally") continue; // already handled
    }
    if (leftmostIdentifier(expr) !== "ctx") continue;
    const kind = floatablePromiseKind(expr);
    if (!kind) continue;
    const nameNode = Node.isPropertyAccessExpression(callee) ? callee.getNameNode() : callee;
    const msg =
      kind === "read"
        ? `This Convex read is not awaited and its result is discarded — dead code, or a missing \`await\`.`
        : `This ${kind} is not awaited, so it may never run and any error is swallowed. Add \`await\`.`;
    issues.push(
      makeIssue("FLOATING_CTX_PROMISE", {
        severity: "warn",
        filePath: sf.getFilePath(),
        line: nameNode.getStartLineNumber(),
        function: enclosingName(expr),
        message: msg,
        pointer: pointerAt(nameNode),
        fixCode: { before: excerpt(stmt, 4) },
      }),
    );
  }
}

/** CRON_PUBLIC_FN + DUPLICATE_CRON_ID — scan a cronJobs() instance's registrations. */
function lintCrons(sf: SourceFile, issues: Issue[]): void {
  // Bindings initialized from cronJobs() (imported from convex/server).
  const cronVars = new Set<string>();
  for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = vd.getInitializer();
    if (
      init &&
      Node.isCallExpression(init) &&
      Node.isIdentifier(init.getExpression()) &&
      init.getExpression().getText() === "cronJobs"
    ) {
      cronVars.add(vd.getName());
    }
  }
  if (cronVars.size === 0) return;

  const idsByVar = new Map<string, Set<string>>();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (!CRON_METHODS.has(method)) continue;
    const recv = callee.getExpression();
    if (!Node.isIdentifier(recv) || !cronVars.has(recv.getText())) continue;
    const args = call.getArguments();

    // DUPLICATE_CRON_ID — repeated string-literal identifier (arg 0) per instance.
    const id0 = args[0];
    if (id0 && (Node.isStringLiteral(id0) || Node.isNoSubstitutionTemplateLiteral(id0))) {
      const idVal = id0.getLiteralText();
      const seen = idsByVar.get(recv.getText()) ?? new Set<string>();
      if (seen.has(idVal)) {
        issues.push(
          makeIssue("DUPLICATE_CRON_ID", {
            severity: "error",
            filePath: sf.getFilePath(),
            line: id0.getStartLineNumber(),
            function: enclosingName(call),
            message: `Two cron jobs share the identifier "${idVal}". Convex rejects the deploy with "Cron identifier registered twice".`,
            pointer: pointerAt(id0),
            fixCode: { before: excerpt(enclosingStatement(call), 3) },
          }),
        );
      } else {
        seen.add(idVal);
      }
      idsByVar.set(recv.getText(), seen);
    }

    // CRON_PUBLIC_FN — function reference (arg 2) rooted at api.*
    const fnRef = args[2];
    if (fnRef && leftmostIdentifier(fnRef) === "api") {
      issues.push(
        makeIssue("CRON_PUBLIC_FN", {
          severity: "warn",
          filePath: sf.getFilePath(),
          line: fnRef.getStartLineNumber(),
          function: enclosingName(call),
          message: `This cron job schedules a public \`api.*\` function. Scheduled steps should reference \`internal.*\` so they aren't exposed on your public API.`,
          pointer: pointerAt(fnRef),
          fixCode: { before: excerpt(enclosingStatement(call), 3) },
        }),
      );
    }
  }
}

/** QUERY_IN_NODE_FILE — a query/mutation registered in a "use node" file. */
function lintQueryInNodeFile(
  sf: SourceFile,
  regs: Registration[],
  issues: Issue[],
  cache: Map<string, boolean>,
): void {
  if (!isUseNode(sf, cache)) return;
  for (const reg of regs) {
    if (
      reg.fnKind === "query" ||
      reg.fnKind === "mutation" ||
      reg.fnKind === "internalQuery" ||
      reg.fnKind === "internalMutation"
    ) {
      issues.push(
        makeIssue("QUERY_IN_NODE_FILE", {
          severity: "error",
          filePath: sf.getFilePath(),
          line: reg.declLine,
          function: reg.exportName,
          message: `${reg.exportName} is a ${reg.fnKind} in a "use node" file. Queries and mutations can't run in the Node runtime, so Convex rejects the deploy. Only actions belong in a "use node" file.`,
          pointer: pointerAt(reg.call.getExpression()),
          fixCode: { before: firstLines(registrationStatement(reg.call), 3) },
        }),
      );
    }
  }
}

/** MISPLACED_USE_NODE — a "use node" directive that isn't in the file prologue. */
function lintMisplacedUseNode(sf: SourceFile, issues: Issue[], cache: Map<string, boolean>): void {
  if (isUseNode(sf, cache)) return; // correctly placed at the top → fine
  let inPrologue = true;
  for (const st of sf.getStatements()) {
    if (inPrologue && Node.isExpressionStatement(st) && Node.isStringLiteral(st.getExpression())) {
      continue; // a leading directive (not "use node", else isUseNode would be true)
    }
    inPrologue = false;
    if (Node.isExpressionStatement(st)) {
      const e = st.getExpression();
      if (Node.isStringLiteral(e) && e.getLiteralValue() === "use node") {
        issues.push(
          makeIssue("MISPLACED_USE_NODE", {
            severity: "warn",
            filePath: sf.getFilePath(),
            line: st.getStartLineNumber(),
            function: sf.getBaseNameWithoutExtension(),
            message: `This "use node" directive is not at the top of the file, so the bundler ignores it and treats the file as a V8 module. Move it above all imports and statements.`,
            pointer: pointerAt(e),
            fixCode: { before: excerpt(st, 2) },
          }),
        );
        return;
      }
    }
  }
}

// ── Schema-file rules ─────────────────────────────────────────────────────────

/** REDUNDANT_INDEX + SCHEMA_VALIDATION_DISABLED — parsed straight off schema.ts. */
function lintSchemaFile(sf: SourceFile, issues: Issue[]): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    const name = callee.getText();

    if (name === "defineSchema") {
      const opts = call.getArguments()[1];
      if (opts && Node.isObjectLiteralExpression(opts)) {
        for (const p of opts.getProperties()) {
          if (Node.isPropertyAssignment(p) && p.getName() === "schemaValidation") {
            const init = p.getInitializer();
            if (init && init.getKind() === SyntaxKind.FalseKeyword) {
              issues.push(
                makeIssue("SCHEMA_VALIDATION_DISABLED", {
                  severity: "info",
                  filePath: sf.getFilePath(),
                  line: p.getStartLineNumber(),
                  function: "<schema>",
                  message: `\`schemaValidation: false\` turns off runtime schema enforcement — stored documents are no longer checked against this schema. Re-enable it once your data conforms (it's meant as a migration escape hatch).`,
                  pointer: pointerAt(p),
                  fixCode: { before: excerpt(p, 1) },
                }),
              );
            }
          }
        }
      }
    } else if (name === "defineTable") {
      const indexes = collectIndexes(call);
      for (let i = 0; i < indexes.length; i++) {
        for (let j = 0; j < indexes.length; j++) {
          if (i === j) continue;
          const a = indexes[i]!;
          const b = indexes[j]!;
          if (a.fields.length < b.fields.length && isPrefix(a.fields, b.fields)) {
            issues.push(
              makeIssue("REDUNDANT_INDEX", {
                severity: "warn",
                filePath: sf.getFilePath(),
                line: a.node.getStartLineNumber(),
                function: "<schema>",
                message: `Index "${a.name}" [${a.fields.join(", ")}] is a prefix of "${b.name}" [${b.fields.join(", ")}]. "${b.name}" already answers the same prefix lookups, so "${a.name}" is usually redundant (keep it only if you rely on its distinct _creationTime ordering).`,
                pointer: pointerAt(a.node.getExpression()),
                fixCode: { before: excerpt(a.node, 2) },
              }),
            );
            i = indexes.length; // one finding per short index
            break;
          }
        }
      }
    }
  }
}

interface IndexInfo {
  name: string;
  fields: string[];
  node: CallExpression;
}

/** Walk outward from a defineTable() call collecting `.index(name, [fields])`
 *  calls with string-literal name + all-string-literal field list. */
function collectIndexes(defineTableCall: CallExpression): IndexInfo[] {
  const out: IndexInfo[] = [];
  let cur: Node = defineTableCall;
  while (true) {
    const parent = cur.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) {
      const gp = parent.getParent();
      if (gp && Node.isCallExpression(gp) && gp.getExpression() === parent) {
        if (parent.getName() === "index") {
          const args = gp.getArguments();
          const nameArg = args[0];
          const fieldsArg = args[1];
          if (
            nameArg &&
            Node.isStringLiteral(nameArg) &&
            fieldsArg &&
            Node.isArrayLiteralExpression(fieldsArg)
          ) {
            const fields = fieldsArg.getElements().map((el) => (Node.isStringLiteral(el) ? el.getLiteralValue() : null));
            if (fields.every((f) => f !== null)) {
              out.push({ name: nameArg.getLiteralValue(), fields: fields as string[], node: gp });
            }
          }
        }
        cur = gp;
        continue;
      }
    }
    break;
  }
  return out;
}

function isPrefix(a: string[], b: string[]): boolean {
  if (a.length >= b.length) return false;
  return a.every((f, k) => f === b[k]);
}

// ── Shared AST helpers ───────────────────────────────────────────────────────

function handlerBody(fn: Node): Node | null {
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn)) {
    return fn.getBody() ?? null;
  }
  return null;
}

/** Innermost enclosing for / for-of / for-in loop, not crossing a function
 *  boundary. while/do are deliberately NOT treated as loops here (they are
 *  usually cursor/condition loops that are inherently sequential). */
function enclosingForLoop(node: Node): Node | null {
  let p = node.getParent();
  while (p) {
    const k = p.getKind();
    if (
      k === SyntaxKind.ForOfStatement ||
      k === SyntaxKind.ForInStatement ||
      k === SyntaxKind.ForStatement
    )
      return p;
    if (
      Node.isArrowFunction(p) ||
      Node.isFunctionExpression(p) ||
      Node.isFunctionDeclaration(p) ||
      Node.isMethodDeclaration(p)
    )
      return null;
    p = p.getParent();
  }
  return null;
}

/** Any enclosing loop (for/while/do), not crossing a function boundary. */
function enclosingLoop(node: Node, stopAt: Node): Node | null {
  let p = node.getParent();
  while (p && p !== stopAt.getParent()) {
    const k = p.getKind();
    if (
      k === SyntaxKind.ForOfStatement ||
      k === SyntaxKind.ForInStatement ||
      k === SyntaxKind.ForStatement ||
      k === SyntaxKind.WhileStatement ||
      k === SyntaxKind.DoStatement
    )
      return p;
    if (Node.isArrowFunction(p) || Node.isFunctionExpression(p) || Node.isFunctionDeclaration(p))
      return null;
    p = p.getParent();
  }
  return null;
}

/** True when the await assigns a variable that the awaited call also reads —
 *  i.e. an accumulator where iteration N depends on N-1; can't parallelize. */
function isLoopCarried(aw: Node): boolean {
  const parent = aw.getParent();
  let target: string | null = null;
  if (Node.isVariableDeclaration(parent)) target = parent.getName();
  else if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "=") {
    const lhs = parent.getLeft();
    if (Node.isIdentifier(lhs)) target = lhs.getText();
  }
  if (!target) return false;
  return aw
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((i) => i.getText() === target);
}

/** Leftmost identifier of a call/property/element chain (the receiver root). */
function leftmostIdentifier(node: Node): string | null {
  let cur: Node | undefined = node;
  while (cur) {
    if (Node.isIdentifier(cur)) return cur.getText();
    if (Node.isPropertyAccessExpression(cur)) cur = cur.getExpression();
    else if (Node.isElementAccessExpression(cur)) cur = cur.getExpression();
    else if (Node.isCallExpression(cur)) cur = cur.getExpression();
    else if (Node.isNonNullExpression(cur)) cur = cur.getExpression();
    else if (Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else if (Node.isAwaitExpression(cur)) cur = cur.getExpression();
    else return null;
  }
  return null;
}

/** All property-access method names appearing in an expression subtree. */
function methodNamesIn(node: Node): Set<string> {
  const out = new Set<string>();
  for (const pa of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    out.add(pa.getName());
  }
  if (Node.isPropertyAccessExpression(node)) out.add(node.getName());
  return out;
}

/** Walk a `.filter()/.collect()` receiver chain: collect method names and detect
 *  whether the base is a `ctx.db.query(...)` call. */
function dbQueryChain(call: CallExpression): { isDbQuery: boolean; methods: Set<string> } {
  const methods = new Set<string>();
  let isDbQuery = false;
  let cur: Node = call;
  while (true) {
    if (Node.isCallExpression(cur)) {
      const e = cur.getExpression();
      if (Node.isPropertyAccessExpression(e)) {
        methods.add(e.getName());
        if (e.getName() === "query") {
          const recv = e.getExpression();
          if (Node.isPropertyAccessExpression(recv) && recv.getName() === "db") isDbQuery = true;
        }
        cur = e.getExpression();
        continue;
      }
      break;
    } else if (Node.isPropertyAccessExpression(cur)) {
      cur = cur.getExpression();
      continue;
    } else if (Node.isNonNullExpression(cur)) {
      cur = cur.getExpression();
      continue;
    } else {
      break;
    }
  }
  return { isDbQuery, methods };
}

/** Method names called on the OUTER side of a chain (the calls that wrap this
 *  one), e.g. for `q.filter(...).order(...).paginate(...)` called on the filter
 *  node returns {order, paginate}. Used to honor documented chain exceptions. */
function outerChainMethods(call: CallExpression): Set<string> {
  const out = new Set<string>();
  let cur: Node = call;
  while (true) {
    const parent = cur.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) {
      const gp = parent.getParent();
      if (gp && Node.isCallExpression(gp) && gp.getExpression() === parent) {
        out.add(parent.getName());
        cur = gp;
        continue;
      }
    }
    break;
  }
  return out;
}

/** `<expr>.<method>(...)` where the receiver root identifier is `ctx`. */
function isCtxMethodCall(call: CallExpression, method: string): boolean {
  const e = call.getExpression();
  return Node.isPropertyAccessExpression(e) && e.getName() === method && isCtxReceiver(e);
}

/** PropertyAccess whose immediate receiver is the `ctx` identifier. */
function isCtxReceiver(pa: Node): boolean {
  if (!Node.isPropertyAccessExpression(pa)) return false;
  const recv = pa.getExpression();
  return Node.isIdentifier(recv) && recv.getText() === "ctx";
}

/** PropertyAccess `ctx.scheduler.<name>`. */
function isCtxSchedulerCall(pa: Node): boolean {
  if (!Node.isPropertyAccessExpression(pa)) return false;
  const recv = pa.getExpression();
  return Node.isPropertyAccessExpression(recv) && recv.getName() === "scheduler" && isCtxReceiver(recv);
}

/** PropertyAccess `ctx.<sub>.<name>` (e.g. ctx.db.get / ctx.storage.store). */
function isCtxSubReceiver(pa: Node, sub: string): boolean {
  if (!Node.isPropertyAccessExpression(pa)) return false;
  const recv = pa.getExpression();
  return Node.isPropertyAccessExpression(recv) && recv.getName() === sub && isCtxReceiver(recv);
}

/** Classify a ctx call as a floatable promise (for FLOATING_CTX_PROMISE), or null
 *  when it's a builder (ctx.db.query/.withIndex/.order) or not a known surface. */
function floatablePromiseKind(
  call: CallExpression,
): "database write" | "scheduling call" | "ctx.run call" | "storage call" | "read" | null {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const m = callee.getName();
  if (DB_PROMISE_METHODS.has(m) && isCtxSubReceiver(callee, "db")) {
    return m === "get" ? "read" : "database write";
  }
  if ((m === "runAfter" || m === "runAt") && isCtxSchedulerCall(callee)) return "scheduling call";
  if ((m === "runQuery" || m === "runMutation" || m === "runAction") && isCtxReceiver(callee))
    return "ctx.run call";
  if (STORAGE_METHODS.has(m) && isCtxSubReceiver(callee, "storage")) return "storage call";
  if (QUERY_TERMINATORS.has(m) && dbQueryChain(call).isDbQuery) return "read";
  return null;
}

/** True when an identifier resolves to a binding defined in a project source file
 *  (a local/param/import) rather than a lib `.d.ts` global — i.e. it's shadowed. */
function isShadowedByProject(id: Node): boolean {
  if (!Node.isIdentifier(id)) return false;
  let defs: Node[] = [];
  try {
    defs = id.getDefinitionNodes();
  } catch {
    defs = [];
  }
  return defs.some((d) => {
    const fp = d.getSourceFile().getFilePath();
    return !/\.d\.ts$/.test(fp) && !fp.includes("node_modules/typescript/");
  });
}

/** True when an inner function between `node` and `handlerFn` re-declares a param
 *  named `name` (so a `<name>.db` there is NOT the action's ctx). */
function paramShadowedBetween(node: Node, name: string, handlerFn: Node): boolean {
  let p: Node | undefined = node.getParent();
  while (p && p !== handlerFn) {
    if (
      Node.isArrowFunction(p) ||
      Node.isFunctionExpression(p) ||
      Node.isFunctionDeclaration(p) ||
      Node.isMethodDeclaration(p)
    ) {
      if (p.getParameters().some((pm) => pm.getName() === name)) return true;
    }
    p = p.getParent();
  }
  return false;
}

function isUseNode(sf: SourceFile, cache: Map<string, boolean>): boolean {
  const key = sf.getFilePath();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  for (const st of sf.getStatements()) {
    if (Node.isExpressionStatement(st)) {
      const e = st.getExpression();
      if (Node.isStringLiteral(e)) {
        if (e.getLiteralValue() === "use node") {
          result = true;
          break;
        }
        continue; // another directive — keep scanning
      }
    }
    break; // first non-directive statement → no "use node" prologue
  }
  cache.set(key, result);
  return result;
}

/** Nearest enclosing named binding (top-level export name when present). */
function enclosingName(node: Node): string {
  let p: Node | undefined = node.getParent();
  let name = "<handler>";
  while (p) {
    if (Node.isVariableDeclaration(p)) name = p.getName() || name;
    else if (Node.isFunctionDeclaration(p)) name = p.getName() || name;
    p = p.getParent();
  }
  return name;
}

/** Complete, dedented source of a node for the report's "before" pane, capped at
 *  `maxLines` (long bodies show the salient head + an ellipsis). */
function excerpt(node: Node, maxLines = 14): string {
  const lines = dedentLines(node.getText().split("\n"));
  return lines.length <= maxLines ? lines.join("\n") : [...lines.slice(0, maxLines), "// ..."].join("\n");
}

/** First `n` lines of a node (for registration heads). */
function firstLines(node: Node, n: number): string {
  const lines = dedentLines(node.getText().split("\n"));
  return lines.length <= n ? lines.join("\n") : [...lines.slice(0, n), "  // ..."].join("\n");
}

function dedentLines(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^\s*/)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

/** Nearest enclosing complete statement (its parent is a block / source file),
 *  so the "before" shows the whole offending expression, never a sliced line. */
function enclosingStatement(node: Node): Node {
  let cur = node;
  let p = cur.getParent();
  while (
    p &&
    !Node.isBlock(p) &&
    !Node.isSourceFile(p) &&
    !Node.isModuleBlock(p) &&
    !Node.isCaseClause(p) &&
    !Node.isDefaultClause(p)
  ) {
    cur = p;
    p = cur.getParent();
  }
  return cur;
}

/** The enclosing `export const x = query({ ... })` statement, for reg-level rules. */
function registrationStatement(call: CallExpression): Node {
  return call.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? call;
}

/** 0-based caret pointer for the report excerpt. */
function pointerAt(node: Node): { line: number; column: number; length?: number } {
  const sf = node.getSourceFile();
  const lc = sf.getLineAndColumnAtPos(node.getStart());
  const firstLine = node.getText().split("\n")[0] ?? "";
  return { line: lc.line, column: Math.max(0, lc.column - 1), length: Math.min(firstLine.length || 1, 40) };
}
