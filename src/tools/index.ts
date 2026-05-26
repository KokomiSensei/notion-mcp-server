import { server } from "../server/index.js";
import { PAGES_OPERATION_SCHEMA } from "../schema/page.js";
import { BLOCKS_OPERATION_SCHEMA } from "../schema/blocks.js";
import { DATABASE_OPERATION_SCHEMA } from "../schema/database.js";
import { COMMENTS_OPERATION_SCHEMA } from "../schema/comments.js";
import { USERS_OPERATION_SCHEMA } from "../schema/users.js";
import type { ZodRawShape } from "zod";
import { registerPagesOperationTool } from "./pages.js";
import { registerBlocksOperationTool } from "./blocks.js";
import { registerDatabaseOperationTool } from "./database.js";
import { registerCommentsOperationTool } from "./comments.js";
import { registerUsersOperationTool } from "./users.js";
import type { PagesOperationParams } from "../types/page.js";
import type { BlocksOperationParams } from "../types/blocks.js";
import type { DatabaseOperationParams } from "../types/database.js";
import type { CommentsOperationParams } from "../types/comments.js";
import type { UsersOperationParams } from "../types/users.js";

// Cast the server's registerTool to a simpler signature to avoid TS2589
// (type instantiation depth exceeded) on the deeply-nested ZodEffects schemas.
// This is safe: the handlers declare their own param types, and the SDK's
// inferred-input type is never consumed by our callbacks.
const registerTool = server.registerTool.bind(server) as (
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShape;
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    };
  },
  cb: (args: ZodRawShape) => unknown
) => void;

export const registerAllTools = () => {
  registerTool(
    "notion_pages",
    {
      title: "Notion Pages",
      description:
        "Perform various page operations (create, archive, restore, search, update)",
      inputSchema: PAGES_OPERATION_SCHEMA as ZodRawShape,
      annotations: {
        title: "Notion Pages",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    (args) => registerPagesOperationTool(args as unknown as PagesOperationParams)
  );

  registerTool(
    "notion_blocks",
    {
      title: "Notion Blocks",
      description:
        "Perform various block operations (retrieve, update, delete, append children, batch operations)",
      inputSchema: BLOCKS_OPERATION_SCHEMA as ZodRawShape,
      annotations: {
        title: "Notion Blocks",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    (args) => registerBlocksOperationTool(args as unknown as BlocksOperationParams)
  );

  registerTool(
    "notion_database",
    {
      title: "Notion Database",
      description:
        "Perform various database operations (create, query, update)",
      inputSchema: DATABASE_OPERATION_SCHEMA as ZodRawShape,
      annotations: {
        title: "Notion Database",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args) => registerDatabaseOperationTool(args as unknown as DatabaseOperationParams)
  );

  registerTool(
    "notion_comments",
    {
      title: "Notion Comments",
      description:
        "Perform various comment operations (get, add to page, add to discussion)",
      inputSchema: COMMENTS_OPERATION_SCHEMA as ZodRawShape,
      annotations: {
        title: "Notion Comments",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args) => registerCommentsOperationTool(args as unknown as CommentsOperationParams)
  );

  registerTool(
    "notion_users",
    {
      title: "Notion Users",
      description: "Perform various user operations (list, get, get bot)",
      inputSchema: USERS_OPERATION_SCHEMA as ZodRawShape,
      annotations: {
        title: "Notion Users",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args) => registerUsersOperationTool(args as unknown as UsersOperationParams)
  );
};
