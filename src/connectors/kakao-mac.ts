import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ChatConnector, ChatMessage, ChatSnapshot, Conversation } from "../domain.js";
import { mergeMessageWindows, normalizeMessage, type RawMessage } from "./instagram-dom.js";
import { openKakaoTalkApplication } from "./kakao-app.js";

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = "<<OHF>>";
const CONVERSATION_REFRESH_INTERVAL_MS = 15_000;
const DOUBLE_CLICK_SCRIPT = fileURLToPath(
  new URL("../../scripts/kakao-double-click.swift", import.meta.url),
);
const READ_MESSAGES_SCRIPT = fileURLToPath(
  new URL("../../scripts/kakao-read-messages.swift", import.meta.url),
);
let readerWarmup: Promise<unknown> | undefined;

export class KakaoMacConnector extends EventEmitter implements ChatConnector {
  private refreshTimer?: NodeJS.Timeout;
  private refreshRunning = false;
  private activeConversationId?: string;
  private activeTitle?: string;
  private readonly rowById = new Map<string, number>();
  private readonly history = new Map<string, ChatMessage[]>();
  private loadingOlder = false;
  private conversationsRefreshedAt = 0;
  private conversationLimit = 10;
  private canLoadMoreConversations = true;
  private snapshot: ChatSnapshot = {
    state: "starting",
    conversations: [],
    messages: [],
    detail: "KakaoTalk for macOS를 확인하는 중",
  };

  public getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  public async start(): Promise<void> {
    if (process.platform !== "darwin") {
      this.update({ ...this.snapshot, state: "error", detail: "KakaoTalk connector는 macOS 전용입니다." });
      return;
    }
    warmNativeReader();
    await openKakaoTalkApplication();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await ensureConversationListWindow();
    await this.refresh();
    this.startPolling();
  }

  public async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  public async refresh(): Promise<void> {
    if (this.refreshRunning) return;
    this.refreshRunning = true;
    try {
      const shouldRefreshConversations =
        this.snapshot.conversations.length === 0 ||
        Date.now() - this.conversationsRefreshedAt >= CONVERSATION_REFRESH_INTERVAL_MS;
      const conversations = shouldRefreshConversations
        ? await this.readConversations()
        : this.snapshot.conversations;
      if (shouldRefreshConversations) this.conversationsRefreshedAt = Date.now();
      const visibleMessages = this.activeConversationId
        ? await this.readMessages(this.activeConversationId)
        : [];
      const messages = this.activeConversationId
        ? mergeMessageWindows(
            this.history.get(this.activeConversationId) ?? [],
            visibleMessages,
            this.loadingOlder ? "older" : "newer",
          ).slice(-500)
        : [];
      if (this.activeConversationId) this.history.set(this.activeConversationId, messages);
      this.update({
        state: "connected",
        conversations,
        activeConversationId: this.activeConversationId,
        messages,
        detail: "KakaoTalk macOS · Accessibility UI",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ ...this.snapshot, state: "error", detail: cleanAppleScriptError(message) });
    } finally {
      this.refreshRunning = false;
    }
  }

  public async openConversation(id: string): Promise<void> {
    const pollingWasActive = Boolean(this.refreshTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.waitForRefreshIdle();
    try {
      await ensureConversationListWindow();
      const conversations = this.snapshot.conversations;
      const row = this.rowById.get(id);
      const conversation = conversations.find((item) => item.id === id);
      if (!row || !conversation) throw new Error("KakaoTalk 대화방을 찾을 수 없습니다.");
      await withRestoredFrontmostApplication(async () => {
      const cellBounds = await runAppleScript([
        'tell application "KakaoTalk" to activate',
        'tell application "System Events" to tell process "KakaoTalk"',
        'set frontmost to true',
        'tell window "카카오톡"',
        'set chatAreas to every UI element whose role is "AXScrollArea"',
        'set chatArea to item 1 of chatAreas',
        'set chatTable to UI element 1 of chatArea',
        'set chatScrollBar to UI element 2 of chatArea',
        'set totalRows to (count of UI elements of chatTable) - 1',
        row > 5
          ? `set value of chatScrollBar to ((${row} - 4) / (totalRows - 5))`
          : 'set value of chatScrollBar to 0',
        'delay 0.4',
        `set candidateCell to UI element 1 of UI element ${row} of chatTable`,
        'set candidateLabels to every UI element of candidateCell whose role is "AXStaticText"',
        `if value of item 1 of candidateLabels is not "${escapeAppleScript(conversation.title)}" then error "대화방 순서가 변경되었습니다. 다시 시도해주세요."`,
        'set {cellX, cellY} to position of candidateCell',
        'set {cellWidth, cellHeight} to size of candidateCell',
        `return cellX & "${FIELD_SEPARATOR}" & cellY & "${FIELD_SEPARATOR}" & cellWidth & "${FIELD_SEPARATOR}" & cellHeight`,
        'end tell',
        'end tell',
      ]);
      const [x = 0, y = 0, width = 0, height = 0] =
        cellBounds.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (![x, y, width, height].every(Number.isFinite)) {
        throw new Error(`KakaoTalk 대화 행 좌표를 읽을 수 없습니다: ${cellBounds}`);
      }
      const clickX = x + Math.min(140, width / 2);
      const clickY = y + height / 2;
      await execFileAsync("/usr/bin/swift", [DOUBLE_CLICK_SCRIPT, String(clickX), String(clickY)]);
      await waitForKakaoWindow(conversation.title);
      });
      this.activeConversationId = id;
      this.activeTitle = conversation.title;
      this.update({
        state: "connected",
        conversations,
        activeConversationId: id,
        messages: this.history.get(id) ?? [],
        detail: "KakaoTalk macOS · Accessibility UI",
      });
    } finally {
      if (pollingWasActive) this.startPolling();
    }
  }

  public async sendMessage(text: string): Promise<void> {
    if (!this.activeTitle) throw new Error("KakaoTalk 대화를 먼저 선택하세요.");
    await runAppleScript([
      'tell application "System Events" to tell process "KakaoTalk"',
      `set chatWindow to first window whose name is "${escapeAppleScript(this.activeTitle)}"`,
      'set chatAreas to every UI element of chatWindow whose role is "AXScrollArea"',
      'set inputArea to UI element 1 of item -1 of chatAreas',
      `set value of inputArea to "${escapeAppleScript(text)}"`,
      'set sendButton to first button of chatWindow whose name is "전송"',
      'click sendButton',
      'end tell',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.refresh();
  }

  public async loadOlderMessages(): Promise<number> {
    if (!this.activeConversationId || !this.activeTitle) return 0;
    const before = this.history.get(this.activeConversationId)?.length ?? 0;
    await runAppleScript([
      'tell application "System Events" to tell process "KakaoTalk"',
      `set chatWindow to first window whose name is "${escapeAppleScript(this.activeTitle)}"`,
      'set chatAreas to every UI element of chatWindow whose role is "AXScrollArea"',
      'set messageArea to item 1 of chatAreas',
      'set messageBar to UI element 2 of messageArea',
      'set value of messageBar to ((value of messageBar) - 0.25)',
      'end tell',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.loadingOlder = true;
    try {
      await this.refresh();
    } finally {
      this.loadingOlder = false;
    }
    return Math.max(0, (this.history.get(this.activeConversationId)?.length ?? 0) - before);
  }

  public async loadMoreConversations(): Promise<number> {
    if (!this.canLoadMoreConversations) return 0;
    await this.waitForRefreshIdle();
    const before = this.snapshot.conversations.length;
    this.conversationLimit += 10;
    this.conversationsRefreshedAt = 0;
    await this.refresh();
    return Math.max(0, this.snapshot.conversations.length - before);
  }

  private async readConversations(): Promise<Conversation[]> {
    const countOutput = await runAppleScript([
      'tell application "System Events" to tell process "KakaoTalk" to tell window "카카오톡"',
      'set chatAreas to every UI element whose role is "AXScrollArea"',
      'set chatArea to item 1 of chatAreas',
      'set chatTable to UI element 1 of chatArea',
      'set value of UI element 2 of chatArea to 0',
      'delay 0.4',
      'return (count of UI elements of chatTable) - 1',
      'end tell',
    ]);
    const totalRows = Number(countOutput) || 0;
    const rowCount = Math.min(this.conversationLimit, totalRows);
    this.canLoadMoreConversations = rowCount >= this.conversationLimit;
    const rows: string[][] = [];
    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      const output = await runAppleScript([
        'tell application "System Events" to tell process "KakaoTalk" to tell window "카카오톡"',
        'set chatAreas to every UI element whose role is "AXScrollArea"',
        'set chatTable to UI element 1 of item 1 of chatAreas',
        `set chatCell to UI element 1 of UI element ${rowIndex} of chatTable`,
        'set labels to every UI element of chatCell whose role is "AXStaticText"',
        'set roomTitle to value of item 1 of labels',
        'set labelCount to count of labels',
        'set roomTime to value of item labelCount of labels',
        'set previewScrolls to every UI element of chatCell whose role is "AXScrollArea"',
        'set roomPreview to ""',
        'if (count of previewScrolls) > 0 then set roomPreview to value of UI element 1 of item 1 of previewScrolls',
        'set unreadFlag to "0"',
        'if (count of labels) is greater than or equal to 3 then set unreadFlag to "1"',
        `return "${rowIndex}${FIELD_SEPARATOR}" & roomTitle & "${FIELD_SEPARATOR}" & roomPreview & "${FIELD_SEPARATOR}" & roomTime & "${FIELD_SEPARATOR}" & unreadFlag`,
        'end tell',
      ]).catch(() => "");
      if (output) rows.push(output.split(FIELD_SEPARATOR));
    }
    this.rowById.clear();
    return rows.map((fields) => {
      const [row = "0", title = "KakaoTalk", preview = "", time = "", unread = "0"] = fields;
      const id = `room-${stableHash(title)}`;
      this.rowById.set(id, Number(row));
      return { id, href: `kakaotalk:${row}`, title, preview: `${preview} · ${time}`, unread: unread === "1" };
    });
  }

  private async readMessages(threadId: string): Promise<ChatMessage[]> {
    if (!this.activeTitle) return [];
    if (readerWarmup) await readerWarmup;
    const { stdout } = await execFileAsync("/usr/bin/swift", [
      READ_MESSAGES_SCRIPT,
      this.activeTitle,
      this.loadingOlder ? "older" : "newer",
    ], { maxBuffer: 4 * 1024 * 1024 });
    const rawMessages = JSON.parse(stdout || "[]") as RawMessage[];
    return rawMessages
      .map((raw, index) => normalizeMessage(threadId, raw, index))
      .filter((item): item is ChatMessage => item !== undefined);
  }

  private update(snapshot: ChatSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }

  private startPolling(): void {
    if (!this.refreshTimer) this.refreshTimer = setInterval(() => void this.refresh(), 5_000);
  }

  private async waitForRefreshIdle(): Promise<void> {
    while (this.refreshRunning) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  const { stdout } = await execFileAsync("osascript", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function withRestoredFrontmostApplication(action: () => Promise<void>): Promise<void> {
  const previousApplication = await runAppleScript([
    'tell application "System Events" to return name of first application process whose frontmost is true',
  ]).catch(() => "");
  try {
    await action();
  } finally {
    if (previousApplication && previousApplication !== "KakaoTalk") {
      await runAppleScript([
        'tell application "System Events"',
        `if exists application process "${escapeAppleScript(previousApplication)}" then set frontmost of application process "${escapeAppleScript(previousApplication)}" to true`,
        'end tell',
      ]).catch(() => undefined);
    }
  }
}

async function ensureConversationListWindow(): Promise<void> {
  const isOpen = await runAppleScript([
    'tell application "System Events" to tell process "KakaoTalk" to return exists window "카카오톡"',
  ]).catch(() => "false");
  if (isOpen === "true") return;

  await withRestoredFrontmostApplication(async () => {
    await runAppleScript([
      'tell application "KakaoTalk" to activate',
      'tell application "System Events" to tell process "KakaoTalk"',
      'set frontmost to true',
      'click menu item "채팅" of menu 1 of menu bar item "창" of menu bar 1',
      'delay 0.5',
      'end tell',
    ]);
  });
}

async function waitForKakaoWindow(title: string): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const exists = await runAppleScript([
      'tell application "System Events" to tell process "KakaoTalk"',
      `return exists window "${escapeAppleScript(title)}"`,
      'end tell',
    ]).catch(() => "false");
    if (exists === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`KakaoTalk 대화창을 열지 못했습니다: ${title}`);
}

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function warmNativeReader(): void {
  readerWarmup ??= execFileAsync("/usr/bin/swift", [READ_MESSAGES_SCRIPT, "", "newer"], {
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

function cleanAppleScriptError(value: string): string {
  return value.replace(/^.*execution error:\s*/s, "").replace(/\s*\(-?\d+\)\s*$/, "").trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
