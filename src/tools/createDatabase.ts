import { getClient } from "../services/notion.js";
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
      throw new Error(
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
