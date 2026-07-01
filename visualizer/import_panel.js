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


export async function importArchitectureText(text, options = {}) {
  const payload = parseImportText(text);
  return fetchJson("api/architecture/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    fetchImpl: options.fetchImpl,
  });
}


export async function validateCircuitText(qasm, options = {}) {
  return fetchJson("api/circuit/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qasm, source_label: options.sourceLabel || "Imported circuit" }),
    fetchImpl: options.fetchImpl,
  });
}


export async function generateCircuitTrace(qasm, options = {}) {
  return fetchJson("api/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      qasm,
      source_label: options.sourceLabel || "Imported circuit",
      machine: options.machine,
      capacity: options.capacity,
      mapper: options.mapper,
      ordering: options.ordering,
      scheduler: options.scheduler,
    }),
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
}
