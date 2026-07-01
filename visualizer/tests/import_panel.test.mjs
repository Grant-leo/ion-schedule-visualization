import test from "node:test";
import assert from "node:assert/strict";

import { importArchitectureText, importTraceText, parseImportText } from "../import_panel.js";


test("parseImportText parses local JSON text", () => {
  assert.deepEqual(parseImportText('{"schema_version":"ion_trap_trace_v1"}'), {
    schema_version: "ion_trap_trace_v1",
  });
});


test("parseImportText reports malformed JSON as a user-safe error", () => {
  assert.throws(() => parseImportText("{bad"), /Import file must be valid JSON/);
});


test("importTraceText posts the parsed payload to the import endpoint", async () => {
  const calls = [];
  const trace = { trace_hash: "abc", validation: { valid: true } };
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(trace);
      },
    };
  };

  const result = await importTraceText('{"schema_version":"ion_trap_trace_v1"}', { fetchImpl });

  assert.deepEqual(result, trace);
  assert.equal(calls[0].path, "api/import/trace");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), { schema_version: "ion_trap_trace_v1" });
});


test("importArchitectureText posts the parsed payload to the architecture validator", async () => {
  const calls = [];
  const architecture = { valid: true, id: "custom_linear_3", topology: { traps: [] } };
  const fetchImpl = async (path, options) => {
    calls.push({ path, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(architecture);
      },
    };
  };

  const result = await importArchitectureText('{"schema_version":"qccd_architecture_v1"}', { fetchImpl });

  assert.deepEqual(result, architecture);
  assert.equal(calls[0].path, "api/architecture/validate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), { schema_version: "qccd_architecture_v1" });
});
