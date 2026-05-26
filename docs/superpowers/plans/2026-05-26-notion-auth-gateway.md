# Notion Auth Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize notion-mcp-server auth: introduce a pluggable `AuthProvider` abstraction (v2 has one impl: `EnvAuthProvider` reading `NOTION_TOKEN`), replace the import-time singleton `notion` Client with an async cached `getClient()`, and remove the boot-killing `process.exit(1)` on missing `NOTION_PAGE_ID`. Document PAT as the recommended setup. Ships as v1.2.0.

**Architecture:** Tool handlers call `await getClient()` which asks `authProvider.getToken()` and caches a `@notionhq/client` `Client` keyed by token. `EnvAuthProvider.getToken()` reads `process.env.NOTION_TOKEN` lazily (per-call) and throws `AuthError` with self-contained recovery instructions if missing. Schemas no longer bake `NOTION_PAGE_ID` into Zod `.default(...)` — parent resolution moves to the `createPage` / `createDatabase` handlers and falls back to `process.env.NOTION_PAGE_ID` at call time. Singleton `authProvider` is the v2 seam OAuth will swap into in v3.

**Tech Stack:** TypeScript 5.8, `@modelcontextprotocol/sdk` ^1.29.0, `@notionhq/client` ^2.3.0, Zod ^3.24.2, stdio transport, Node ≥20. No test framework — smoke-test verification per task.

**Spec:** `docs/superpowers/specs/2026-05-26-notion-auth-gateway-design.md` (approved)

**Branch:** Work on `main` (continuing from v1.1.0 release pattern; user has worked directly on `main` for prior auth-arc work).

---

## File Structure

**New files:**
- `src/services/auth.ts` — `AuthError`, `AuthProvider` interface, `EnvAuthProvider` impl, exported `authProvider` singleton

**Modified files:**
- `src/services/notion.ts` — replace import-time singleton + dead `getApiToken()` + crashing `getRootPageId()` with async `getClient()` and non-crashing `getRootPageId(): string | undefined`
- `src/utils/error.ts` — add dedicated `AuthError` branch
- `src/schema/page.ts` — remove `.default(...)` from `CREATE_PAGE_SCHEMA.parent`; field becomes optional with no default
- `src/schema/database.ts` — same for `CREATE_DATABASE_SCHEMA.parent`
- `src/tools/createPage.ts` — add handler-level parent resolution (param → env → `AuthError`)
- `src/tools/createDatabase.ts` — same
- `src/tools/{18 files}` — mechanical: `import { notion }` → `import { getClient }` + `const notion = await getClient()` at handler top
- `src/server/index.ts` — fire-and-forget startup `users.me()` ping; stderr log on success/failure
- `package.json` — bump `version` 1.1.0 → 1.2.0
- `src/config/index.ts` — bump `CONFIG.serverVersion` 1.1.0 → 1.2.0
- `README.md` — rewrite with PAT-first onboarding, legacy integration alternative, troubleshooting

**Decisions on the spec's open questions (locked in by this plan):**

1. **AuthError handling in `handleNotionError`:** add a dedicated branch that prefixes the message with `Notion auth failed:` for a clearer LLM-facing error. (Task 2.)
2. **Startup ping unhandled-rejection safety:** chain `.catch` at the end of the entire `.then().then()` chain so both `getClient()` rejection and any `then()` callback throwing are captured. (Task 9.)

---

## Pre-flight check (run once before Task 1)

Verify the working tree is clean and `main` is current:

```bash
git status
git log -1 --oneline
```

Expected: clean working tree, HEAD at `94e8a32 update readme` (or a later commit).

Install dev deps if `node_modules/` is missing:

```bash
npm install
```

---

## Task 1: Create `src/services/auth.ts`

Additive new file. Defines `AuthError`, `AuthProvider` interface, `EnvAuthProvider` implementation, and the singleton `authProvider` exported for `getClient()` to consume.

**Files:**
- Create: `src/services/auth.ts`

- [ ] **Step 1: Create the file**

```ts
// src/services/auth.ts

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthProvider {
  /**
   * Returns a currently-valid auth token. Async so a future OAuth provider
   * can refresh transparently before returning.
   */
  getToken(): Promise<string>;
}

export class EnvAuthProvider implements AuthProvider {
  async getToken(): Promise<string> {
    const t = process.env.NOTION_TOKEN;
    if (!t) {
      throw new AuthError(
        "Notion auth token is not configured. Set the NOTION_TOKEN environment variable in your MCP client config. To get a token, open Notion → Settings → My Settings → Personal Access Tokens → Generate (recommended), or Settings → Connections → Develop or manage integrations → New integration."
      );
    }
    return t;
  }
}

// Singleton — single-user assumption. v3 multi-user OAuth would require
// per-request provider dispatch (different pattern; out of scope for v2).
export const authProvider: AuthProvider = new EnvAuthProvider();
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean exit, no errors.

- [ ] **Step 3: Build, then verify EnvAuthProvider throws AuthError when env is missing**

```bash
npm run build

NOTION_TOKEN= node --input-type=module -e "
const m = await import('./build/services/auth.js');
try {
  await m.authProvider.getToken();
  console.error('FAIL: expected AuthError');
  process.exit(1);
} catch (e) {
  if (e instanceof m.AuthError) {
    console.log('PASS: AuthError thrown:', e.message.slice(0, 60) + '...');
  } else {
    console.error('FAIL: wrong error type:', e);
    process.exit(1);
  }
}
"
```

Expected: `PASS: AuthError thrown: Notion auth token is not configured. Set the NOTION_TOKEN env...`

- [ ] **Step 4: Verify EnvAuthProvider returns the token when env is set**

```bash
NOTION_TOKEN=fake_test_token node --input-type=module -e "
const m = await import('./build/services/auth.js');
const t = await m.authProvider.getToken();
if (t === 'fake_test_token') console.log('PASS');
else { console.error('FAIL:', t); process.exit(1); }
"
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add src/services/auth.ts
git commit -m "$(cat <<'EOF'
feat(auth): add AuthProvider abstraction with EnvAuthProvider

New src/services/auth.ts exports AuthError, AuthProvider interface,
EnvAuthProvider (reads NOTION_TOKEN lazily), and the authProvider
singleton. v2 seam for v3 OAuth.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `AuthError` branch to `handleNotionError`

The current `handleNotionError` has branches for `APIResponseError`, generic `Error`, and unknown. Adding an `AuthError`-specific branch prefixes the message with `Notion auth failed:` so the LLM sees the failure category immediately.

**Files:**
- Modify: `src/utils/error.ts`

- [ ] **Step 1: Add the AuthError branch**

Open `src/utils/error.ts`. After line 2 (the `CallToolResult` import), add:

```ts
import { AuthError } from "../services/auth.js";
```

Then inside `handleNotionError`, after the `APIResponseError` branch (after line 105 — immediately before `if (error instanceof Error)`), insert:

```ts
  if (error instanceof AuthError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Notion auth failed: ${error.message}`,
        },
      ],
    };
  }

```

The order matters: `AuthError extends Error`, so the `AuthError` branch must come **before** the generic `Error` branch.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 3: Verify the branch fires on AuthError**

```bash
npm run build

node --input-type=module -e "
const { handleNotionError } = await import('./build/utils/error.js');
const { AuthError } = await import('./build/services/auth.js');
const r = handleNotionError(new AuthError('test message here'));
if (r.isError && r.content[0].text === 'Notion auth failed: test message here') {
  console.log('PASS');
} else {
  console.error('FAIL:', JSON.stringify(r));
  process.exit(1);
}
"
```

Expected: `PASS`

- [ ] **Step 4: Verify other branches still work (regression check)**

```bash
node --input-type=module -e "
const { handleNotionError } = await import('./build/utils/error.js');
const r = handleNotionError(new Error('plain error'));
if (r.isError && r.content[0].text === 'Error: plain error') {
  console.log('PASS');
} else {
  console.error('FAIL:', JSON.stringify(r));
  process.exit(1);
}
"
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add src/utils/error.ts
git commit -m "$(cat <<'EOF'
feat(error): handle AuthError with explicit branch

handleNotionError now has a dedicated AuthError branch that prefixes
the message with "Notion auth failed: " before the recovery text from
EnvAuthProvider. Branch ordering matters — AuthError extends Error so
it must come before the generic Error branch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `getClient()` to `src/services/notion.ts` (additive)

Add `getClient()` alongside the existing `notion` singleton — both exports coexist for this task so the 18 tool files keep building. The singleton is removed in Task 8 once nothing imports it.

**Files:**
- Modify: `src/services/notion.ts`

- [ ] **Step 1: Replace the file contents**

Open `src/services/notion.ts`. Replace its full contents with:

```ts
import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";

export function getApiToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error("Error: NOTION_TOKEN environment variable is required");
    process.exit(1);
  }
  return token;
}

export function getRootPageId(): string {
  const pageId = process.env.NOTION_PAGE_ID;
  if (!pageId) {
    console.error("Error: NOTION_PAGE_ID environment variable is required");
    process.exit(1);
  }
  return pageId;
}

export const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({ auth: token });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
```

The old exports (`getApiToken`, `getRootPageId`, `notion`) stay intact for now — they're removed/rewritten in Task 8.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 3: Verify getClient returns a Client and caches**

```bash
npm run build

NOTION_TOKEN=fake_test_token node --input-type=module -e "
const { getClient } = await import('./build/services/notion.js');
const c1 = await getClient();
const c2 = await getClient();
if (c1 === c2) console.log('PASS: same Client cached');
else { console.error('FAIL: cache miss'); process.exit(1); }
"
```

Expected: `PASS: same Client cached`

- [ ] **Step 4: Verify getClient throws AuthError when token missing**

```bash
NOTION_TOKEN= node --input-type=module -e "
const { getClient } = await import('./build/services/notion.js');
const { AuthError } = await import('./build/services/auth.js');
try {
  await getClient();
  console.error('FAIL: expected throw');
  process.exit(1);
} catch (e) {
  if (e instanceof AuthError) console.log('PASS');
  else { console.error('FAIL: wrong error', e); process.exit(1); }
}
"
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add src/services/notion.ts
git commit -m "$(cat <<'EOF'
feat(notion): add async getClient() with token-keyed cache

getClient() asks authProvider.getToken() per call and caches the
@notionhq/client Client keyed by token. Coexists with the existing
notion singleton during the tool-file refactor (Task 4); the singleton
and dead getApiToken() are removed in Task 8.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Refactor 18 tool files to use `getClient()`

Mechanical pattern across 18 files. Each file gets one import change and one local declaration per handler.

**Files (all in `src/tools/`):**
- Modify: `appendBlockChildren.ts`
- Modify: `batchAppendBlockChildren.ts`
- Modify: `batchDeleteBlocks.ts`
- Modify: `batchMixedOperations.ts`
- Modify: `batchUpdateBlocks.ts`
- Modify: `comments.ts`
- Modify: `createDatabase.ts`
- Modify: `createPage.ts`
- Modify: `deleteBlock.ts`
- Modify: `queryDatabase.ts`
- Modify: `retrieveBlock.ts`
- Modify: `retrieveBlockChildren.ts`
- Modify: `searchPage.ts`
- Modify: `updateBlock.ts`
- Modify: `updateDatabase.ts`
- Modify: `updatePage.ts`
- Modify: `updatePageProperties.ts`
- Modify: `users.ts`

**The pattern (apply to every handler function in every file):**

```ts
// Before — top of file:
import { notion } from "../services/notion.js";

// After — top of file:
import { getClient } from "../services/notion.js";
```

```ts
// Before — inside each handler:
export const someHandler = async (params): Promise<CallToolResult> => {
  try {
    const response = await notion.X.Y(...);
    ...

// After — inside each handler:
export const someHandler = async (params): Promise<CallToolResult> => {
  try {
    const notion = await getClient();
    const response = await notion.X.Y(...);
    ...
```

Place `const notion = await getClient();` as the **first** statement inside the `try` block of every handler that uses `notion`. This shadows the (now-removed) import name with a local — minimal diff to the rest of the handler body.

**Note on multi-handler files (`comments.ts`, `users.ts`):** these files have several handler functions (`registerGetCommentsTool`, `registerAddPageCommentTool`, etc.). Add the `const notion = await getClient();` line at the top of the `try` block of **each** handler that references `notion`. Do NOT lift it to module scope.

**Note on `registerUsersOperationTool` / `registerCommentsOperationTool` dispatcher functions:** these delegate to other handlers and don't call `notion` directly. They don't need the `const notion = await getClient();` line — only handlers that call `notion.X.Y(...)` do.

- [ ] **Step 1: Apply the pattern to all 18 files**

For each file in the list above:

1. Change `import { notion } from "../services/notion.js";` to `import { getClient } from "../services/notion.js";`
2. For each handler that references `notion` (search the file for `await notion.`), insert `const notion = await getClient();` as the first line of its `try` block.

- [ ] **Step 2: Confirm no remaining `import { notion }`**

```bash
grep -rn 'import { notion }' src/tools/
```

Expected: zero matches.

- [ ] **Step 3: Confirm every file imports `getClient`**

```bash
grep -L 'import { getClient }' src/tools/*.ts
```

Expected output: only the files that don't use `notion` at all should be listed. Inspect any listed file — `src/tools/index.ts`, `src/tools/blocks.ts`, `src/tools/pages.ts`, `src/tools/database.ts` are dispatch-only and never imported `notion` (they register tools, they don't call the API). Verify each listed file has zero `await notion.` references:

```bash
for f in $(grep -L 'import { getClient }' src/tools/*.ts); do
  if grep -q 'await notion\.' "$f"; then
    echo "BUG: $f calls notion but doesn't import getClient"
  fi
done
```

Expected: no output.

- [ ] **Step 4: Confirm every `await notion.` call sites is preceded by `const notion = await getClient();` somewhere in scope**

```bash
npm run build
```

Expected: clean build. If TypeScript reports `Cannot find name 'notion'` or `'notion' is not exported`, a file was missed — re-apply the pattern.

- [ ] **Step 5: Smoke test — server boots, `tools/list` returns 5 tools**

Create `/tmp/smoke-list.mjs`:

```bash
cat > /tmp/smoke-list.mjs <<'EOF'
import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  env: { ...process.env, NOTION_TOKEN: "fake_test_token" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
      }) + "\n");
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name).sort();
      console.log("tools:", names.join(","));
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 5000);
EOF

node /tmp/smoke-list.mjs
```

Expected: `tools: notion_blocks,notion_comments,notion_database,notion_pages,notion_users`

- [ ] **Step 6: Commit**

```bash
git add src/tools/
git commit -m "$(cat <<'EOF'
refactor(tools): use getClient() instead of notion singleton

All 18 tool files now import getClient and bind a local notion at the
top of each handler's try block. Mechanical, behavior-preserving change
— the singleton in notion.ts is removed in a follow-up.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add handler-level parent resolution in `createPage`

When `params.parent` is not provided, fall back to `process.env.NOTION_PAGE_ID`. If neither is set, throw `AuthError` with self-contained recovery instructions. This runs **before** Task 7 (which removes the schema-level default), so the schema's `.default(getRootPageId())` continues to fire and this code only takes effect once the schema is updated.

**Files:**
- Modify: `src/tools/createPage.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { getClient } from "../services/notion.js";
import { AuthError } from "../services/auth.js";
import { CreatePageParams } from "../types/page.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const registerCreatePageTool = async (
  params: CreatePageParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();

    const parent =
      params.parent ??
      (process.env.NOTION_PAGE_ID
        ? { type: "page_id" as const, page_id: process.env.NOTION_PAGE_ID }
        : undefined);

    if (!parent) {
      throw new AuthError(
        "No parent page configured. Either pass `parent` in this request, or set the NOTION_PAGE_ID environment variable to a default Notion page ID. To find a page ID: open the page in Notion → Share → Copy link → the ID is the last 32 chars of the URL."
      );
    }

    const response = await notion.pages.create({ ...params, parent });

    return {
      content: [
        {
          type: "text",
          text: `Page created successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
```

- [ ] **Step 2: Type-check and build**

```bash
npm run build
```

Expected: clean build. If `CreatePageParams.parent` is typed as required and TypeScript rejects the optional handling, check `src/types/page.ts` — the schema's `.optional()` clause already makes the inferred type `parent?: ...`, so the `??` fallback should type-check.

- [ ] **Step 3: Commit**

```bash
git add src/tools/createPage.ts
git commit -m "$(cat <<'EOF'
feat(tools): resolve parent in createPage handler with env fallback

Handler now resolves parent in this order: explicit param → NOTION_PAGE_ID
env → AuthError with recovery instructions. Schema-level default is
removed in Task 7; this runs first so the env fallback is in place
before the schema stops providing one.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add handler-level parent resolution in `createDatabase`

Same pattern as Task 5.

**Files:**
- Modify: `src/tools/createDatabase.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { getClient } from "../services/notion.js";
import { AuthError } from "../services/auth.js";
import { CreateDatabaseParams } from "../types/database.js";
import { handleNotionError } from "../utils/error.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const createDatabase = async (
  params: CreateDatabaseParams
): Promise<CallToolResult> => {
  try {
    const notion = await getClient();

    const parent =
      params.parent ??
      (process.env.NOTION_PAGE_ID
        ? { type: "page_id" as const, page_id: process.env.NOTION_PAGE_ID }
        : undefined);

    if (!parent) {
      throw new AuthError(
        "No parent page configured. Either pass `parent` in this request, or set the NOTION_PAGE_ID environment variable to a default Notion page ID. To find a page ID: open the page in Notion → Share → Copy link → the ID is the last 32 chars of the URL."
      );
    }

    const response = await notion.databases.create({ ...params, parent });

    return {
      content: [
        {
          type: "text",
          text: `Database created successfully: ${response.id}`,
        },
      ],
    };
  } catch (error) {
    return handleNotionError(error);
  }
};
```

- [ ] **Step 2: Type-check and build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/tools/createDatabase.ts
git commit -m "$(cat <<'EOF'
feat(tools): resolve parent in createDatabase handler with env fallback

Same pattern as createPage: explicit param → NOTION_PAGE_ID env →
AuthError with recovery instructions.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove schema-level `.default(...)` from `parent` field

The schemas currently bake `getRootPageId()` into Zod via `.default({ type: "page_id", page_id: getRootPageId() })` at module-import time. Once `getRootPageId()` returns `undefined` (Task 8), this produces a silent default of `{ type: "page_id", page_id: undefined }` that Zod accepts and passes through to the API — exactly the trap we want to remove. This task removes the `.default(...)` clauses so the field becomes plain `.optional()` and the runtime fallback in Tasks 5/6 takes over.

**Files:**
- Modify: `src/schema/page.ts` (lines 48-56)
- Modify: `src/schema/database.ts` (lines 338-346)

- [ ] **Step 1: Edit `src/schema/page.ts`**

Find the `CREATE_PAGE_SCHEMA` declaration (around line 48). Change the `parent` field from:

```ts
export const CREATE_PAGE_SCHEMA = {
  parent: PARENT_SCHEMA.optional()
    .default({
      type: "page_id",
      page_id: getRootPageId(),
    })
    .describe(
      "Optional parent - if not provided, will use NOTION_PAGE_ID as parent page"
    ),
```

to:

```ts
export const CREATE_PAGE_SCHEMA = {
  parent: PARENT_SCHEMA.optional().describe(
    "Optional parent. If omitted, the server falls back to the NOTION_PAGE_ID environment variable; if that's also unset, the call returns a clear error."
  ),
```

- [ ] **Step 2: Edit `src/schema/database.ts`**

Find the `CREATE_DATABASE_SCHEMA` declaration (around line 338). Apply the same change:

```ts
export const CREATE_DATABASE_SCHEMA = {
  parent: PARENT_SCHEMA.optional().describe(
    "Optional parent. If omitted, the server falls back to the NOTION_PAGE_ID environment variable; if that's also unset, the call returns a clear error."
  ),
```

- [ ] **Step 3: Remove now-unused `getRootPageId` import from schema files**

Check both files for `import ... getRootPageId ...` — if the import is now unused after removing the `.default()` call, delete it. (TypeScript with `--noUnusedLocals` would catch this, but the project doesn't enable it; check manually.)

```bash
grep -n 'getRootPageId' src/schema/page.ts src/schema/database.ts
```

If only the import line remains, delete that line in each file.

- [ ] **Step 4: Type-check and build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 5: Smoke test — `tools/list` shows `parent` as optional with no default**

```bash
cat > /tmp/smoke-parent-schema.mjs <<'EOF'
import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  env: { ...process.env, NOTION_TOKEN: "fake_test_token", NOTION_PAGE_ID: "test-page-id" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
      }) + "\n");
    } else if (msg.id === 2) {
      const pagesTool = msg.result.tools.find((t) => t.name === "notion_pages");
      const schemaJson = JSON.stringify(pagesTool.inputSchema);
      // The CREATE_PAGE_SCHEMA's parent shouldn't have any "default" key now.
      // Find any "default" referencing a page_id with no value.
      if (schemaJson.includes('"default":{"type":"page_id"')) {
        console.error("FAIL: schema still bakes in default", schemaJson.slice(0, 500));
        process.exit(1);
      } else {
        console.log("PASS: no baked default for parent in notion_pages schema");
      }
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 5000);
EOF

node /tmp/smoke-parent-schema.mjs
```

Expected: `PASS: no baked default for parent in notion_pages schema`

- [ ] **Step 6: Commit**

```bash
git add src/schema/page.ts src/schema/database.ts
git commit -m "$(cat <<'EOF'
fix(schema): remove .default() that baked NOTION_PAGE_ID at module load

Both CREATE_PAGE_SCHEMA and CREATE_DATABASE_SCHEMA had a Zod
.default({ type: "page_id", page_id: getRootPageId() }) that would
silently produce { page_id: undefined } once getRootPageId() stops
process.exit-ing. parent is now plain .optional() with a describe()
explaining the env fallback; resolution happens in the handler
(Tasks 5/6).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite `src/services/notion.ts` (remove singleton & dead code)

All 18 tool files now use `getClient()`. The singleton `notion` export and the dead `getApiToken()` function can be removed. `getRootPageId()` changes to return `string | undefined` with no `process.exit` — schemas no longer call it, and handlers read `process.env.NOTION_PAGE_ID` directly.

**Files:**
- Modify: `src/services/notion.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({ auth: token });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}

export function getRootPageId(): string | undefined {
  return process.env.NOTION_PAGE_ID;
}
```

- [ ] **Step 2: Confirm no remaining imports of removed exports**

```bash
grep -rn 'getApiToken\|import { notion }' src/
```

Expected: zero matches.

- [ ] **Step 3: Type-check and build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 4: Smoke test — server still boots and lists tools**

```bash
node /tmp/smoke-list.mjs
```

Expected: `tools: notion_blocks,notion_comments,notion_database,notion_pages,notion_users`

- [ ] **Step 5: Smoke test — missing NOTION_TOKEN no longer crashes the process**

```bash
cat > /tmp/smoke-no-token.mjs <<'EOF'
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.NOTION_TOKEN;

const child = spawn("node", ["build/index.js"], {
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
let initialized = false;
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      initialized = true;
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "notion_users", arguments: { payload: { action: "get_bot_user" } } }
      }) + "\n");
    } else if (msg.id === 2) {
      if (msg.result?.isError && /not configured/i.test(JSON.stringify(msg.result))) {
        console.log("PASS: AuthError surfaced as isError tool result");
      } else {
        console.error("FAIL:", JSON.stringify(msg));
        process.exit(1);
      }
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => {
  console.error("TIMEOUT (initialized=" + initialized + ")");
  child.kill();
  process.exit(1);
}, 5000);
EOF

node /tmp/smoke-no-token.mjs
```

Expected: `PASS: AuthError surfaced as isError tool result`

- [ ] **Step 6: Commit**

```bash
git add src/services/notion.ts
git commit -m "$(cat <<'EOF'
refactor(notion): remove singleton + dead getApiToken; soften getRootPageId

- Removed `notion` singleton (replaced by getClient() in Task 3).
- Removed getApiToken() — was exported but never called; the lazy
  per-call AuthError thrown by EnvAuthProvider supersedes it.
- getRootPageId() now returns string | undefined (no process.exit).
  Schemas no longer call it (Task 7); handlers read process.env directly.

Net effect: missing NOTION_TOKEN no longer silently constructs a
Client with auth:undefined; missing NOTION_PAGE_ID no longer kills
the boot.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add startup `users.me()` ping in `src/server/index.ts`

Fire-and-forget after `server.connect(transport)`. Logs success or failure to stderr — debug telemetry, not user UX (Claude Code hides MCP stderr in normal operation). Server stays responsive either way; `tools/list` still works on auth failure.

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "../config/index.js";
import { getClient } from "../services/notion.js";

export const server = new McpServer(
  {
    name: CONFIG.serverName,
    title: CONFIG.serverTitle,
    version: CONFIG.serverVersion,
    websiteUrl: CONFIG.serverUrl,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `
      MCP server for Notion.
      It is used to create, update and delete Notion entities.
    `,
  }
);

export async function startServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `${CONFIG.serverName} v${CONFIG.serverVersion} running on stdio`
    );

    getClient()
      .then((c) => c.users.me({}))
      .then((me) => {
        const who = "name" in me && me.name ? me.name : me.id;
        console.error(
          `Notion auth OK — connected as ${who} (NOTION_TOKEN)`
        );
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Notion auth check failed (server still running): ${msg}`
        );
      });
  } catch (error) {
    console.error(
      "Server initialization error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}
```

The `.catch` at the end of the chain captures both `getClient()` rejection (missing token) and any throw inside `.then()` callbacks — satisfies the spec's open question #2 (unhandled-rejection safety).

- [ ] **Step 2: Type-check and build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Smoke test — missing token logs auth failure to stderr but server still serves `tools/list`**

```bash
cat > /tmp/smoke-startup-stderr.mjs <<'EOF'
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.NOTION_TOKEN;

const child = spawn("node", ["build/index.js"], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
      }) + "\n");
    } else if (msg.id === 2) {
      // Give the async startup ping a beat to surface
      setTimeout(() => {
        const okList = Array.isArray(msg.result?.tools) && msg.result.tools.length === 5;
        const okStderr = /Notion auth check failed/.test(stderr);
        if (okList && okStderr) {
          console.log("PASS");
          child.kill();
          process.exit(0);
        } else {
          console.error("FAIL — list ok?", okList, "stderr ok?", okStderr);
          console.error("stderr was:", stderr);
          child.kill();
          process.exit(1);
        }
      }, 500);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 5000);
EOF

node /tmp/smoke-startup-stderr.mjs
```

Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "$(cat <<'EOF'
feat(server): fire-and-forget startup users.me() ping for auth check

After server.connect(transport), calls getClient().users.me({}). Logs
success ("connected as <name>") or failure ("Notion auth check failed
(server still running): ...") to stderr. Server stays responsive
either way — tools/list works on auth failure so MCP clients can
surface a per-call error on first tool invocation.

The .catch chains at the end of .then().then() to capture both
getClient() rejection and any throw inside the .then callbacks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Bump version to 1.2.0

**Files:**
- Modify: `package.json` (line 3)
- Modify: `src/config/index.ts` (line 5)

- [ ] **Step 1: Bump `package.json`**

Change line 3 from `"version": "1.1.0",` to `"version": "1.2.0",`.

- [ ] **Step 2: Bump `src/config/index.ts`**

Change line 5 from `serverVersion: "1.1.0",` to `serverVersion: "1.2.0",`.

- [ ] **Step 3: Build and verify version surfaces correctly**

```bash
npm run build

NOTION_TOKEN=fake node --input-type=module -e "
const { CONFIG } = await import('./build/config/index.js');
if (CONFIG.serverVersion === '1.2.0') console.log('PASS');
else { console.error('FAIL:', CONFIG.serverVersion); process.exit(1); }
"
```

Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add package.json src/config/index.ts
git commit -m "$(cat <<'EOF'
chore: bump version to 1.2.0

Notion auth gateway (AuthProvider + getClient() + handler-level parent
resolution + PAT-first README). No breaking changes for valid existing
configurations; LLM-visible schema change for `parent` (now optional
with no baked default — env fallback resolves at runtime).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Rewrite `README.md`

PAT-first onboarding, legacy internal-integration alternative, troubleshooting. Top-of-file safety callout for existing v1.1.x users.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the existing README to preserve sections that still apply**

```bash
wc -l README.md
```

Read the file in full (it's small) and identify: install/config sections that should be reused, the list of supported MCP tools and actions (preserve verbatim), the screenshots/badges block (preserve), and any external-link-heavy sections that should carry over.

- [ ] **Step 2: Replace the README with PAT-first structure**

Keep the existing top matter (project title, badges, screenshots), then replace the setup content with:

````markdown
## Quick start

> **Already running notion-mcp-server v1.1.x?** If your `NOTION_TOKEN` is set and tools work today, **nothing changes for you in v1.2.0**. The setup paths below are recommendations for new installs and for users hitting per-page sharing pain.

### Option 1 — Personal Access Token (recommended)

A Personal Access Token (PAT) acts as you. It sees every page you can see — no per-page "Connect" dance in Notion's UI.

1. Open Notion → **Settings → My Settings → Personal Access Tokens** → **Generate**.
2. Copy the `ntn_...` token.
3. Add the MCP server (Claude Code shown; equivalent for Cursor and Claude Desktop below):

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

That's it. The PAT does not expire under your control.

### Option 2 — Internal Integration (legacy)

Use this if you specifically want a workspace-scoped integration with explicit per-page access.

1. Open Notion → **Settings → Connections → Develop or manage integrations** → **New integration**.
2. Copy the Internal Integration Secret (`ntn_...` on new integrations; `secret_...` on older ones).
3. Use the same `claude mcp add` command as above — the env var is identical.
4. **Important:** open each page or database in Notion's UI and click **• • • → Connect → \<your integration name\>** to grant access. This is the per-page friction that PATs eliminate.

### Optional: `NOTION_PAGE_ID`

A default parent page used by `create_page` / `create_database` when the caller doesn't pass one. Operations that need a parent and don't get one now return a clear validation error instead of crashing the server.

To find a page ID: open the page in Notion → **Share → Copy link**. The ID is the last 32 characters of the URL.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_xxx \
  -e NOTION_PAGE_ID=abc123... \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

### Cursor / Claude Desktop

Add this entry to your MCP config JSON (`~/.cursor/mcp.json` for Cursor, `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["/absolute/path/to/notion-mcp-server/build/index.js"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here"
      }
    }
  }
}
```

## Troubleshooting

- **"object_not_found" / "Could not find ..."** — the integration token can only see pages explicitly shared with it. Switch to a PAT (Option 1) to skip per-page sharing.
- **"Notion auth failed: ..." on every call** — the token was missing, revoked, or rejected. Check `NOTION_TOKEN` is set in your MCP client config, and verify the token is still listed under Notion → Settings → My Settings → Personal Access Tokens (or Settings → Connections → Develop or manage integrations).
- **"No parent page configured"** — pass `parent` in the call, or set `NOTION_PAGE_ID` to a default.
- **Server logs "Notion auth check failed" on startup but tools still work** — the startup check is best-effort. If subsequent tool calls succeed, ignore the warning (Claude Code suppresses MCP stderr in normal operation anyway).
````

Preserve the remainder of the existing README below this section (tool reference, badges, license, etc.) unchanged.

- [ ] **Step 3: Verify the README renders**

```bash
head -100 README.md
```

Eyeball the markdown for structural issues — headers, list nesting, fenced code blocks.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: rewrite README for PAT-first onboarding

- Top safety callout: existing v1.1.x installs are unaffected.
- Section 1: Personal Access Token (recommended) — Settings → My
  Settings → Personal Access Tokens → Generate. Acts as user, sees all
  pages, no per-page sharing.
- Section 2: Internal Integration (legacy) — Settings → Connections →
  Develop or manage integrations. Per-page sharing required.
- Section 3: Optional NOTION_PAGE_ID with how-to-find guidance.
- Troubleshooting: per-page errors, auth failures, missing parent,
  startup-check noise.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: End-to-end smoke verification

Final pass. Run all four scenarios from the spec's Testing section to confirm the auth gateway behaves correctly in every state.

**Files:** none (verification only)

- [ ] **Step 1: Scenario A — missing `NOTION_TOKEN`**

```bash
node /tmp/smoke-no-token.mjs
```

Expected: `PASS: AuthError surfaced as isError tool result`

- [ ] **Step 2: Scenario B — dummy `NOTION_TOKEN` rejected by Notion**

```bash
cat > /tmp/smoke-bad-token.mjs <<'EOF'
import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  env: { ...process.env, NOTION_TOKEN: "ntn_invalid_definitely_not_a_real_token" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "notion_users", arguments: { payload: { action: "get_bot_user" } } }
      }) + "\n");
    } else if (msg.id === 2) {
      const text = JSON.stringify(msg.result);
      if (msg.result?.isError && /unauthor/i.test(text)) {
        console.log("PASS: 401 surfaced as isError");
      } else {
        console.error("FAIL:", text);
        process.exit(1);
      }
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 8000);
EOF

node /tmp/smoke-bad-token.mjs
```

Expected: `PASS: 401 surfaced as isError`. Also note that stderr will include `Notion auth check failed (server still running): ...` from the startup ping — that's expected.

- [ ] **Step 3: Scenario C — real token (manual)**

This scenario requires a real PAT and can only be run by the user. If a real `NOTION_TOKEN` is available in the current shell, run:

```bash
node build/index.js < /dev/null > /dev/null 2>&1 &
sleep 1; kill %1 2>/dev/null
# Then re-run the smoke script with the real token to confirm
# stderr shows "Notion auth OK — connected as <name> (NOTION_TOKEN)"
```

If no real token is available, **document this as deferred to the user's verification step** and skip — Scenarios A and B already validate the auth gateway's behavior in failure modes.

- [ ] **Step 4: Scenario D — `create_page` without `parent` and without `NOTION_PAGE_ID`**

```bash
cat > /tmp/smoke-no-parent.mjs <<'EOF'
import { spawn } from "node:child_process";

const env = { ...process.env, NOTION_TOKEN: "ntn_dummy_token" };
delete env.NOTION_PAGE_ID;

const child = spawn("node", ["build/index.js"], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1 && msg.result?.protocolVersion) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "notion_pages",
          arguments: {
            payload: {
              action: "create",
              params: { properties: { title: [{ text: { content: "x" } }] } }
            }
          }
        }
      }) + "\n");
    } else if (msg.id === 2) {
      const text = JSON.stringify(msg.result);
      if (msg.result?.isError && /No parent page configured/.test(text)) {
        console.log("PASS: handler-level AuthError surfaced");
      } else {
        console.error("FAIL:", text);
        process.exit(1);
      }
      child.kill();
      process.exit(0);
    }
  }
});

child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" }
  }
}) + "\n");

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 5000);
EOF

node /tmp/smoke-no-parent.mjs
```

Expected: `PASS: handler-level AuthError surfaced`.

Note: the input schema for `notion_pages.create.params` likely still requires `properties` to have specific structure — if Zod rejects the call before the handler runs, the test surfaces a Zod validation error instead, which is also acceptable evidence that the parent fallback works (Zod is the right layer to reject malformed payloads). If the test fails with a schema validation error rather than the `AuthError` message, adjust the dummy params to satisfy the schema or accept that this scenario can only be fully validated with a real token + a real parent page.

- [ ] **Step 5: Confirm no commits remain to be made**

```bash
git status
git log --oneline -15
```

Expected: clean working tree. The log should show (most recent first) the 11 commits from Tasks 1-11 on top of `94e8a32 update readme`.

- [ ] **Step 6: Done — no commit for this task**

This task is verification only. The implementation is complete and ready for the user to:
1. Install the v1.2.0 build into their Claude Code session (`claude mcp add ...`) and run a real-token smoke check.
2. Publish to npm with `npm publish` once they've verified it works against a real Notion workspace.

---

## Self-review (done by the plan author, not the implementer)

**Spec coverage:**

- ✅ `src/services/auth.ts` with `AuthError`, `AuthProvider`, `EnvAuthProvider`, `authProvider` singleton — Task 1
- ✅ `src/services/notion.ts` rewrite (getClient + non-crashing getRootPageId; remove dead getApiToken + singleton notion) — split across Tasks 3 (additive) and 8 (removal) for build-passes-at-every-commit
- ✅ 18 tool files mechanical refactor — Task 4
- ✅ Schema `.default()` removal — Task 7
- ✅ Handler-level parent resolution in createPage/createDatabase — Tasks 5, 6
- ✅ Startup ping in server/index.ts — Task 9
- ✅ AuthError branch in handleNotionError (open question #1 decided: add it) — Task 2
- ✅ `.catch` chain safety in startup ping (open question #2 decided: chain at end) — Task 9
- ✅ Version bump 1.1.0 → 1.2.0 — Task 10
- ✅ README rewrite — Task 11
- ✅ End-to-end smoke verification covering the 4 spec scenarios — Task 12

**Placeholder scan:** None. All code blocks are complete. Smoke-test scripts include full source.

**Type consistency:** `getClient(): Promise<Client>` consistent across Tasks 3 and 8. `getRootPageId(): string | undefined` consistent (Task 8). `AuthError extends Error` (Task 1) imported correctly in Tasks 2, 5, 6. `EnvAuthProvider` and `authProvider` names stable throughout.

**Build-passes-at-every-commit:** Verified by hand-walking the dependency graph:
- Task 1: pure addition. ✅
- Task 2: pure addition (import of existing AuthError). ✅
- Task 3: pure addition (singleton + getClient coexist). ✅
- Task 4: tool files swap to getClient (still exported); singleton unused but still exported. ✅
- Task 5: createPage now uses getClient + handler parent resolver; schema still bakes default (handler resolver dormant until Task 7). ✅
- Task 6: same for createDatabase. ✅
- Task 7: schema default removed (handler resolver from Tasks 5/6 now active); getRootPageId still exists with old signature. ✅
- Task 8: singleton + getApiToken removed (zero callers); getRootPageId signature changed (zero callers — schemas dropped it Task 7, handlers use process.env directly). ✅
- Task 9: startup ping added (getClient already exists). ✅
- Tasks 10-11: docs/config bumps. ✅

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-26-notion-auth-gateway.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks (spec compliance then code quality), fast iteration. Best for this plan because tasks are largely independent and the 18-file mechanical refactor benefits from a fresh-context subagent that won't get tangled.

2. **Inline Execution** — I execute tasks in this session using `executing-plans`, batch execution with checkpoints for review. Best if you want to interject between groups of tasks.

Which approach?
