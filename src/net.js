// Безопасные исходящие запросы: только публичные адреса, https, без перенаправлений, с ограничением размера ответа.
// Используется везде, где адрес приходит извне: DID-документы, списки статусов, MCP-серверы, вебхуки, коды подтверждения.
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";

const block4 = new BlockList(), block6 = new BlockList(); // раздельно: правила IPv6 вида ::/96 иначе задевают все IPv4
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) block4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) block6.addSubnet(net, bits, "ipv6");

export function isPrivateIp(ip) {
  const v = isIP(ip);
  if (!v) return true;
  return v === 6 ? block6.check(ip, "ipv6") : block4.check(ip, "ipv4");
}

const err = (status, message) => Object.assign(new Error(message), { status });

export async function assertPublicUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw err(400, "некорректный адрес"); }
  if (!["https:", "http:"].includes(u.protocol)) throw err(400, "поддерживаются только http(s)-адреса");
  if (allowPrivate) return u;
  if (u.protocol !== "https:") throw err(400, "нужен https-адрес");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); } catch { throw err(422, "адрес не найден в DNS"); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw err(422, "адрес ведёт во внутреннюю сеть — обращение запрещено");
  return u;
}

// Ответ читается не больше maxBytes; ошибки разбора не пересказывают содержимое ответа.
export async function safeFetch(url, { allowPrivate = false, maxBytes = 256 * 1024, timeoutMs = 8000, method = "GET", headers, body } = {}) {
  await assertPublicUrl(url, { allowPrivate });
  let r;
  try { r = await fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw err(502, "адрес недоступен"); }
  const reader = r.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { reader.cancel().catch(() => {}); throw err(502, "ответ слишком большой"); }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return {
    ok: r.ok,
    status: r.status,
    text: () => buf.toString("utf8"),
    json: () => { try { return JSON.parse(buf.toString("utf8")); } catch { throw err(502, "ответ не является корректным JSON"); } },
  };
}
