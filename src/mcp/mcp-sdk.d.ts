/**
 * @fileoverview Type declarations for MCP SDK client stdio transport.
 * @module mcp/mcp-sdk
 *
 * @note Package exports subpath that TS moduleResolution bundler may not resolve.
 * Declare the module so we can import StdioClientTransport.
 */
declare module "@modelcontextprotocol/sdk/client/stdio" {
  export type StdioServerParameters = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: "pipe" | "inherit" | "overlapped";
    cwd?: string;
  };
  export class StdioClientTransport {
    constructor(server: StdioServerParameters);
    start(): Promise<void>;
  }
}
