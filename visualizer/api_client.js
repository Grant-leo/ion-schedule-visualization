export async function fetchJson(path, options = {}) {
  const { fetchImpl = globalThis.fetch, ...requestOptions } = options;
  const response = await fetchImpl(path, requestOptions);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    if (response.ok) throw error;
    payload = { error: text };
  }
  if (!response.ok) {
    const message = payload?.error || `Failed to load ${path}: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = Array.isArray(payload?.details) ? payload.details : [];
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

export function formatErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/^Error:\s*/, "").split("\n")[0];
}
