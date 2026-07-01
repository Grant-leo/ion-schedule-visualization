export function createRunStore() {
  const runs = new Map();
  let primaryKey = null;
  let comparisonKeys = [];

  function requireRun(key) {
    if (!runs.has(key)) {
      throw new Error(`Unknown run key: ${key}`);
    }
  }

  return {
    addRun(trace, metadata = {}) {
      const key = runKey(trace);
      runs.set(key, { key, trace, metadata });
      if (!primaryKey) primaryKey = key;
      return key;
    },
    getRun(key) {
      requireRun(key);
      return runs.get(key);
    },
    selectPrimary(key) {
      requireRun(key);
      primaryKey = key;
      return runs.get(key);
    },
    selectComparison(keys) {
      for (const key of keys) requireRun(key);
      comparisonKeys = [...keys];
      return comparisonKeys.map((key) => runs.get(key));
    },
    selectedRuns() {
      const keys = comparisonKeys.length > 0 ? comparisonKeys : primaryKey ? [primaryKey] : [];
      return keys.map((key) => runs.get(key)).filter(Boolean);
    },
    clear() {
      runs.clear();
      primaryKey = null;
      comparisonKeys = [];
    },
  };
}

export function runKey(trace = {}) {
  if (trace.trace_hash) return `trace:${trace.trace_hash}`;
  if (trace.run?.id) return `run:${trace.run.id}`;
  return `fallback:${hashString(stableStringify(trace))}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
