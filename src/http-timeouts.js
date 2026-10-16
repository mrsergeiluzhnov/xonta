// Встроенный fetch Node (undici) обрывает ответ через 5 минут ожидания заголовков. Долгие вызовы стенда — оценка узла на 200 отзывах,
// слияние, поставка — могут идти дольше: обрыв на стороне вызывающего, пока оркестратор продолжает работу, оставлял советы
// без решения и слияния без применения. Здесь лимит поднимается до 20 минут (больше MCP_TOOL_TIMEOUT_MS = 10 мин).
import { Agent, setGlobalDispatcher } from "undici";
const ms = Number(process.env.HTTP_TIMEOUT_MS || 1_200_000);
setGlobalDispatcher(new Agent({ headersTimeout: ms, bodyTimeout: ms, connectTimeout: 30_000 }));
