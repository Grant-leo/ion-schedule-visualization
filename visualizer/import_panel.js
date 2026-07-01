import { fetchJson } from "./api_client.js?v=20260701-foundation1";


export function parseImportText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Import file must be valid JSON.");
  }
}


export async function importTraceText(text, options = {}) {
  const payload = parseImportText(text);
  return fetchJson("api/import/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    fetchImpl: options.fetchImpl,
  });
}
