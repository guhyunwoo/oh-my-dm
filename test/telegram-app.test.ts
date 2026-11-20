import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";

import type { ChatConnector, ChatSnapshot } from "../src/domain.js";
import { App } from "../src/ui/app.js";
import { getCopy } from "../src/ui/i18n.js";

class UnconfiguredTelegram extends EventEmitter implements ChatConnector {
  public getSnapshot(): ChatSnapshot {
    return {
      state: "connected", conversations: [], messages: [],
      connectors: [{ id: "instagram", label: "Instagram", state: "connected" }],
    };
  }
  public started = false;
  public async start() { this.started = true; }
  public async stop() {}
  public async refresh() {}
  public async openConversation() {}
  public async sendMessage() {}
  public async loadOlderMessages() { return 0; }
  public async loadMoreConversations() { return 0; }
}

test("an unregistered Telegram tab shows login instructions in both languages", async () => {
  for (const language of ["ko", "en"] as const) {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 36, isTTY: true });
    let output = "";
    stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const connector = new UnconfiguredTelegram();
    const app = render(React.createElement(App, {
      connector, initialLanguage: language,
    }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      const waitForText = async (text: string) => {
        for (let attempt = 0; attempt < 100 && !output.includes(text); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(output.includes(text), `${language}: missing expected rendered text`);
      };
      await waitForText(getCopy(language).placeholder);
      for (let attempt = 0; attempt < 100 && !connector.started; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(connector.started);
      stdin.write("/conversations\r");
      await waitForText(getCopy(language).waitingConversations);
      stdin.write("\x1b[D"); // Left wraps from Instagram to Telegram.
      await waitForText(getCopy(language).telegramLoginRequired);
      assert.ok(output.includes(getCopy(language).telegramLoginRequired), `${language}: missing Telegram login notice`);
    } finally {
      app.unmount();
      app.cleanup();
      stdin.destroy();
      stdout.destroy();
    }
  }
});
