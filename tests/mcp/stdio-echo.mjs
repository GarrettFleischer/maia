/**
 * One-off stdio MCP mock: reads one JSON-RPC line, responds with tools/list result, then exits.
 */
import { createInterface } from "readline";
const rl = createInterface(process.stdin);
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [{ name: "stdio_tool", description: "From stdio", inputSchema: {} }],
        },
      }) + "\n"
    );
  }
  rl.close();
});
