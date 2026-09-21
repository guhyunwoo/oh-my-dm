import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRequest,
  capText,
  isSensitivePath,
  sanitizeText,
} from "../tools/jev-harness.js";

const config = {
  version: 1,
  project: "oh-my-dm",
  model: "jev-latest",
  mode: "advisory" as const,
  maxFiles: 100,
  maxDiffChars: 1000,
  excludedPrefixes: [".omc/", ".oh-my-chat/", "dist/", "node_modules/"],
  checks: [],
  constraints: [],
};

test("excludes private data and generated paths from Jev state", () => {
  assert.equal(isSensitivePath(".omc/sessions/private.json", config), true);
  assert.equal(isSensitivePath(".env.local", config), true);
  assert.equal(isSensitivePath("node_modules/pkg/index.js", config), true);
  assert.equal(isSensitivePath("src/ui/app.tsx", config), false);
});

test("redacts common credential values before sending state to Jev", () => {
  const input = [
    "Authorization: Bearer secret-token",
    "TYPESAFE_API_KEY=apikey_123456",
    "password: hunter2",
  ].join("\n");
  const result = sanitizeText(input);
  assert.doesNotMatch(result, /secret-token|123456|hunter2/);
  assert.match(result, /\[REDACTED\]/);
});

test("truncates long diffs explicitly", () => {
  assert.deepEqual(capText("abcdef", 3), {
    text: "abc\n[TRUNCATED]",
    truncated: true,
  });
  assert.deepEqual(capText("abc", 3), { text: "abc", truncated: false });
});

test("preserves model, state, and questions in a TypeSafe raw request", () => {
  const request = buildRequest(
    "jev-latest",
    { task: "fix login" },
    { relevant: { type: "noul", instructions: "Is this relevant?" } },
  );
  assert.equal(request.model, "jev-latest");
  assert.deepEqual(request.state, { task: "fix login" });
  assert.ok("relevant" in request.questions);
});
