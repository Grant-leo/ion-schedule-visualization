import test from "node:test";
import assert from "node:assert/strict";

import { fetchJson, formatErrorMessage, isAbortError } from "../api_client.js";
import { createRunStore, runKey } from "../run_store.js";

function trace(overrides = {}) {
  return {
    schema_version: "1.0",
    device_type: "ion_trap",
    trace_hash: overrides.trace_hash,
    run: overrides.run || { id: overrides.runId, program: "qft_n4.qasm", machine: "G3x3" },
    metrics: overrides.metrics || { finish_time: 10, event_count: 0 },
    particles: overrides.particles || [],
    events: overrides.events || [],
    topology: overrides.topology || { traps: [], segments: [], junctions: [] },
    dag: overrides.dag || { nodes: [], edges: [] },
  };
}

test("runKey prefers trace_hash and then run id", () => {
  assert.equal(runKey(trace({ trace_hash: "abc123", runId: "run-a" })), "trace:abc123");
  assert.equal(runKey(trace({ runId: "run-a" })), "run:run-a");
});

test("runKey creates a deterministic fallback for traces without identity", () => {
  const first = trace({ run: { program: "adder.qasm", machine: "L6" } });
  const second = trace({ run: { machine: "L6", program: "adder.qasm" } });

  assert.equal(runKey(first), runKey(second));
  assert.match(runKey(first), /^fallback:[a-z0-9]+$/);
});

test("createRunStore stores and selects multiple validated traces", () => {
  const store = createRunStore();
  const baseline = trace({ trace_hash: "base", run: { id: "baseline", machine: "G3x3" } });
  const candidate = trace({ trace_hash: "candidate", run: { id: "candidate", machine: "G3x3" } });

  const baselineKey = store.addRun(baseline);
  const candidateKey = store.addRun(candidate);
  store.selectPrimary(baselineKey);
  store.selectComparison([baselineKey, candidateKey]);

  assert.equal(baselineKey, "trace:base");
  assert.equal(candidateKey, "trace:candidate");
  assert.equal(store.getRun(baselineKey).trace, baseline);
  assert.deepEqual(
    store.selectedRuns().map((item) => item.key),
    [baselineKey, candidateKey],
  );
});

test("createRunStore rejects unknown selected run keys", () => {
  const store = createRunStore();

  assert.throws(() => store.selectPrimary("missing"), /Unknown run key: missing/);
  assert.throws(() => store.selectComparison(["missing"]), /Unknown run key: missing/);
});

test("fetchJson parses success payloads and sends request options", async () => {
  const calls = [];
  const payload = await fetchJson("/api/options", {
    method: "POST",
    body: "{}",
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return {
        ok: true,
        status: 200,
        text: async () => "{\"ok\":true}",
      };
    },
  });

  assert.deepEqual(payload, { ok: true });
  assert.equal(calls[0].path, "/api/options");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
});

test("fetchJson throws user-safe errors for JSON error payloads", async () => {
  await assert.rejects(
    () =>
      fetchJson("/api/import/trace", {
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          text: async () => "{\"error\":\"Invalid trace\",\"details\":[\"missing run.id\"]}",
        }),
      }),
    (error) => {
      assert.equal(error.message, "Invalid trace");
      assert.equal(error.status, 400);
      assert.deepEqual(error.details, ["missing run.id"]);
      return true;
    },
  );
});

test("formatErrorMessage removes Error prefixes and stack lines", () => {
  assert.equal(formatErrorMessage(new Error("Bad trace\nstack line")), "Bad trace");
  assert.equal(formatErrorMessage("Error: Plain failure"), "Plain failure");
});

test("isAbortError detects browser abort errors", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("AbortError")), false);
});
