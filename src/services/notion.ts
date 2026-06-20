import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";
import nodeFetch, { RequestInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

const proxyFetch = (url: string, init?: RequestInit) => {
  const proxyURL =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  if (!proxyURL) {
    return nodeFetch(url, init);
  }

  return nodeFetch(url, {
    ...init,
    agent: new HttpsProxyAgent(proxyURL),
  });
};

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({
      auth: token,
      notionVersion: "2025-09-03",
      fetch: proxyFetch,
    });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
