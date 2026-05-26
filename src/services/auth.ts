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
