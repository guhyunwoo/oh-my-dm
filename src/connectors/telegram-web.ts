import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import { resolveBrowserExecutable } from "../browser/resolve-browser.js";
import type { ChatConnector, ChatSnapshot } from "../domain.js";
import { getCopy, resolveLanguage, type LanguagePreference } from "../ui/i18n.js";
import { mergeTelegramMessages, readTelegramDom } from "./telegram-dom.js";

export const TELEGRAM_WEB_URL = "https://web.telegram.org/k/";
export const TELEGRAM_CHAT_SELECTOR = "#column-center .chat:visible";
export const TELEGRAM_EDITOR_SELECTOR = '.input-message-input[contenteditable="true"]';

export interface TelegramWebOptions {
  profileDir: string;
  headless?: boolean;
  language?: LanguagePreference;
}

export class TelegramWebConnector extends EventEmitter implements ChatConnector {
  private context?: BrowserContext;
  private page?: Page;
  private timer?: NodeJS.Timeout;
  private desiredRunning = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private polling = false;
  private historyMode = false;
  private snapshot: ChatSnapshot = {
    state: "starting", conversations: [], messages: [],
  };

  public constructor(private readonly options: TelegramWebOptions) {
    super();
    this.snapshot.detail = this.copy.telegramStarting;
  }

  private get copy() {
    return getCopy(resolveLanguage(this.options.language));
  }

  public getSnapshot(): ChatSnapshot { return this.snapshot; }

  public start(): Promise<void> {
    this.desiredRunning = true;
    return this.queueLifecycle(async () => {
      if (!this.desiredRunning || this.page && !this.page.isClosed()) return;
      await this.context?.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
      try {
        await fs.mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
        this.context = await chromium.launchPersistentContext(this.options.profileDir, {
          executablePath: resolveBrowserExecutable().executablePath,
          headless: this.options.headless ?? true,
          viewport: { width: 1100, height: 780 },
        });
        this.page = this.context.pages()[0] ?? await this.context.newPage();
        this.page.on("close", () => {
          if (this.timer) clearInterval(this.timer);
          this.timer = undefined;
          if (this.desiredRunning) this.publish({ ...this.snapshot, state: "disconnected", detail: this.copy.telegramTabClosed });
        });
        await this.page.goto(TELEGRAM_WEB_URL, { waitUntil: "domcontentloaded" });
        // Authentication UI and app initialization are asynchronous. Avoid treating
        // a blank bootstrap page as a logged-out session.
        await this.page.locator("#auth-pages:visible, #page-auth:visible, #page-chats:visible").first()
          .waitFor({ state: "visible", timeout: 30_000 });
        await this.readSnapshot();
        this.timer = setInterval(() => {
          if (this.polling || !this.desiredRunning) return;
          this.polling = true;
          void this.refresh().catch((error: unknown) => {
            if (this.desiredRunning) this.publish({ ...this.snapshot, state: "error", detail: error instanceof Error ? error.message : String(error) });
          }).finally(() => { this.polling = false; });
        }, 1500);
      } catch (error) {
        await this.context?.close().catch(() => undefined);
        this.context = undefined;
        this.page = undefined;
        const detail = error instanceof Error ? error.message : String(error);
        this.publish({ state: "error", conversations: [], messages: [], detail });
        throw error;
      }
    });
  }

  public stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.queueLifecycle(async () => {
      if (this.desiredRunning) return;
      await this.operations.catch(() => undefined);
      await this.context?.close();
      this.context = undefined;
      this.page = undefined;
      this.historyMode = false;
      this.publish({ state: "disconnected", conversations: [], messages: [] });
    });
  }

  public refresh(): Promise<void> {
    return this.queueOperation(() => this.readSnapshot());
  }

  public openConversation(id: string): Promise<void> {
    return this.queueOperation(async () => {
      const page = this.requirePage();
      if (!/^-?\d+$/.test(id) || !this.snapshot.conversations.some((item) => item.id === id)) {
        throw new Error(this.copy.telegramConversationNotFound(id));
      }
      const row = page.locator(`#chatlist-container .chatlist-chat[data-peer-id="${id}"]:not([data-thread-id]):visible`).first();
      if (await row.count()) {
        // WebK handles pointer activation on mousedown and cancels the anchor's
        // default click. A real title click avoids avatars that open stories.
        await row.locator(".user-title").click({ timeout: 5000 });
      } else {
        // A cached row can have been virtualized away. WebK consumes deep links
        // on startup, but may intercept same-document hash navigation.
        await page.evaluate((peerId) => {
          const url = new URL(location.href);
          url.hash = peerId;
          history.replaceState(history.state, "", url);
        }, id);
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      await page.waitForFunction(({ id: target }) => {
        const chats = [...document.querySelectorAll<HTMLElement>("#column-center .chat")];
        const chat = chats.filter((node) => node.getBoundingClientRect().height > 0).at(-1);
        const peer = chat?.querySelector<HTMLElement>(".input-message-input[data-peer-id]")?.dataset.peerId ||
          chat?.querySelector<HTMLElement>(".bubbles-scrollable .bubble[data-peer-id]")?.dataset.peerId;
        return peer === target;
      }, { id }, { timeout: 10_000 });
      this.historyMode = false;
      await this.readSnapshot();
    });
  }

  public sendMessage(text: string): Promise<void> {
    return this.queueOperation(async () => {
      const message = text.trim();
      if (!message) return;
      const page = this.requirePage();
      const expected = this.snapshot.activeConversationId;
      if (!expected || this.snapshot.state !== "connected") throw new Error(this.copy.telegramChooseConversation);
      const current = await page.evaluate(readTelegramDom);
      if (!current.authenticated || current.activeConversationId !== expected) {
        throw new Error(this.copy.telegramConversationChanged);
      }
      const chat = page.locator(TELEGRAM_CHAT_SELECTOR)
        .filter({ has: page.locator(`.input-message-input[data-peer-id="${expected}"]`) }).last();
      const editor = chat.locator(TELEGRAM_EDITOR_SELECTOR);
      await editor.waitFor({ state: "visible", timeout: 5000 });
      // Never overwrite an existing draft or submit an edit/forward/reply.
      if ((await editor.innerText()).trim() || await chat.evaluate((node) => node.classList.contains("is-helper-active"))) {
        throw new Error(this.copy.telegramDraftExists);
      }
      const previousIds = new Set(current.messages.map((item) => item.id));
      await editor.fill(message);
      const beforeSend = await page.evaluate(readTelegramDom);
      if (beforeSend.activeConversationId !== expected) {
        throw new Error(this.copy.telegramSendAborted);
      }
      // Clicking the send-only state ignores Telegram's configurable Enter key setting.
      await chat.locator(".btn-send.send").click({ timeout: 5000 });
      this.historyMode = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(150);
        const next = await page.evaluate(readTelegramDom);
        if (next.activeConversationId !== expected) break;
        if (next.messages.some((item) => !previousIds.has(item.id) && item.sender === "나" && item.text === message)) {
          await this.readSnapshot();
          return;
        }
      }
      await this.readSnapshot();
      throw new Error(this.copy.telegramSendUnconfirmed);
    });
  }

  public loadOlderMessages(): Promise<number> {
    return this.queueOperation(async () => {
      const page = this.requirePage();
      const id = this.snapshot.activeConversationId;
      if (!id) return 0;
      const count = this.snapshot.messages.length;
      this.historyMode = true;
      await page.locator(TELEGRAM_CHAT_SELECTOR).last().locator(".bubbles-scrollable").evaluate((node) => {
        node.scrollBy({ top: -Math.max(100, node.clientHeight * 0.7), behavior: "instant" });
      });
      await page.waitForTimeout(500);
      await this.readSnapshot();
      return this.snapshot.activeConversationId === id ? Math.max(0, this.snapshot.messages.length - count) : 0;
    });
  }

  public loadMoreConversations(): Promise<number> {
    return this.queueOperation(async () => {
      const page = this.requirePage();
      const count = this.snapshot.conversations.length;
      await page.locator("#chatlist-container .folders-scrollable:visible").first().evaluate((node) => {
        node.scrollBy({ top: Math.max(100, node.clientHeight * 0.8), behavior: "instant" });
      });
      await page.waitForTimeout(500);
      await this.readSnapshot();
      return Math.max(0, this.snapshot.conversations.length - count);
    });
  }

  private async readSnapshot(): Promise<void> {
    const raw = await this.requirePage().evaluate(readTelegramDom);
    if (!raw.authenticated) {
      this.historyMode = false;
      const login = await this.requirePage().locator("#auth-pages:visible, #page-auth:visible").count();
      this.publish({ state: login ? "login-required" : "starting", conversations: [], messages: [],
        detail: login ? this.copy.telegramLoginRequired : this.copy.telegramLoading });
      return;
    }
    const conversations = new Map(this.snapshot.conversations.map((item) => [item.id, item]));
    for (const item of raw.conversations) conversations.set(item.id, item);
    const same = raw.activeConversationId && raw.activeConversationId === this.snapshot.activeConversationId;
    const merged = mergeTelegramMessages(same ? this.snapshot.messages : [], raw.messages);
    this.publish({ state: "connected", conversations: [...conversations.values()],
      activeConversationId: raw.activeConversationId,
      messages: this.historyMode && same ? merged.slice(0, 500) : merged.slice(-500),
      detail: "Telegram WebK · live DOM · 1.5s refresh" });
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error(this.copy.telegramNotStarted);
    return this.page;
  }

  private queueLifecycle(task: () => Promise<void>): Promise<void> {
    const pending = this.lifecycle.then(task, task);
    this.lifecycle = pending.catch(() => undefined);
    return pending;
  }

  private queueOperation<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(task, task);
    this.operations = pending.catch(() => undefined);
    return pending;
  }

  private publish(snapshot: ChatSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }
}
