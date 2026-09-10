import assert from "node:assert/strict";
import test from "node:test";

import {
  getKakaoTalkOpenAttempts,
  openKakaoTalkApplication,
} from "../src/connectors/kakao-app.js";

test("KakaoTalk을 macOS 표시 언어와 무관한 bundle id로 먼저 연다", () => {
  assert.deepEqual(getKakaoTalkOpenAttempts("/Users/test")[0], [
    "-g",
    "-b",
    "com.kakao.KakaoTalkMac",
  ]);
});

test("bundle id와 영문 경로가 실패하면 한글 앱 이름으로 연다", async () => {
  const calls: string[][] = [];
  await openKakaoTalkApplication(async (file, args) => {
    calls.push([file, ...args]);
    if (args.at(-1) !== "/Applications/카카오톡.app") throw new Error("not found");
  });

  assert.deepEqual(calls, [
    ["open", "-g", "-b", "com.kakao.KakaoTalkMac"],
    ["open", "-g", "/Applications/KakaoTalk.app"],
    ["open", "-g", "/Applications/카카오톡.app"],
  ]);
});
