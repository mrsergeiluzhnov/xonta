// Собственный MCP-сервер оркестратора: verify_agent, get_passport, scan_mcp_server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export function mountMcp(app, { version, verifier, orch, scanPublic, limit }) {
  const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 1) }] });
  const fail = (e) => ({ content: [{ type: "text", text: `Ошибка: ${e.message}` }], isError: true });
  function build(req) {
    const s = new McpServer({ name: "xonta-agent-passport", version }, { instructions: "Паспорт ИИ-агента: проверка агента по аттестатам (verify_agent), паспорт зарегистрированного агента, проверка любого MCP-сервера на скрытые инструкции." });
    s.registerTool("verify_agent", {
      title: "Проверить агента по паспорту",
      description: "Собирает аттестаты агента, проверяет подписи, сроки и отзыв, применяет политику и возвращает уровень доверия 0–3 с объяснением. Паспорт подтверждает проверки на их дату, а не безопасность агента.",
      inputSchema: { agent: z.string().describe("DID агента, его id у оркестратора или адрес MCP-сервера"), policy: z.object({}).passthrough().optional().describe("Политика проверяющего: trusted_issuers, require, reputation") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ agent, policy }) => { try { limit(req, 300); return text(await verifier.verifyAgent({ agent, policy })); } catch (e) { return fail(e); } });
    s.registerTool("get_passport", {
      title: "Паспорт агента",
      description: "Карточка зарегистрированного агента и все его аттестаты (W3C VC) со статусами и доказательствами фиксации даты.",
      inputSchema: { id: z.string().describe("id агента у оркестратора (ag_…)") },
      annotations: { readOnlyHint: true },
    }, async ({ id }) => { try { return text(orch.passport(id)); } catch (e) { return fail(e); } });
    s.registerTool("scan_mcp_server", {
      title: "Проверить MCP-сервер на скрытые инструкции",
      description: "Подключается к MCP-серверу, получает список инструментов и ищет признаки скрытых инструкций (tool poisoning): невидимые символы, команды игнорировать инструкции, обращение к ключам, отправку данных наружу. Возвращает отпечаток списка инструментов. Эвристика: «признаков не найдено» не означает «безопасно».",
      inputSchema: { url: z.string().describe("Адрес MCP-сервера (Streamable HTTP), https") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ url }) => { try { limit(req); return text(await scanPublic(url)); } catch (e) { return fail(e); } });
    return s;
  }
  app.post("/mcp", async (req, res) => {
    const server = build(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }); }
  });
  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
