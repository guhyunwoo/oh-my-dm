import { EventEmitter } from "node:events";

import type {
  ChatConnector,
  ChatSnapshot,
  ConnectorStatus,
  Conversation,
} from "../domain.js";

export interface ConnectorEntry {
  id: string;
  label: string;
  connector: ChatConnector;
}

export class UnifiedChatConnector extends EventEmitter implements ChatConnector {
  private activeProviderId?: string;
  private readonly snapshots = new Map<string, ChatSnapshot>();
  private snapshot: ChatSnapshot = {
    state: "starting",
    conversations: [],
    messages: [],
    detail: "connectors를 시작하는 중",
  };

  public constructor(private readonly entries: ConnectorEntry[]) {
    super();
    for (const entry of entries) this.snapshots.set(entry.id, entry.connector.getSnapshot());
    this.rebuildSnapshot();
  }

  public getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  public async start(): Promise<void> {
    for (const entry of this.entries) {
      entry.connector.on("snapshot", (snapshot) => {
        this.snapshots.set(entry.id, snapshot);
        this.rebuildSnapshot();
      });
      entry.connector.on("error", (error) => this.emit("error", error));
    }
    await Promise.allSettled(this.entries.map((entry) => entry.connector.start()));
    this.rebuildSnapshot();
  }

  public async stop(): Promise<void> {
    await Promise.allSettled(this.entries.map((entry) => entry.connector.stop()));
  }

  public async refresh(): Promise<void> {
    await Promise.allSettled(this.entries.map((entry) => entry.connector.refresh()));
    this.rebuildSnapshot();
  }

  public async openConversation(id: string): Promise<void> {
    const parsed = parseUnifiedId(id);
    const entry = this.entries.find((item) => item.id === parsed.provider);
    if (!entry) throw new Error(`connector를 찾을 수 없습니다: ${parsed.provider}`);
    this.activeProviderId = entry.id;
    await entry.connector.openConversation(parsed.id);
    this.rebuildSnapshot();
  }

  public async sendMessage(text: string): Promise<void> {
    await this.requireActive().connector.sendMessage(text);
  }

  public async loadOlderMessages(): Promise<number> {
    return this.requireActive().connector.loadOlderMessages();
  }

  public async loadMoreConversations(provider?: string): Promise<number> {
    const entry = provider
      ? this.entries.find((item) => item.id === provider)
      : this.entries.find((item) => item.id === this.activeProviderId);
    if (!entry) throw new Error(`connector를 찾을 수 없습니다: ${provider ?? "active"}`);
    return entry.connector.loadMoreConversations();
  }

  private requireActive(): ConnectorEntry {
    const entry = this.entries.find((item) => item.id === this.activeProviderId);
    if (!entry) throw new Error("먼저 대화를 선택하세요.");
    return entry;
  }

  private rebuildSnapshot(): void {
    const connectors: ConnectorStatus[] = this.entries.map((entry) => {
      const snapshot = this.snapshots.get(entry.id)!;
      return { id: entry.id, label: entry.label, state: snapshot.state, detail: snapshot.detail };
    });
    const conversations: Conversation[] = this.entries.flatMap((entry) =>
      (this.snapshots.get(entry.id)?.conversations ?? []).map((conversation) => ({
        ...conversation,
        id: `${entry.id}:${conversation.id}`,
        provider: entry.id,
      })),
    );
    const activeSnapshot = this.activeProviderId
      ? this.snapshots.get(this.activeProviderId)
      : undefined;
    const connected = connectors.some((item) => item.state === "connected");
    const failed = connectors.some(
      (item) => item.state === "error" || item.state === "disconnected",
    );
    this.snapshot = {
      state: connected
        ? "connected"
        : failed
          ? "error"
          : connectors.some((item) => item.state === "starting")
            ? "starting"
            : "error",
      conversations,
      activeConversationId:
        this.activeProviderId && activeSnapshot?.activeConversationId
          ? `${this.activeProviderId}:${activeSnapshot.activeConversationId}`
          : undefined,
      messages: activeSnapshot?.messages ?? [],
      connectors,
      detail: `${connectors.filter((item) => item.state === "connected").length}/${connectors.length} connectors connected`,
    };
    this.emit("snapshot", this.snapshot);
  }
}

function parseUnifiedId(value: string): { provider: string; id: string } {
  const separator = value.indexOf(":");
  if (separator < 1) return { provider: "instagram", id: value };
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}
