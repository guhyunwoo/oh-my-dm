import type { ChatMessage, Conversation } from "../domain.js";

// Telegram WebK source reference (DOM contracts, not private API calls):
// https://github.com/morethanwords/tweb/tree/2e4bbb52b6aec5e95ee32e5c2882c1f05de32200
export interface TelegramDomSnapshot {
  authenticated: boolean;
  conversations: Conversation[];
  activeConversationId?: string;
  messages: ChatMessage[];
}

// Self-contained callback: Playwright serializes this into the page.
export function readTelegramDom(): TelegramDomSnapshot {
  const conversations: Conversation[] = [];
  const seen = new Set<string>();
  for (const row of document.querySelectorAll<HTMLElement>("#chatlist-container .chatlist-chat[data-peer-id]")) {
    if (!row.getBoundingClientRect().height || row.dataset.threadId) continue;
    const id = row.dataset.peerId;
    const title = row.querySelector(".user-title .peer-title, .user-title")?.textContent?.trim();
    if (!id || !/^-?\d+$/.test(id) || id === "0" || !title || seen.has(id)) continue;
    seen.add(id);
    const preview = row.querySelector(".dialog-subtitle")?.cloneNode(true) as HTMLElement | undefined;
    preview?.querySelectorAll(".badge, .message-status").forEach((node) => node.remove());
    const badge = row.querySelector<HTMLElement>(".dialog-subtitle-badge-unread, .avatar-badge");
    conversations.push({
      id, provider: "telegram", title, href: `#${id}`,
      preview: preview?.textContent?.trim() || undefined,
      unread: Boolean(badge && badge.getBoundingClientRect().height && !badge.classList.contains("hide")),
    });
  }
  const chat = [...document.querySelectorAll<HTMLElement>("#column-center .chat")]
    .filter((node) => node.getBoundingClientRect().height > 0).at(-1);
  const editor = chat?.querySelector<HTMLElement>(".input-message-input[data-peer-id]");
  const activeConversationId = editor?.dataset.peerId ||
    chat?.querySelector<HTMLElement>(".bubbles-scrollable .bubble[data-peer-id]")?.dataset.peerId;
  const title = chat?.querySelector(".chat-info .peer-title")?.textContent?.trim();
  const messages: ChatMessage[] = [];
  const messageIds = new Set<string>();
  if (activeConversationId && /^-?\d+$/.test(activeConversationId)) {
    for (const bubble of chat?.querySelectorAll<HTMLElement>(".bubbles-scrollable .bubble[data-mid]") ?? []) {
      if (bubble.classList.contains("is-date") || bubble.dataset.peerId !== activeConversationId) continue;
      const mid = bubble.dataset.mid;
      if (!mid || messageIds.has(mid)) continue;
      messageIds.add(mid);
      const content = bubble.querySelector(".message, .service-msg")?.cloneNode(true) as HTMLElement | undefined;
      content?.querySelectorAll(".time, .time-inner, .reply, .reactions, .name, .reply-markup").forEach((node) => node.remove());
      // Emoji images carry text in alt; don't silently drop them.
      content?.querySelectorAll<HTMLImageElement>("img[alt]").forEach((image) => image.replaceWith(image.alt));
      content?.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
      const text = content?.textContent?.trim() ?? "";
      const service = bubble.classList.contains("service");
      const kind = service ? "system" : bubble.classList.contains("sticker") ? "sticker"
        : bubble.querySelector("video") ? "video" : bubble.querySelector(".photo") ? "image" : "text";
      const seconds = Number(bubble.dataset.timestamp);
      messages.push({
        id: `telegram:${activeConversationId}:${mid}`, threadId: activeConversationId,
        kind, text: text || (kind === "text" ? "[attachment]" : ""),
        sender: service ? "system" : bubble.classList.contains("is-out") ? "나"
          : bubble.querySelector(".name .peer-title")?.textContent?.trim() || title || "unknown",
        timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined,
      });
    }
  }
  return {
    authenticated: Boolean(document.querySelector<HTMLElement>("#page-chats")?.getBoundingClientRect().height),
    conversations, activeConversationId, messages,
  };
}

export function mergeTelegramMessages(previous: ChatMessage[], visible: ChatMessage[]): ChatMessage[] {
  const merged = new Map(previous.map((message) => [message.id, message]));
  for (const message of visible) merged.set(message.id, message);
  return [...merged.values()].sort((left, right) => {
    return Number(left.id.split(":").at(-1)) - Number(right.id.split(":").at(-1));
  });
}
