import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KAKAO_TALK_BUNDLE_ID = "com.kakao.KakaoTalkMac";

type OpenApplication = (file: string, args: string[]) => Promise<unknown>;

export function getKakaoTalkOpenAttempts(homeDirectory = os.homedir()): string[][] {
  return [
    ["-g", "-b", KAKAO_TALK_BUNDLE_ID],
    ["-g", "/Applications/KakaoTalk.app"],
    ["-g", "/Applications/카카오톡.app"],
    ["-g", path.join(homeDirectory, "Applications", "KakaoTalk.app")],
    ["-g", path.join(homeDirectory, "Applications", "카카오톡.app")],
  ];
}

export async function openKakaoTalkApplication(
  run: OpenApplication = (file, args) => execFileAsync(file, args),
): Promise<void> {
  let lastError: unknown;
  for (const args of getKakaoTalkOpenAttempts()) {
    try {
      await run("open", args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "KakaoTalk 앱을 찾을 수 없습니다. /Applications의 KakaoTalk.app 또는 카카오톡.app 설치를 확인하세요.",
    { cause: lastError },
  );
}
