import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateToWidth(value: string, maxWidth: number): string {
  const width = Math.max(0, maxWidth);
  if (stringWidth(value) <= width) return value;
  if (width === 0) return "";
  if (width === 1) return "…";

  let result = "";
  for (const { segment } of segmenter.segment(value)) {
    if (stringWidth(result + segment) > width - 1) break;
    result += segment;
  }
  return `${result}…`;
}

export function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return truncated + " ".repeat(Math.max(0, width - stringWidth(truncated)));
}

export function shouldShowComposerHints(terminalColumns: number, input: string): boolean {
  return terminalColumns >= 72 && input.length === 0;
}

export interface ConversationLayout {
  contentWidth: number;
  pathWidth: number;
  tabsWidth: number;
  compactTabs: boolean;
  showPreview: boolean;
  titleWidth: number;
  previewWidth: number;
}

export function getConversationLayout(terminalColumns: number): ConversationLayout {
  const contentWidth = Math.max(1, terminalColumns - 6);
  const showPreview = terminalColumns >= 70;
  const compactTabs = terminalColumns < 32;
  const tabsWidth = Math.min(contentWidth, compactTabs ? 9 : 25);
  const pathWidth = Math.max(0, contentWidth - tabsWidth);
  const titleWidth = showPreview
    ? Math.max(8, Math.min(32, Math.floor(contentWidth * 0.38)))
    : Math.max(1, contentWidth - 5);
  const previewWidth = showPreview
    ? Math.max(1, contentWidth - 5 - titleWidth)
    : 0;

  return {
    contentWidth,
    pathWidth,
    tabsWidth,
    compactTabs,
    showPreview,
    titleWidth,
    previewWidth,
  };
}

export interface ConnectorPanelPlan {
  // Connectors that get a status line, in order.
  visible: number;
  detail: boolean;
  help: boolean;
  source: boolean;
  storage: boolean;
  spacers: boolean;
}

// The /connectors panel has a fixed height. When its lines do not fit, Yoga
// collapses rows to height 0 and Ink draws them on top of each other, so plan
// exactly the lines that fit: status lines first, then the most useful extras.
export function planConnectorPanel(connectorCount: number, rows: number): ConnectorPanelPlan {
  const budget = Math.max(1, rows);
  const visible = Math.max(0, Math.min(connectorCount, budget - 1));
  const plan: ConnectorPanelPlan = {
    visible,
    detail: false,
    help: false,
    source: false,
    storage: false,
    spacers: false,
  };
  let used = 1 + visible;
  const extras: Array<[keyof Omit<ConnectorPanelPlan, "visible">, number]> = [
    ["detail", visible],
    ["help", 1],
    ["source", visible],
    ["storage", 1],
    ["spacers", visible],
  ];
  for (const [key, cost] of extras) {
    if (visible < connectorCount || used + cost > budget) continue;
    plan[key] = true;
    used += cost;
  }
  return plan;
}
