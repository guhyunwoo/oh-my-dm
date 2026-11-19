export interface UiTheme {
  id: string;
  label: string;
  source: string;
  accent: string;
  border: string;
  userBackground: string;
  userForeground: string;
  path: string;
  command: string;
  prompt: string;
  success: string;
  warning: string;
  danger: string;
  muted: string;
}

export const CONNECTOR_COLORS = {
  instagram: "#E1306C",
  kakaotalk: "#FEE500",
  telegram: "#2AABEE",
} as const;

export const UI_THEMES: UiTheme[] = [
  {
    id: "claude",
    label: "Claude",
    source: "Claude Code · warm coral",
    accent: "#D97757",
    border: "#A66D5A",
    userBackground: "#3A3330",
    userForeground: "#F3EFEC",
    path: "#E5A68F",
    command: "#E5A68F",
    prompt: "#D97757",
    success: "#7DA27A",
    warning: "#D6A85F",
    danger: "#D65C5C",
    muted: "#8B817C",
  },
  {
    id: "ouroboros",
    label: "Ouroboros",
    source: "GJC dark · teal + lime",
    accent: "#AFD75F",
    border: "#5FAFAF",
    userBackground: "#303838",
    userForeground: "#F0F4F2",
    path: "#5FAFAF",
    command: "#FFD787",
    prompt: "#AFD75F",
    success: "#87AF87",
    warning: "#FFD75F",
    danger: "#D75F5F",
    muted: "#6C6C6C",
  },
  {
    id: "blue-crab",
    label: "Blue Crab",
    source: "GJC light · ocean blue",
    accent: "#5FAFD7",
    border: "#5F87D7",
    userBackground: "#DCE8EF",
    userForeground: "#1F2A33",
    path: "#87D7FF",
    command: "#87D7FF",
    prompt: "#5FAFD7",
    success: "#5FAF87",
    warning: "#D7AF5F",
    danger: "#D75F5F",
    muted: "#808A93",
  },
];

export const DEFAULT_THEME_ID = "claude";

export function findTheme(value: string): UiTheme | undefined {
  const query = value.trim().toLowerCase();
  return UI_THEMES.find(
    (theme) => theme.id === query || theme.label.toLowerCase() === query,
  );
}

export function getTheme(value: string): UiTheme {
  return findTheme(value) ?? UI_THEMES[0]!;
}
