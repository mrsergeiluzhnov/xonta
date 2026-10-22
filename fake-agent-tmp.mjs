import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
const app = express(); app.use(express.json());
// по тикеру: верный номер находится обычным ходом для 1/4 компаний, со стратегией locale ещё для 1/4, остальные нет
const h = (s) => [...s].reduce((a, c) => a * 31 + c.charCodeAt(0) >>> 0, 7) % 4;
app.post('/mcp', async (req, res) => {
  const s = new McpServer({ name: 'fake', version: '1' });
  s.registerTool('find_public_company_phone', { inputSchema: { company: z.string(), site: z.string(), strategy: z.record(z.any()).optional(), phase: z.string().optional() } }, async (a) => {
    const k = h(a.company), loc = a.strategy?.action === 'prefer_locale', ok = k === 0 || (loc && k === 1);
    return { content: [{ type: 'text', text: JSON.stringify({ verified: ok, digits: ok ? '4089961010' : null, stage_reached: ok ? 'accepted' : 'candidates', rejection_reason: ok ? null : 'no_phone_candidates', applied: !!a.strategy, matched: loc && k === 1, tokens: 1000, elapsed_ms: 10, all_candidate_digits: [] }) }] };
  });
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); res.on('close', () => t.close());
  await s.connect(t); await t.handleRequest(req, res, req.body);
});
app.listen(Number(process.argv[2]));
