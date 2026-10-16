// Отзыв и приостановка аттестатов: W3C Bitstring Status List. Список скачивается целиком — выдающий не видит, кого проверяют.
import { gzipSync, gunzipSync } from "node:zlib";

export const SIZE = 131072; // минимальный размер по спецификации (16 КБ), чтобы список не выдавал отдельные аттестаты
const MAX_DECODED = 16 * 1024 * 1024; // защита от «gzip-бомбы» в чужих списках

export function newBitstring() { return Buffer.alloc(SIZE / 8); }
export const encodeList = (bits) => "u" + gzipSync(bits).toString("base64url");
export function decodeList(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith("u")) throw new Error("ожидается multibase base64url (u…)");
  return gunzipSync(Buffer.from(encoded.slice(1), "base64url"), { maxOutputLength: MAX_DECODED });
}
function checkIndex(bits, i) {
  if (!Number.isInteger(i) || i < 0 || i >= bits.length * 8) throw new Error(`индекс статуса вне списка: ${i}`);
}
export const getBit = (bits, i) => { checkIndex(bits, i); return (bits[i >> 3] >> (7 - (i & 7))) & 1; };
export function setBit(bits, i, v = 1) {
  checkIndex(bits, i);
  if (v) bits[i >> 3] |= 1 << (7 - (i & 7));
  else bits[i >> 3] &= ~(1 << (7 - (i & 7)));
}

// purpose: revocation (окончательный отзыв) или suspension (приостановка, обратимая)
export function statusEntry(listUrl, index, purpose) {
  return { id: `${listUrl}#${index}`, type: "BitstringStatusListEntry", statusPurpose: purpose, statusListIndex: String(index), statusListCredential: listUrl };
}

// Проверка по уже полученному и проверенному аттестату-списку
export function isSet(listCredential, index) {
  const i = /^\d+$/.test(String(index)) ? Number(index) : NaN;
  return getBit(decodeList(listCredential.credentialSubject?.encodedList), i) === 1;
}
