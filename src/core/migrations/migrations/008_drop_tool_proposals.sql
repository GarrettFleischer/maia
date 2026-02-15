-- Remove tool_proposals table: extensible tools are now MCP-only (propose_mcp_server).
-- Tool creation (propose_tool, tool_review, write-approved-tool) has been removed.

DROP TABLE IF EXISTS tool_proposals;
