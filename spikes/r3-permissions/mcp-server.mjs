// Option B: stdio MCP server exposing `approve`. Logs input to MCP_LOG; decision from env MCP_DECISION (allow|deny).
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'spike', version: '0.0.1' });
server.tool('approve', 'Permission prompt tool', { tool_name: z.string(), input: z.record(z.any()), tool_use_id: z.string().optional() }, async (args, extra) => {
  fs.appendFileSync(process.env.MCP_LOG, `[${new Date().toISOString()}] APPROVE INPUT ${JSON.stringify(args)}\n`);
  const decision = process.env.MCP_DECISION === 'deny'
    ? { behavior: 'deny', message: 'Denied by MCP spike' }
    : { behavior: 'allow', updatedInput: args.input };
  fs.appendFileSync(process.env.MCP_LOG, `[${new Date().toISOString()}] APPROVE RESPOND ${JSON.stringify(decision)}\n`);
  return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
});
await server.connect(new StdioServerTransport());
