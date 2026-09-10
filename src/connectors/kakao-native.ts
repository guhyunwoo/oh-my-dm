import { EventEmitter } from "node:events";

import type { ChatConnector, ChatMessage, ChatSnapshot, Conversation } from "../domain.js";
import { mergeMessageWindows, normalizeMessage, type RawMessage } from "./instagram-dom.js";
import { openKakaoTalkApplication } from "./kakao-app.js";
import { KakaoNativeBridge } from "./kakao-native-bridge.js";

const CONVERSATION_REFRESH_INTERVAL_MS = 10_000;

interface NativeConversation {
  row: number;
  title: string;
  preview: string;
  time: string;
  unread: boolean;
}

interface NativePoint {
  x: number;
  y: number;
  alreadyOpen?: number;
}

interface NativeSendResult {
  confirmed: boolean;
}

export class KakaoNativeConnector extends EventEmitter implements ChatConnector {
  private readonly readBridge = new KakaoNativeBridge();
  private readonly actionBridge = new KakaoNativeBridge();
  private readonly rowById = new Map<string, number>();
  private readonly history = new Map<string, ChatMessage[]>();
  private refreshTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<void>;
  private conversationsRefreshedAt = 0;
  private conversationLimit = 10;
  private canLoadMoreConversations = true;
  private activeConversationId?: string;
  private activeTitle?: string;
  private loadingOlder = false;
  private sending = false;
  private openingConversation = false;
  private stopped = false;
  private pendingOwnTexts: string[] = [];
  private snapshot: ChatSnapshot = {
    state: "starting",
    conversations: [],
    messages: [],
    detail: "Kakao native connector를 시작하는 중",
  };

  public getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    if (process.platform !== "darwin") {
      this.update({ ...this.snapshot, state: "error", detail: "KakaoTalk connector는 macOS 전용입니다." });
      return;
    }
    try {
      await openKakaoTalkApplication();
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.stopped) return;
      // Keep slow inbox/message traversal off the process that handles user
      // actions. A send must never wait behind a background Accessibility read.
      await this.readBridge.start();
      if (this.stopped) {
        await this.readBridge.stop();
        return;
      }
      await this.actionBridge.start();
      if (this.stopped) {
        await Promise.all([this.readBridge.stop(), this.actionBridge.stop()]);
        return;
      }
      await this.readBridge.request("ensureMain", {});
      if (this.stopped) return;
      await this.refresh();
      if (this.stopped) return;
      this.refreshTimer = setInterval(() => void this.refresh(), 2_000);
    } catch (error) {
      this.update({ ...this.snapshot, state: "error", detail: errorMessage(error) });
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    const refreshPromise = this.refreshPromise;
    // Stop the bridge first so an Accessibility request cannot indefinitely
    // delay shutdown after KakaoTalk itself has been closed.
    await Promise.all([this.readBridge.stop(), this.actionBridge.stop()]);
    await refreshPromise?.catch(() => undefined);
  }

  public refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  public async openConversation(id: string): Promise<void> {
    this.openingConversation = true;
    try {
      // The read bridge scrolls the real KakaoTalk list while collecting rows.
      // Never let prepareOpen race that traversal or its cached row can point
      // at a different room by the time the click is delivered.
      await this.refreshPromise?.catch(() => undefined);
      const row = this.rowById.get(id);
      const conversation = this.snapshot.conversations.find((item) => item.id === id);
      if (!row || !conversation) throw new Error("KakaoTalk 대화방을 찾을 수 없습니다.");
      const point = await this.actionBridge.request<NativePoint>("prepareOpen", {
        row,
        title: conversation.title,
      });
      if (!point.alreadyOpen) {
        await this.actionBridge.request("doubleClick", { x: point.x, y: point.y });
        await this.actionBridge.request("waitForWindow", { title: conversation.title });
      }
      this.activeConversationId = id;
      this.activeTitle = conversation.title;
      this.update({
        ...this.snapshot,
        state: "connected",
        activeConversationId: id,
        messages: this.history.get(id) ?? [],
        detail: "KakaoTalk native · Accessibility",
      });
      // Resolve and cache the composer controls while the user is reading the
      // room, rather than making their first send pay for a full AX tree walk.
      void this.actionBridge
        .request("prepareComposer", { title: conversation.title })
        .catch(() => undefined);
    } finally {
      this.openingConversation = false;
    }
    void this.refresh();
  }

  public async sendMessage(text: string): Promise<void> {
    if (!this.activeTitle) throw new Error("KakaoTalk 대화를 먼저 선택하세요.");
    const normalizedText = text.trim();
    this.pendingOwnTexts = [...this.pendingOwnTexts.slice(-19), normalizedText];
    this.sending = true;
    try {
      const result = await this.actionBridge.request<NativeSendResult>("send", {
        title: this.activeTitle,
        text,
      });
      if (!result.confirmed) throw new Error("KakaoTalk에서 메시지 전송을 확인하지 못했습니다.");
    } catch (error) {
      const pendingIndex = this.pendingOwnTexts.lastIndexOf(normalizedText);
      if (pendingIndex >= 0) this.pendingOwnTexts.splice(pendingIndex, 1);
      throw error;
    } finally {
      this.sending = false;
    }
    const threadId = this.activeConversationId;
    if (threadId) {
      const messages = [
        ...(this.history.get(threadId) ?? []),
        {
          id: `sent-${Date.now()}-${stableHash(normalizedText)}`,
          threadId,
          kind: "text" as const,
          sender: "나",
          text: normalizedText,
        },
      ].slice(-500);
      this.history.set(threadId, messages);
      this.update({
        ...this.snapshot,
        state: "connected",
        activeConversationId: threadId,
        messages,
      });
    }

    // The composer clearing already confirmed delivery to KakaoTalk. Reconcile
    // timestamps and the surrounding message window without blocking the UI.
    this.conversationsRefreshedAt = Date.now();
    void this.refresh();
  }

  public async loadOlderMessages(): Promise<number> {
    if (!this.activeConversationId || !this.activeTitle) return 0;
    const before = this.history.get(this.activeConversationId)?.length ?? 0;
    await this.actionBridge.request("scrollOlder", { title: this.activeTitle });
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
    await this.refreshPromise?.catch(() => undefined);
    const before = this.snapshot.conversations.length;
    this.conversationLimit += 10;
    this.conversationsRefreshedAt = 0;
    await this.refresh();
    return Math.max(0, this.snapshot.conversations.length - before);
  }

  private async performRefresh(): Promise<void> {
    if (this.stopped || this.sending || this.openingConversation) return;
    try {
      let conversations = this.snapshot.conversations;
      if (
        conversations.length === 0 ||
        Date.now() - this.conversationsRefreshedAt >= CONVERSATION_REFRESH_INTERVAL_MS
      ) {
        const nativeRows = await this.readBridge.request<NativeConversation[]>("conversations", {
          limit: this.conversationLimit,
        });
        this.canLoadMoreConversations = nativeRows.length >= this.conversationLimit;
        this.rowById.clear();
        conversations = nativeRows.map((row) => {
          const title = normalizeKakaoField(row.title) || "KakaoTalk";
          const preview = normalizeKakaoField(row.preview);
          const time = normalizeKakaoField(row.time);
          const id = `room-${stableHash(title)}`;
          this.rowById.set(id, row.row);
          return {
            id,
            href: `kakaotalk:${row.row}`,
            title,
            preview: [preview, time].filter(Boolean).join(" · "),
            unread: row.unread,
          };
        });
        this.conversationsRefreshedAt = Date.now();
      }

      let messages = this.activeConversationId
        ? this.history.get(this.activeConversationId) ?? []
        : [];
      if (this.activeConversationId && this.activeTitle) {
        const messageThreadId = this.activeConversationId;
        const messageWindowTitle = this.activeTitle;
        const rawMessages = await this.readBridge.request<RawMessage[]>("messages", {
          title: messageWindowTitle,
          direction: this.loadingOlder ? "older" : "newer",
          limit: this.loadingOlder ? 15 : 8,
        });
        if (messageThreadId !== this.activeConversationId) return;
        const reconciled = reconcilePendingOwnMessages(rawMessages, this.pendingOwnTexts);
        this.pendingOwnTexts = reconciled.remaining;
        const visibleMessages = reconciled.messages
          .map((raw, index) => normalizeMessage(messageThreadId, raw, index))
          .filter((item): item is ChatMessage => item !== undefined);
        // A send may complete on the action bridge while this read is in flight.
        // Merge against the latest history so that confirmed local messages are
        // not overwritten by a stale background window.
        messages = this.history.get(messageThreadId) ?? messages;
        messages = mergeMessageWindows(
          messages,
          visibleMessages,
          this.loadingOlder ? "older" : "newer",
        ).slice(-500);
        this.history.set(messageThreadId, messages);
      }
      if (this.stopped) return;
      this.update({
        state: "connected",
        conversations,
        activeConversationId: this.activeConversationId,
        messages,
        detail: "KakaoTalk native · Accessibility",
      });
    } catch (error) {
      this.update({ ...this.snapshot, state: "error", detail: errorMessage(error) });
    }
  }

  private update(snapshot: ChatSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }
}

export function reconcilePendingOwnMessages(
  rawMessages: RawMessage[],
  pendingOwnTexts: string[],
): { messages: RawMessage[]; remaining: string[] } {
  const messages = rawMessages.map((message) => ({ ...message }));
  const remaining: string[] = [];
  const matchedIndexes = new Set<number>();
  for (const pendingText of pendingOwnTexts) {
    let matchIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (!matchedIndexes.has(index) && messages[index]!.text.trim() === pendingText.trim()) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex < 0) {
      remaining.push(pendingText);
    } else {
      matchedIndexes.add(matchIndex);
      messages[matchIndex] = { ...messages[matchIndex]!, sender: "나" };
    }
  }
  return { messages, remaining };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function normalizeKakaoField(value: string): string {
  return value
    .replaceAll("\u00a0", " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
