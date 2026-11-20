import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import {
  getConversationLayout,
  padToWidth,
  planConnectorPanel,
  shouldShowComposerHints,
  truncateToWidth,
} from "../src/ui/text-layout.js";

test("한글을 터미널 두 칸 너비로 계산해 패딩한다", () => {
  assert.equal(stringWidth(padToWidth("김태현", 10)), 10);
});

test("긴 미리보기를 표시 폭 안에서 말줄임한다", () => {
  const value = truncateToWidth("회원님의 메시지에 😢로 공감했습니다", 18);
  assert.ok(stringWidth(value) <= 18);
  assert.match(value, /…$/);
});

test("좁은 터미널에서도 대화방 헤더와 행 너비가 화면을 넘지 않는다", () => {
  for (const columns of [24, 31, 32, 50, 69, 70, 80]) {
    const layout = getConversationLayout(columns);
    assert.ok(layout.pathWidth + layout.tabsWidth <= layout.contentWidth);

    const rowWidth = layout.showPreview
      ? 5 + layout.titleWidth + layout.previewWidth
      : 5 + layout.titleWidth;
    assert.ok(rowWidth <= layout.contentWidth, `${columns} columns: ${rowWidth}`);
  }
});

test("아주 좁은 화면에서는 connector 탭을 축약한다", () => {
  const compact = getConversationLayout(28);
  const regular = getConversationLayout(50);

  assert.equal(compact.compactTabs, true);
  assert.equal(compact.tabsWidth, 9);
  assert.equal(regular.compactTabs, false);
  assert.equal(regular.tabsWidth, 25);
});

test("메시지를 입력하기 시작하면 composer 단축키 안내를 숨긴다", () => {
  assert.equal(shouldShowComposerHints(80, ""), true);
  assert.equal(shouldShowComposerHints(80, "메시지 입력 중"), false);
  assert.equal(shouldShowComposerHints(71, ""), false);
});

test("three connector tabs fit narrow and wide terminal headers", () => {
  const labels = ["Instagram", "KakaoTalk", "Telegram"];
  for (const columns of [24, 28, 32, 40, 50, 80]) {
    const layout = getConversationLayout(columns, labels);
    const renderedWidth = layout.compactTabs ? 15 : 38;
    assert.equal(layout.tabsWidth, renderedWidth);
    assert.ok(layout.pathWidth + renderedWidth <= layout.contentWidth);
  }
});

test("connector panel plans only the lines that fit its height", () => {
  const full = planConnectorPanel(3, 20);
  assert.deepEqual(full, { visible: 3, detail: true, help: true, source: true, storage: true, spacers: true });
  // 1 title + 3 status + 3 detail + 1 help = 8 rows
  assert.deepEqual(planConnectorPanel(3, 8), { visible: 3, detail: true, help: true, source: false, storage: false, spacers: false });
  assert.deepEqual(planConnectorPanel(3, 5), { visible: 3, detail: false, help: true, source: false, storage: false, spacers: false });
  assert.equal(planConnectorPanel(3, 3).visible, 2);
  for (let rows = 1; rows <= 20; rows += 1) {
    const plan = planConnectorPanel(3, rows);
    const used = 1 + plan.visible * (1 + Number(plan.detail) + Number(plan.source) + Number(plan.spacers))
      + Number(plan.help) + Number(plan.storage);
    assert.ok(used <= Math.max(1, rows), `${rows} rows: ${used}`);
  }
});
