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
