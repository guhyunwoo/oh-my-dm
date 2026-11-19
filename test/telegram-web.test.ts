import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { chromium } from "playwright-core";

import { createConfiguredTelegramConnector, TelegramWebConnector, TELEGRAM_WEB_URL } from "../src/connectors/telegram-web.js";
import { readTelegramDom, mergeTelegramMessages } from "../src/connectors/telegram-dom.js";

const fixture = `
<style>.hide {display:none} .chat, #page-chats, #auth-pages {min-height:30px} .bubble, .chatlist-chat, .badge {display:block;min-height:20px}</style>
<div id="auth-pages" style="display:none">Log in with QR code</div>
<div id="page-chats">
  <div id="chatlist-container"><div class="folders-scrollable" style="height:100px;overflow-y:auto">
    <a class="chatlist-chat" data-peer-id="11" href="#11"><div class="user-title"><span class="peer-title">Alice</span></div><div class="dialog-subtitle">Hello<span class="dialog-subtitle-badge-unread badge">2</span></div></a>
    <a class="chatlist-chat" data-peer-id="-22" href="#-22"><div class="user-title"><span class="peer-title">Team</span></div></a>
    <div style="height:500px"></div>
  </div></div>
  <div id="column-center"><div class="chat">
    <div class="chat-info"><span class="peer-title">Alice</span></div>
    <div class="bubbles-scrollable" style="height:100px;overflow-y:auto"></div>
    <div class="chat-input"><div class="input-message-input" contenteditable="true" data-peer-id="11"></div><button class="btn-send send">Send</button><div class="reply-wrapper hide"></div></div>
  </div></div>
</div>
<script>
  window.sent = [];
  window.counter = 10;
  window.bubble = (mid, text, out = false, peer = '11') => '<div class="bubble ' + (out ? 'is-out' : 'is-in') + '" data-mid="' + mid + '" data-peer-id="' + peer + '" data-timestamp="1700000000"><div class="message">' + text + '<span class="time">10:00</span></div></div>';
  window.renderChat = () => {
    const peer = window.activePeer || location.hash.slice(1) || '11';
    document.querySelector('.input-message-input').dataset.peerId = peer;
    document.querySelector('.input-message-input').textContent = '';
    document.querySelector('.chat-info .peer-title').textContent = peer === '11' ? 'Alice' : 'Team';
    const scroller = document.querySelector('.bubbles-scrollable');
    scroller.innerHTML = window.bubble(1, 'Hello', false, peer) + '<div style="height:500px"></div>';
    scroller.scrollTop = 500;
  };
  // Match WebK's mousedown routing: changing location.hash alone does not open a chat.
  document.querySelector('#chatlist-container').addEventListener('mousedown', (event) => {
    const row = event.target.closest('.chatlist-chat');
    if (!row) return;
    window.activePeer = row.dataset.peerId;
    history.replaceState(null, '', '#/im?p=' + window.activePeer);
    window.renderChat();
  });
  document.querySelector('#chatlist-container').addEventListener('click', event => event.preventDefault());
  window.renderChat();
  document.querySelector('.btn-send').onclick = () => {
    const editor = document.querySelector('.input-message-input');
    window.sent.push({peer:editor.dataset.peerId, text:editor.innerText});
    document.querySelector('.bubbles-scrollable').insertAdjacentHTML('beforeend', window.bubble(++window.counter, editor.innerText, true, editor.dataset.peerId));
    editor.textContent = '';
  };
</script>`;

async function setup(t: TestContext, html = fixture, language: "ko" | "en" = "ko") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oh-my-dm-telegram-test-"));
  const launch = chromium.launchPersistentContext.bind(chromium);
  t.mock.method(chromium, "launchPersistentContext", async (profile: string, options: Parameters<typeof launch>[1]) => {
    const context = await launch(profile, options);
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    return context;
  });
  const connector = new TelegramWebConnector({ profileDir: path.join(root, "profile"), language });
  t.after(async () => { await connector.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await connector.start();
  const page = (connector as unknown as { page: import("playwright-core").Page }).page;
  return { connector, page };
}

test("Telegram starts against WebK, keeps peer IDs separate, switches chats and sends once", async (t) => {
  const { connector, page } = await setup(t);
  assert.equal(page.url(), TELEGRAM_WEB_URL);
  const snapshot = connector.getSnapshot();
  assert.equal(snapshot.state, "connected");
  assert.deepEqual(snapshot.conversations.map((item) => [item.id, item.title, item.preview, item.unread]), [
    ["11", "Alice", "Hello", true], ["-22", "Team", undefined, false],
  ]);
  assert.equal(snapshot.messages[0]?.text, "Hello");
  await connector.openConversation("-22");
  assert.equal(connector.getSnapshot().activeConversationId, "-22");
  assert.equal(new URL(page.url()).hash, "#/im?p=-22");
  assert.ok(connector.getSnapshot().messages.every((message) => message.threadId === "-22"));
  await connector.sendMessage("synthetic test message");
  assert.deepEqual(await page.evaluate("window.sent"), [{ peer: "-22", text: "synthetic test message" }]);
  assert.equal(connector.getSnapshot().messages.at(-1)?.text, "synthetic test message");
  await assert.rejects(connector.openConversation("https://example.com"), /대화를 찾을 수 없습니다/);
});

test("Telegram authentication is surfaced and no messages survive logout", async (t) => {
  const { connector, page } = await setup(t, fixture.replace('id="auth-pages" style="display:none"', 'id="auth-pages"').replace('id="page-chats"', 'id="page-chats" style="display:none"'));
  assert.equal(connector.getSnapshot().state, "login-required");
  assert.deepEqual(connector.getSnapshot().messages, []);
  await page.evaluate(() => {
    document.getElementById("auth-pages")!.style.display = "none";
    document.getElementById("page-chats")!.style.display = "block";
  });
  await connector.refresh();
  assert.equal(connector.getSnapshot().state, "connected");
  await page.evaluate(() => {
    document.getElementById("auth-pages")!.style.display = "block";
    document.getElementById("page-chats")!.style.display = "none";
  });
  await connector.refresh();
  assert.equal(connector.getSnapshot().activeConversationId, undefined);
  assert.deepEqual(connector.getSnapshot().conversations, []);
});

test("Telegram rejects changed recipients, existing drafts and reply/edit context", async (t) => {
  const { connector, page } = await setup(t);
  await connector.openConversation("11");
  await page.locator(".input-message-input").fill("existing draft");
  await assert.rejects(connector.sendMessage("new message"), /작성 중/);
  assert.equal(await page.locator(".input-message-input").innerText(), "existing draft");
  await page.locator(".input-message-input").fill("");
  await page.locator(".chat").evaluate((node) => node.classList.add("is-helper-active"));
  await assert.rejects(connector.sendMessage("new message"), /작성 중/);
  await page.locator(".chat").evaluate((node) => node.classList.remove("is-helper-active"));
  await page.evaluate(() => { document.querySelector<HTMLElement>(".input-message-input")!.dataset.peerId = "-22"; });
  await assert.rejects(connector.sendMessage("new message"), /대화가 변경/);
  assert.deepEqual(await page.evaluate("window.sent"), []);
});

test("Telegram reads only the active peer and removes reply/time UI from message text", async (t) => {
  const { page } = await setup(t);
  await page.locator(".bubbles-scrollable").evaluate((node) => {
    node.innerHTML = `
      <div class="bubble is-date" data-mid="date" data-peer-id="11">Today</div>
      <div class="bubble" data-mid="99" data-peer-id="-22"><div class="message">wrong peer</div></div>
      <div class="bubble" data-mid="1" data-peer-id="11" data-timestamp="1700000000"><div class="name"><span class="peer-title">Bob</span></div><div class="message"><div class="reply">quoted message</div>Hello<br>world<img alt="🙂"><span class="time">10:00</span><div class="reactions">2</div></div></div>
      <div class="bubble is-out sticker" data-mid="2" data-peer-id="11"></div>`;
  });
  const raw = await page.evaluate(readTelegramDom);
  assert.deepEqual(raw.messages.map((item) => [item.id, item.text, item.sender, item.kind]), [
    ["telegram:11:1", "Hello\nworld🙂", "Bob", "text"], ["telegram:11:2", "", "나", "sticker"],
  ]);
  const merged = mergeTelegramMessages(raw.messages, [{ ...raw.messages[0]!, text: "edited" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.text, "edited");
});

test("Telegram retains virtualized conversations and merges older messages after scrolling", async (t) => {
  const { connector, page } = await setup(t);
  await connector.openConversation("11");
  await page.locator("#chatlist-container").evaluate((node) => {
    node.querySelector('[data-peer-id="11"]')?.remove();
    node.querySelector(".folders-scrollable")!.addEventListener("scroll", () => {
      if (node.querySelector('[data-peer-id="33"]')) return;
      node.querySelector(".folders-scrollable")!.insertAdjacentHTML("beforeend", '<div class="chatlist-chat" data-peer-id="33"><div class="user-title">New peer</div></div>');
    });
  });
  assert.equal(await connector.loadMoreConversations(), 1);
  assert.deepEqual(connector.getSnapshot().conversations.map((item) => item.id), ["11", "-22", "33"]);
  await page.locator(".bubbles-scrollable").evaluate((node) => {
    node.addEventListener("scroll", () => {
      if (node.querySelector('[data-mid="0"]')) return;
      node.insertAdjacentHTML("afterbegin", '<div class="bubble" data-peer-id="11" data-mid="0" data-timestamp="1600000000"><div class="message">older</div></div>');
    });
  });
  assert.equal(await connector.loadOlderMessages(), 1);
  assert.equal(connector.getSnapshot().messages[0]?.text, "older");
  await connector.stop();
  assert.equal(page.isClosed(), true);
  assert.equal(connector.getSnapshot().state, "disconnected");
});

test("Telegram lifecycle handles overlapping start/stop without leaking browsers", async (t) => {
  const { connector, page } = await setup(t);
  await Promise.all([connector.stop(), connector.start()]);
  assert.equal(page.isClosed(), false);
  await connector.stop();
  assert.equal(page.isClosed(), true);
  await assert.rejects(connector.refresh(), /시작되지 않았습니다/);
});

test("Telegram opens cached rows via a startup deep link when the row is virtualized away", async (t) => {
  const { connector, page } = await setup(t);
  await page.evaluate(() => { location.hash = "-22"; });
  await page.waitForTimeout(50);
  // WebK can change/intercept the URL without changing the rendered conversation.
  assert.equal((await page.evaluate(readTelegramDom)).activeConversationId, "11");
  await connector.openConversation("-22");
  assert.equal(connector.getSnapshot().activeConversationId, "-22");
  await page.locator('.chatlist-chat[data-peer-id="11"]').evaluate((node) => node.remove());
  await connector.openConversation("11");
  assert.equal(connector.getSnapshot().activeConversationId, "11");
  assert.ok(connector.getSnapshot().messages.every((message) => message.threadId === "11"));
});


test("Telegram status and draft errors honor the selected English language", async (t) => {
  const loggedOut = fixture.replace('id="auth-pages" style="display:none"', 'id="auth-pages"')
    .replace('id="page-chats"', 'id="page-chats" style="display:none"');
  const { connector, page } = await setup(t, loggedOut, "en");
  assert.equal(connector.getSnapshot().detail, "Telegram login required. Run `oh-my-dm login telegram`.");
  await page.evaluate(() => {
    document.getElementById("auth-pages")!.style.display = "none";
    document.getElementById("page-chats")!.style.display = "block";
  });
  await connector.refresh();
  await connector.openConversation("11");
  await page.locator(".input-message-input").fill("synthetic draft");
  await assert.rejects(connector.sendMessage("test"), /existing Telegram Web draft/);
  assert.deepEqual(await page.evaluate("window.sent"), []);
});


test("Telegram removes terminal controls before publishing page-controlled text", async (t) => {
  const { connector, page } = await setup(t);
  await page.evaluate(() => {
    document.querySelector('.chatlist-chat .user-title .peer-title')!.textContent = "Alice\n\t\r\b\x7f\x85\x9bTeam";
    document.querySelector('.dialog-subtitle')!.textContent = "hello\r\b\x85world\nnext";
    document.querySelector('.bubble .message')!.textContent = "hello\x1b[8mhidden\x1b[0m\nnext\rline\b!\x85\x9b";
    const name = document.createElement("div");
    name.className = "name";
    const sender = document.createElement("span");
    sender.className = "peer-title";
    sender.textContent = "Bob\n\x9bTeam";
    name.append(sender);
    document.querySelector('.bubble')!.prepend(name);
  });
  await connector.refresh();
  const snapshot = connector.getSnapshot();
  assert.equal(snapshot.conversations[0]?.title, "Alice Team");
  assert.equal(snapshot.conversations[0]?.preview, "hello world next");
  assert.equal(snapshot.messages[0]?.sender, "Bob Team");
  assert.equal(snapshot.messages[0]?.text, "hello[8mhidden[0m\nnextline!");
  for (const conversation of snapshot.conversations) {
    assert.doesNotMatch(conversation.title + conversation.preview, /[\u0000-\u001f\u007f-\u009f]/);
  }
  assert.doesNotMatch(snapshot.messages[0]!.text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test("Telegram discards invalid active peer IDs before snapshots and selector construction", async (t) => {
  const { connector, page } = await setup(t);
  for (const peerId of ['11"] .btn-send', "@alice", "NaN", "11\n", "1.5"]) {
    await page.locator('.input-message-input').evaluate((node, id) => { (node as HTMLElement).dataset.peerId = id; }, peerId);
    await connector.refresh();
    assert.equal(connector.getSnapshot().activeConversationId, undefined);
    assert.deepEqual(connector.getSnapshot().messages, []);
    await assert.rejects(connector.sendMessage("must not send"), /대화를 선택/);
  }
  assert.deepEqual(await page.evaluate("window.sent"), []);
});

test("Telegram chat registration requires an existing profile and never creates one", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oh-my-dm-telegram-opt-in-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profileDir = path.join(root, "telegram");
  const launches = t.mock.method(chromium, "launchPersistentContext", async () => {
    throw new Error("Registration must not launch Chromium");
  });
  assert.equal(await createConfiguredTelegramConnector({ profileDir }), undefined);
  await assert.rejects(fs.stat(profileDir), { code: "ENOENT" });
  await fs.writeFile(profileDir, "not a directory");
  assert.equal(await createConfiguredTelegramConnector({ profileDir }), undefined);
  await fs.unlink(profileDir);
  await fs.mkdir(profileDir);
  const connector = await createConfiguredTelegramConnector({ profileDir });
  assert.ok(connector instanceof TelegramWebConnector);
  assert.equal(launches.mock.callCount(), 0);
  await fs.rm(profileDir, { recursive: true }); // logout removes opt-in on next startup
  assert.equal(await createConfiguredTelegramConnector({ profileDir }), undefined);
});
