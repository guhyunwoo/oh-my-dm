import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getAppPaths } from "../src/config.js";

test("Telegram uses a separate profile while preserving the existing Instagram path", () => {
  const paths = getAppPaths({ OH_MY_DM_DATA: "/tmp/synthetic-oh-my-dm" });
  assert.equal(paths.browserProfileDir, path.join(paths.dataDir, "browser", "instagram"));
  assert.equal(paths.telegramProfileDir, path.join(paths.dataDir, "browser", "telegram"));
  assert.notEqual(paths.browserProfileDir, paths.telegramProfileDir);
});
