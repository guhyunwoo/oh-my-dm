export type AppLanguage = "ko" | "en";
export type LanguagePreference = "auto" | AppLanguage;

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  id: LanguagePreference;
  label: string;
  detail: string;
}> = [
  { id: "auto", label: "Auto", detail: "Use the terminal locale" },
  { id: "ko", label: "한국어", detail: "Korean" },
  { id: "en", label: "English", detail: "English" },
];

export function isLanguagePreference(value: string | undefined): value is LanguagePreference {
  return value === "auto" || value === "ko" || value === "en";
}

export function resolveLanguage(
  preference: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AppLanguage {
  if (preference === "ko" || preference === "en") return preference;
  const locale = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return /^ko(?:[_-]|$)/i.test(locale) ? "ko" : "en";
}

const COPY = {
  ko: {
    selectConversation: "대화를 선택하세요",
    starPrompt: "⭐ 스타 한 번씩만 눌러주시면 개발자에게 큰 도움이 됩니다.",
    updateAvailable: "✔ Update available",
    updateInstalled: "✔ Update installed · Restart to update",
    openingConversation: (title: string) => `${title} 대화를 여는 중…`,
    loadingOlder: "이전 메시지를 불러오는 중…",
    loadedOlder: (count: number) => `이전 메시지 ${count}개를 불러왔습니다.`,
    noOlder: "더 이전 메시지가 없습니다.",
    loadingMoreConversations: "대화방을 더 불러오는 중…",
    loadedMoreConversations: (count: number) => `대화방 ${count}개를 더 불러왔습니다.`,
    noMoreConversations: "더 불러올 대화방이 없습니다.",
    paletteClosed: "명령 팔레트를 닫았습니다.",
    backToChat: "채팅으로 돌아왔습니다.",
    chooseConversationFirst: "먼저 대화를 선택하세요.",
    historyNotice: "과거 대화 내역입니다.",
    slashMessageHelp: "//문자 = /로 시작하는 메시지",
    openUsage: "사용법: /open <대화방 이름>",
    noConversationMatch: (query: string) => `“${query}”에 맞는 대화방이 없습니다.`,
    candidates: (items: string) => `후보: ${items}`,
    conversationsNotice: "대화방 목록입니다. ↑↓로 선택하고 Enter로 여세요.",
    unreadNotice: "안 읽은 대화만 표시합니다.",
    allNotice: "모든 대화를 표시합니다.",
    modelNotFound: (name: string) => `모델을 찾을 수 없습니다: ${name}`,
    themeNotFound: (name: string) => `테마를 찾을 수 없습니다: ${name}`,
    refreshing: "connector 화면을 다시 읽는 중…",
    refreshed: "새로고침했습니다.",
    unknownCommand: (name: string) => `알 수 없는 명령입니다: /${name}. /help로 명령을 확인하세요.`,
    noMessages: "표시할 메시지가 없습니다.",
    historyKeys: "↑/PageUp: 이전 · ↓/PageDown: 최근 · Esc: 돌아가기",
    noUnread: "안 읽은 대화가 없습니다.",
    waitingConversations: "대화 목록을 기다리는 중…",
    instagramLoginRequired: "Instagram 로그인이 필요합니다. `oh-my-dm login instagram`을 실행하세요.",
    manageConnectors: "Connector 관리",
    storage: "세션 전용 · 메시지는 저장하지 않음",
    refreshConnectorsHelp: "※ /refresh로 connector 상태를 다시 확인할 수 있습니다.",
    chooseModel: "모델 선택",
    chooseEffort: "추론 강도 선택",
    chooseTheme: "테마 선택",
    chooseLanguage: "언어 선택",
    navigateApplyCancel: "↑/↓ 이동 · Enter 적용 · Esc 취소",
    navigateApplyBack: "↑/↓ 이동 · Enter 적용 · Esc 모델 목록",
    active: "사용 중",
    commands: "명령",
    noMatchingCommands: "일치하는 명령이 없습니다.",
    placeholder: "메시지를 입력하세요...",
    open: "열기",
    send: "전송",
    back: "뒤로",
    exit: "종료",
    languageChanged: (label: string) => `language = "${label}"`,
    languageUsage: "사용법: /language [auto|ko|en]",
  },
  en: {
    selectConversation: "Select a conversation",
    starPrompt: "⭐ A GitHub star is a huge help to the developer.",
    updateAvailable: "✔ Update available",
    updateInstalled: "✔ Update installed · Restart to update",
    openingConversation: (title: string) => `Opening ${title}…`,
    loadingOlder: "Loading older messages…",
    loadedOlder: (count: number) => `Loaded ${count} older message${count === 1 ? "" : "s"}.`,
    noOlder: "No older messages.",
    loadingMoreConversations: "Loading more conversations…",
    loadedMoreConversations: (count: number) => `Loaded ${count} more conversation${count === 1 ? "" : "s"}.`,
    noMoreConversations: "No more conversations.",
    paletteClosed: "Command palette closed.",
    backToChat: "Back to chat.",
    chooseConversationFirst: "Select a conversation first.",
    historyNotice: "Viewing message history.",
    slashMessageHelp: "//text = send a message beginning with /",
    openUsage: "Usage: /open <conversation name>",
    noConversationMatch: (query: string) => `No conversation matches “${query}”.`,
    candidates: (items: string) => `Matches: ${items}`,
    conversationsNotice: "Choose a conversation with ↑↓ and press Enter to open it.",
    unreadNotice: "Showing unread conversations.",
    allNotice: "Showing all conversations.",
    modelNotFound: (name: string) => `Model not found: ${name}`,
    themeNotFound: (name: string) => `Theme not found: ${name}`,
    refreshing: "Refreshing connector views…",
    refreshed: "Refreshed.",
    unknownCommand: (name: string) => `Unknown command: /${name}. Run /help to see commands.`,
    noMessages: "No messages to display.",
    historyKeys: "↑/PageUp: older · ↓/PageDown: latest · Esc: back",
    noUnread: "No unread conversations.",
    waitingConversations: "Waiting for conversations…",
    instagramLoginRequired: "Instagram login required. Run `oh-my-dm login instagram`.",
    manageConnectors: "Manage connectors",
    storage: "session only · messages are not persisted",
    refreshConnectorsHelp: "※ Run /refresh to check connector status again.",
    chooseModel: "Choose a model",
    chooseEffort: "Choose reasoning effort",
    chooseTheme: "Choose a theme",
    chooseLanguage: "Choose a language",
    navigateApplyCancel: "↑/↓ to navigate · Enter to apply · Esc to cancel",
    navigateApplyBack: "↑/↓ to navigate · Enter to apply · Esc to models",
    active: "active",
    commands: "commands",
    noMatchingCommands: "No matching commands.",
    placeholder: "Type your message...",
    open: "Open",
    send: "Send",
    back: "Back",
    exit: "Exit",
    languageChanged: (label: string) => `language = "${label}"`,
    languageUsage: "Usage: /language [auto|ko|en]",
  },
} as const;

export function getCopy(language: AppLanguage) {
  return COPY[language];
}
