import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { server } from "../server/index.js";
import { initOperations, getOperation, listOperations, operationNames } from "../operations/index.js";
import { dispatch } from "../dispatch/index.js";
import { emitJsonSchema } from "../schema/emit.js";

function jsonContent(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function errorContent(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { isError: true, content: [{ type: "text", text }] };
}

const EXECUTE_INPUT = {
  operation: z
    .string()
    .describe(
      "Operation name. See notion_describe for the schema of any operation, or read the notion://operations resource for the full menu. Common ops: set_page_title, append_blocks, get_page, search_pages, query_database."
    ),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "Operation parameters. Pass either single-op fields directly, or { items: [...], atomic?, idempotency_key?, concurrency? } for batch."
    ),
};

const DESCRIBE_INPUT = {
  operation: z.string().describe("Operation name to describe."),
};

const EXECUTE_DESCRIPTION = `Execute a Notion operation by name.

Two ways to call:
  • Single: { operation: "set_page_title", payload: { page_id, title } }
  • Batch:  { operation: "set_page_title", payload: { items: [{page_id, title}, ...], atomic?: false, idempotency_key?: "...", concurrency?: 3 } }

If the payload is malformed, the error response includes the full schema + a working example so you can correct and retry in one round-trip. Call notion_describe(operation) ahead of time only for complex shapes (query_database filters, batch_mixed_blocks).

Most responses are slimmed by default. Pass verbose:true inside payload (single) or per-item (batch) to get the raw Notion SDK response.`;

const DESCRIBE_DESCRIPTION = `Return the JSON Schema and a working example for one operation. Use this BEFORE notion_execute when the payload shape is non-trivial (query filters, structured block trees, database property definitions). For simple ops, just call notion_execute — its errors carry the schema.`;

export async function registerAllTools(): Promise<void> {
  await initOperations();

  server.registerTool(
    "notion_execute",
    {
      title: "Notion Execute",
      description: EXECUTE_DESCRIPTION,
      inputSchema: EXECUTE_INPUT,
      annotations: {
        title: "Notion Execute",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ operation, payload }): Promise<CallToolResult> => {
      const result = await dispatch(operation, payload);
      // Batch results (with per-item results) always go back as structured data —
      // a partial success is a normal outcome of the tool, not a tool error.
      const isBatch = typeof result === "object" && result !== null && "summary" in result;
      if (isBatch || result.ok) return jsonContent(result);
      return errorContent(result);
    }
  );

  server.registerTool(
    "notion_describe",
    {
      title: "Notion Describe",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: DESCRIBE_INPUT,
      annotations: {
        title: "Notion Describe",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ operation }): Promise<CallToolResult> => {
      const def = getOperation(operation);
      if (!def) {
        return errorContent({
          ok: false,
          error: {
            code: "unknown_operation",
            message: `Unknown operation: "${operation}".`,
            fix: `Available: ${operationNames().join(", ")}`,
          },
        });
      }
      return jsonContent({
        name: def.name,
        description: def.description,
        batchable: def.batchable,
        schema: emitJsonSchema(def.schema),
        example: def.example,
        ...(def.exampleBatch ? { example_batch: def.exampleBatch } : {}),
      });
    }
  );

  // Cheat-sheet resource: a markdown table of every operation
  server.registerResource(
    "operations-index",
    "notion://operations",
    {
      title: "Notion operations index",
      description: "Markdown table of every supported operation, batchability, and one-line description.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "notion://operations",
          mimeType: "text/markdown",
          text: renderOperationsIndex(),
        },
      ],
    })
  );
}

function renderOperationsIndex(): string {
  const lines = [
    "# Notion MCP — Operations",
    "",
    "Call `notion_execute({operation, payload})` with one of these. Use `notion_describe({operation})` for the full schema.",
    "",
    "| Operation | Batchable | Description |",
    "| --- | --- | --- |",
  ];
  for (const def of listOperations()) {
    lines.push(`| \`${def.name}\` | ${def.batchable ? "yes" : "no"} | ${def.description} |`);
  }
  return lines.join("\n");
}
