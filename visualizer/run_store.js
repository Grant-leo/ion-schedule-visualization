export function createRunStore() {
  const runs = new Map();
  let primaryKey = null;
  let comparisonKeys = [];
  let baselineKey = null;
  let candidateKey = null;

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
    allRuns() {
      return [...runs.values()];
    },
    selectPrimary(key) {
      requireRun(key);
      primaryKey = key;
      return runs.get(key);
    },
    selectComparison(keys) {
      for (const key of keys) requireRun(key);
      if (new Set(keys).size !== keys.length) {
        throw new Error("Comparison requires distinct runs.");
      }
      comparisonKeys = [...keys];
      baselineKey = comparisonKeys[0] || null;
      candidateKey = comparisonKeys[1] || null;
      return comparisonKeys.map((key) => runs.get(key));
    },
    selectComparisonPair(nextBaselineKey, nextCandidateKey) {
      requireRun(nextBaselineKey);
      requireRun(nextCandidateKey);
      if (nextBaselineKey === nextCandidateKey) {
        throw new Error("Comparison requires distinct runs.");
      }
      baselineKey = nextBaselineKey;
      candidateKey = nextCandidateKey;
      comparisonKeys = [baselineKey, candidateKey];
      return this.comparisonPair();
    },
    comparisonPair() {
      if (!baselineKey || !candidateKey) return null;
      if (!runs.has(baselineKey) || !runs.has(candidateKey)) return null;
      return {
        baseline: runs.get(baselineKey),
        candidate: runs.get(candidateKey),
      };
    },
    selectedRuns() {
      const keys = comparisonKeys.length > 0 ? comparisonKeys : primaryKey ? [primaryKey] : [];
      return keys.map((key) => runs.get(key)).filter(Boolean);
    },
    clear() {
      runs.clear();
      primaryKey = null;
      comparisonKeys = [];
      baselineKey = null;
      candidateKey = null;
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
