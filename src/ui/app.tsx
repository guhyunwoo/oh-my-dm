import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import type { ChatConnector, ChatSnapshot, Conversation } from "../domain.js";
import { formatMessagePreview, formatMessageText } from "../message-content.js";
import { APP_VERSION } from "../version.js";
import { getMessageWindow, getOlderMessageOffset } from "./message-window.js";
import {
  filterSlashCommands,
  findSlashCommand,
  getSelectionWindow,
  getSlashCommands,
  parseSubmission,
  type SlashCommand,
  wrapSelectionIndex,
} from "./slash-commands.js";
import {
  CONNECTOR_COLORS,
  DEFAULT_THEME_ID,
  findTheme,
  getTheme,
  UI_THEMES,
  type UiTheme,
} from "./theme.js";
import {
  DEFAULT_MODEL_ID,
  DISPLAY_MODELS,
  effortFromModelValue,
  findDisplayModel,
  formatDisplayModel,
  getDisplayModel,
  type DisplayModel,
  type ModelEffort,
} from "./model.js";
import {
  getConversationLayout,
  padToWidth,
  shouldShowComposerHints,
  truncateToWidth,
} from "./text-layout.js";
import { formatUserMessageLines } from "./user-message.js";
import { ImeTextInput } from "./ime-text-input.js";
import {
  getCopy,
  isLanguagePreference,
  LANGUAGE_OPTIONS,
  resolveLanguage,
  type LanguagePreference,
} from "./i18n.js";

interface AppProps {
  connector: ChatConnector;
  initialThemeId?: string;
  initialModelId?: string;
  initialModelEffort?: string;
  initialLanguage?: LanguagePreference;
  availableUpdateVersion?: string;
  onAutoUpdate?: () => Promise<void>;
  onThemeChange?: (themeId: string) => void | Promise<void>;
  onModelChange?: (modelId: string, effort?: ModelEffort) => void | Promise<void>;
  onLanguageChange?: (language: LanguagePreference) => void | Promise<void>;
  onUpdate?: () => void;
}

type ConversationFilter = "all" | "unread";
type ConversationProvider = "instagram" | "kakaotalk";
type ViewMode = "chat" | "history" | "conversations" | "connectors" | "model" | "effort" | "theme" | "language";
type TranscriptItem =
  | { id: string; kind: "signature"; full: boolean }
  | { id: string; kind: "message"; message: ChatSnapshot["messages"][number] };

const PROJECT_URL = "https://github.com/stacking-money-forever/oh-my-dm";

export function App({
  connector,
  initialThemeId,
  initialModelId,
  initialModelEffort,
  initialLanguage = "auto",
  availableUpdateVersion,
  onAutoUpdate,
  onThemeChange,
  onModelChange,
  onLanguageChange,
  onUpdate,
}: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdout, write } = useStdout();
  const terminalSize = useTerminalSize(stdout);
  const [snapshot, setSnapshot] = useState(connector.getSnapshot());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
  const [conversationProvider, setConversationProvider] = useState<ConversationProvider>("instagram");
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const [input, setInput] = useState("");
  const [inputEpoch, setInputEpoch] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [updateInstalled, setUpdateInstalled] = useState(false);
  const [messagesHidden, setMessagesHidden] = useState(false);
  const [workspaceCleared, setWorkspaceCleared] = useState(false);
  const [messageOffset, setMessageOffset] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [themeId, setThemeId] = useState(() => getTheme(initialThemeId ?? DEFAULT_THEME_ID).id);
  const [themeIndex, setThemeIndex] = useState(0);
  const [modelId, setModelId] = useState(() => getDisplayModel(initialModelId ?? DEFAULT_MODEL_ID).id);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelEffort, setModelEffort] = useState<ModelEffort | undefined>(() => {
    const initialModel = getDisplayModel(initialModelId ?? DEFAULT_MODEL_ID);
    const requestedEffort = effortFromModelValue(initialModelEffort ?? initialModelId);
    return requestedEffort && initialModel.efforts?.includes(requestedEffort)
      ? requestedEffort
      : initialModel.defaultEffort;
  });
  const [effortModelId, setEffortModelId] = useState(() => getDisplayModel(initialModelId ?? DEFAULT_MODEL_ID).id);
  const [effortIndex, setEffortIndex] = useState(0);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(initialLanguage);
  const [languageIndex, setLanguageIndex] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([
    { id: "signature", kind: "signature", full: terminalSize.columns >= 48 },
  ]);
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  const [conversationOpenEpoch, setConversationOpenEpoch] = useState(0);
  const transcriptConversation = useRef<string | undefined>(undefined);
  const emittedMessageIds = useRef(new Set<string>());
  const olderLoadInProgress = useRef(false);
  const conversationLoadInProgress = useRef(false);
  const historyAlternateScreen = useRef(false);
  const commandAlternateScreen = useRef(false);
  const previousTerminalSize = useRef(terminalSize);
  const autoUpdateStarted = useRef(false);
  const theme = getTheme(themeId);
  const displayModel = getDisplayModel(modelId);
  const displayModelLabel = formatDisplayModel(displayModel, modelEffort);
  const effortModel = getDisplayModel(effortModelId);
  const language = resolveLanguage(languagePreference);
  const copy = getCopy(language);
  const slashCommands = useMemo(() => getSlashCommands(language), [language]);

  const commandMode = input.startsWith("/") && !input.startsWith("//");
  const commandMatches = useMemo(() => filterSlashCommands(input, language), [input, language]);
  const commandWindowSize = Math.max(
    3,
    Math.min(8, Math.floor((terminalSize.rows - 14) / 2)),
  );
  const showSignature = terminalSize.columns >= 48;
  const signatureContentWidth = Math.max(1, terminalSize.columns - 2);
  const signatureCtaRows = showSignature
    ? wrapTerminalLines(copy.starPrompt, signatureContentWidth).length +
      wrapTerminalLines(PROJECT_URL, signatureContentWidth).length
    : 1;
  const updateNotice = availableUpdateVersion
    ? updateInstalled ? copy.updateInstalled : copy.updateAvailable
    : undefined;
  const signatureRenderedRows = (showSignature ? 4 : 2) + 1 + signatureCtaRows;
  const signatureExtraRows = signatureRenderedRows - 1;
  const pathFooterVisible = viewMode === "chat" || viewMode === "history";
  const pathFooterReservedRows = pathFooterVisible ? 1 : 0;
  const staticHeaderRows = viewMode === "history" ? 0 : signatureExtraRows;
  // The update notice occupies the composer's normal one-row top margin, so it
  // must not reserve another terminal row or the footer leaves a blank line.
  const baseChromeRows = viewMode === "history" ? 5 : 6;
  const commandChromeRows = viewMode === "history" ? 8 : 9;
  const mainHeight = Math.max(
    6,
    terminalSize.rows -
      (commandMode
        ? commandWindowSize + commandChromeRows + pathFooterReservedRows
        : baseChromeRows + pathFooterReservedRows) -
      staticHeaderRows,
  );
  const visibleMessageCount = Math.max(1, mainHeight - 4);
  const messageContentWidth = Math.max(1, terminalSize.columns - 2);
  const conversationLayout = getConversationLayout(terminalSize.columns);
  const conversationContentWidth = conversationLayout.contentWidth;
  const transcriptRows = useMemo(
    () =>
      transcript.reduce((rows, item) => {
        if (item.kind === "signature") {
          const ctaRows = item.full
            ? wrapTerminalLines(copy.starPrompt, signatureContentWidth).length +
              wrapTerminalLines(PROJECT_URL, signatureContentWidth).length
            : 1;
          return rows + (item.full ? 4 : 2) + 1 + ctaRows;
        }
        const messageText = formatMessageText(item.message, language).replaceAll("\n", " ");
        const messageRows =
          item.message.sender === "나"
            ? formatUserMessageLines(messageText, messageContentWidth).length
            : Math.max(
                1,
                Math.ceil(
                  stringWidth(`${item.message.sender}: ${messageText}`) / messageContentWidth,
                ),
              );
        return rows + messageRows + 1;
      }, 0),
    [copy.starPrompt, language, messageContentWidth, signatureContentWidth, transcript],
  );
  const messageWindow = useMemo(
    () =>
      getMessageWindow(snapshot.messages, visibleMessageCount, messageOffset, (message) =>
        message.sender === "나"
          ? formatUserMessageLines(
              formatMessageText(message, language),
              messageContentWidth,
            ).length
          : wrapTerminalLines(
              `${message.sender}: ${formatMessageText(message, language).replaceAll("\n", " ")}`,
              conversationContentWidth,
            ).length,
      ),
    [
      conversationContentWidth,
      language,
      messageContentWidth,
      messageOffset,
      snapshot.messages,
      visibleMessageCount,
    ],
  );
  const commandWindow = useMemo(
    () => getSelectionWindow(commandMatches, commandIndex, commandWindowSize),
    [commandIndex, commandMatches, commandWindowSize],
  );
  const conversations = useMemo(
    () =>
      snapshot.conversations.filter((conversation) => {
        const provider = conversation.provider ?? "instagram";
        return (
          provider === conversationProvider &&
          (conversationFilter === "all" || conversation.unread)
        );
      }),
    [conversationFilter, conversationProvider, snapshot.conversations],
  );
  const conversationWindow = useMemo(
    // The fixed-height box spends two rows on its border and one on the
    // provider/path header. Rendering one extra conversation makes Yoga
    // collapse an arbitrary row to height 0, leaving it selectable but hidden.
    () => getSelectionWindow(conversations, selectedIndex, Math.max(1, mainHeight - 3)),
    [conversations, mainHeight, selectedIndex],
  );
  const modelWindow = useMemo(
    () => getSelectionWindow(DISPLAY_MODELS, modelIndex, Math.max(1, mainHeight - 4)),
    [mainHeight, modelIndex],
  );
  const effortWindow = useMemo(
    () =>
      getSelectionWindow(
        effortModel.efforts ?? [],
        effortIndex,
        Math.max(1, mainHeight - 4),
      ),
    [effortIndex, effortModel.efforts, mainHeight],
  );
  const languageWindow = useMemo(
    () => getSelectionWindow([...LANGUAGE_OPTIONS], languageIndex, Math.max(1, mainHeight - 4)),
    [languageIndex, mainHeight],
  );
  const showConversationPreview = conversationLayout.showPreview;
  const showComposerHints = shouldShowComposerHints(terminalSize.columns, input);
  const useCompactConversationTabs = conversationLayout.compactTabs;
  const conversationTabsWidth = conversationLayout.tabsWidth;
  const conversationPathWidth = conversationLayout.pathWidth;
  const conversationTitleWidth = conversationLayout.titleWidth;
  const conversationPreviewWidth = conversationLayout.previewWidth;
  const conversationPathLabel = `~/conversations · ${conversationFilter}`;
  const conversationConnector = snapshot.connectors?.find(
    (item) => item.id === conversationProvider,
  );
  const connectorFailure = conversationConnector?.state === "error" || conversationConnector?.state === "disconnected"
    ? `${conversationConnector.label}: ${conversationConnector.detail ?? conversationConnector.state}`
    : snapshot.state === "error"
      ? snapshot.connectors
        ?.filter((item) => item.state === "error" || item.state === "disconnected")
        .map((item) => `${item.label}: ${item.detail ?? item.state}`)
        .join(" · ")
      : undefined;
  const terminalTooSmall = terminalSize.columns < 24 || terminalSize.rows < 10;

  useEffect(() => {
    const onSnapshot = (next: ChatSnapshot) => {
      // A terminal Static transcript can only append. Older messages belong in the
      // interactive history viewport; committing them here would put old data below new data.
      if (olderLoadInProgress.current) {
        for (const message of next.messages) emittedMessageIds.current.add(message.id);
      }
      setSnapshot(next);
    };
    const onError = (next: Error) => setError(next.message);
    connector.on("snapshot", onSnapshot);
    connector.on("error", onError);
    void connector.start().catch(onError);
    return () => {
      connector.off("snapshot", onSnapshot);
      connector.off("error", onError);
      void connector.stop();
    };
  }, [connector]);

  useEffect(() => {
    if (!availableUpdateVersion || !onAutoUpdate || autoUpdateStarted.current) return;
    autoUpdateStarted.current = true;
    let active = true;
    void onAutoUpdate()
      .then(() => {
        if (active) setUpdateInstalled(true);
      })
      .catch(() => {
        // Keep "Update available" visible so the user can retry with /update.
      });
    return () => {
      active = false;
    };
  }, [availableUpdateVersion, onAutoUpdate]);

  useEffect(() => {
    if (viewMode === "history" || !historyAlternateScreen.current) return;
    // Clear the history frame while it still owns the alternate buffer, then
    // restore the primary buffer and force Ink to repaint the complete chat
    // chrome. A raw buffer switch followed by Ink's normal partial diff leaves
    // unchanged composer/footer rows missing or at the old cursor position.
    void (async () => {
      const suspension = await suspendTerminal();
      stdout.write("\u001B[?1049l");
      historyAlternateScreen.current = false;
      await nextRenderTurn();
      await suspension.resume();
    })().catch((next) => setError(next instanceof Error ? next.message : String(next)));
  }, [stdout, suspendTerminal, viewMode]);

  useEffect(
    () => () => {
      if (historyAlternateScreen.current) stdout.write("\u001B[?1049l");
      if (commandAlternateScreen.current) stdout.write("\u001B[?1049l");
    },
    [stdout],
  );

  useEffect(() => {
    const previous = previousTerminalSize.current;
    if (
      previous.rows === terminalSize.rows &&
      previous.columns === terminalSize.columns
    ) {
      return;
    }
    previousTerminalSize.current = terminalSize;

    // Resize events arrive in bursts. Wait for the terminal to settle, then
    // clear the complete frame before asking Ink for a full redraw. Ink's
    // normal width-aware diff cannot erase characters that belonged to the
    // previous, wider frame, leaving duplicate borders and footers behind.
    const timer = setTimeout(() => {
      void (async () => {
        const suspension = await suspendTerminal();
        const alternateScreen =
          historyAlternateScreen.current || commandAlternateScreen.current;
        stdout.write(alternateScreen ? "\u001B[2J\u001B[H" : "\u001B[2J\u001B[3J\u001B[H");
        if (!alternateScreen) {
          setTranscript((items) =>
            items.map((item) =>
              item.kind === "signature"
                ? { ...item, full: terminalSize.columns >= 48 }
                : item,
            ),
          );
          setTranscriptEpoch((epoch) => epoch + 1);
        }
        await nextRenderTurn();
        await suspension.resume();
      })().catch((next) =>
        setError(next instanceof Error ? next.message : String(next)),
      );
    }, 60);

    return () => clearTimeout(timer);
  }, [stdout, suspendTerminal, terminalSize.columns, terminalSize.rows]);

  useEffect(() => {
    setCommandIndex(0);
  }, [input]);

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, conversations.length - 1)));
  }, [conversations.length]);

  useEffect(() => {
    setMessageOffset((offset) => Math.min(offset, messageWindow.maxOffset));
  }, [messageWindow.maxOffset]);

  useEffect(() => {
    setMessageOffset(0);
  }, [snapshot.activeConversationId]);

  const showError = (next: unknown): void => {
    setError(next instanceof Error ? next.message : String(next));
  };

  const applyTheme = (selectedTheme: UiTheme): void => {
    setThemeId(selectedTheme.id);
    setNotice(`theme = "${selectedTheme.id}"`);
    void Promise.resolve(onThemeChange?.(selectedTheme.id)).catch(showError);
  };

  const applyModel = (selectedModel: DisplayModel, effort?: ModelEffort): void => {
    setModelId(selectedModel.id);
    setModelEffort(effort);
    const label = formatDisplayModel(selectedModel, effort);
    setNotice(`model = "${label}"`);
    void Promise.resolve(onModelChange?.(selectedModel.id, effort)).catch(showError);
  };

  const applyLanguage = (preference: LanguagePreference): void => {
    const nextLanguage = resolveLanguage(preference);
    setLanguagePreference(preference);
    setNotice(getCopy(nextLanguage).languageChanged(
      LANGUAGE_OPTIONS.find((item) => item.id === preference)?.label ?? preference,
    ));
    void Promise.resolve(onLanguageChange?.(preference)).catch(showError);
  };

  const enterHistoryScreen = (): void => {
    if (historyAlternateScreen.current) {
      setViewMode("history");
      return;
    }
    void (async () => {
      const suspension = await suspendTerminal();
      stdout.write("\u001B[?1049h\u001B[2J\u001B[H");
      historyAlternateScreen.current = true;
      setViewMode("history");
      await nextRenderTurn();
      await suspension.resume();
    })().catch(showError);
  };

  const leaveHistoryScreenImmediately = (): void => {
    if (!historyAlternateScreen.current) return;
    stdout.write("\u001B[?1049l");
    historyAlternateScreen.current = false;
  };

  const leaveCommandScreenImmediately = (): void => {
    if (!commandAlternateScreen.current) return;
    // Restore the primary buffer before changing React state. If the empty
    // composer renders in the alternate buffer first, Ink caches that frame
    // and later applies only a partial diff to the restored primary buffer.
    // That leaves a stale cursor and erases the prompt or border.
    stdout.write("\u001B[?1049l");
    commandAlternateScreen.current = false;
  };

  const chooseModel = (selectedModel: DisplayModel): void => {
    if (selectedModel.efforts?.length) {
      const selectedEffort =
        selectedModel.id === modelId && modelEffort && selectedModel.efforts.includes(modelEffort)
          ? modelEffort
          : selectedModel.defaultEffort ?? selectedModel.efforts[0]!;
      setEffortModelId(selectedModel.id);
      setEffortIndex(Math.max(0, selectedModel.efforts.indexOf(selectedEffort)));
      setViewMode("effort");
      setNotice(undefined);
      return;
    }
    applyModel(selectedModel);
    setViewMode("chat");
  };

  const openConversation = (conversation: Conversation): void => {
    leaveHistoryScreenImmediately();
    setViewMode("chat");
    setMessageOffset(0);
    setMessagesHidden(true);
    setWorkspaceCleared(false);
    transcriptConversation.current = undefined;
    emittedMessageIds.current.clear();
    setTranscript([
      { id: "signature", kind: "signature", full: terminalSize.columns >= 48 },
    ]);
    setTranscriptEpoch((epoch) => epoch + 1);
    setNotice(copy.openingConversation(conversation.title));
    setError(undefined);
    write("\u001B[2J\u001B[3J\u001B[H");
    void connector
      .openConversation(conversation.id)
      .then(() => {
        transcriptConversation.current = undefined;
        emittedMessageIds.current.clear();
        setWorkspaceCleared(false);
        setMessagesHidden(false);
        setConversationOpenEpoch((epoch) => epoch + 1);
      })
      .catch((error) => {
        setMessagesHidden(false);
        showError(error);
      });
  };

  const loadOlderMessages = (): void => {
    if (loadingOlder || !snapshot.activeConversationId || workspaceCleared) return;
    olderLoadInProgress.current = true;
    setLoadingOlder(true);
    setNotice(copy.loadingOlder);
    void connector
      .loadOlderMessages()
      .then((added) => {
        if (added > 0) {
          // Prepending does not change the old viewport's distance from the bottom.
          // Advance by one item so the user sees the next older message, not the
          // first item of the entire newly loaded batch.
          setMessageOffset((offset) => offset + 1);
          setNotice(copy.loadedOlder(added));
        } else {
          setNotice(copy.noOlder);
        }
      })
      .catch(showError)
      .finally(() => {
        olderLoadInProgress.current = false;
        setLoadingOlder(false);
      });
  };

  const loadMoreConversationRows = (): void => {
    if (conversationLoadInProgress.current) return;
    const previousCount = conversations.length;
    conversationLoadInProgress.current = true;
    setNotice(copy.loadingMoreConversations);
    void connector
      .loadMoreConversations(conversationProvider)
      .then((added) => {
        if (added > 0) {
          setSelectedIndex(previousCount);
          setNotice(copy.loadedMoreConversations(added));
        } else {
          setNotice(copy.noMoreConversations);
        }
      })
      .catch(showError)
      .finally(() => {
        conversationLoadInProgress.current = false;
      });
  };

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      leaveHistoryScreenImmediately();
      exit();
      return;
    }
    if (key.escape) {
      if (commandMode) {
        leaveCommandScreenImmediately();
        setInput("");
        setNotice(copy.paletteClosed);
      } else if (viewMode === "effort") {
        setViewMode("model");
        setNotice(undefined);
      } else if (viewMode === "history") {
        // Instagram rebuilds message ids when its virtualized DOM window
        // changes. None of the messages already visible in history should be
        // appended to the terminal's Static transcript when the primary
        // screen is restored.
        for (const message of snapshot.messages) {
          emittedMessageIds.current.add(message.id);
        }
        setViewMode("chat");
        setNotice(copy.backToChat);
      } else if (viewMode !== "chat") {
        setViewMode("chat");
        setNotice(copy.backToChat);
      } else {
        exit();
      }
      return;
    }
    if (commandMode) {
      if (key.upArrow) {
        setCommandIndex((index) => wrapSelectionIndex(index, -1, commandMatches.length));
      }
      if (key.downArrow) {
        setCommandIndex((index) => wrapSelectionIndex(index, 1, commandMatches.length));
      }
      if (key.tab) {
        const command = commandMatches[commandIndex];
        if (command) {
          setInput(`/${command.name} `);
          setInputEpoch((epoch) => epoch + 1);
        }
      }
      return;
    }
    if (viewMode === "theme" && key.upArrow) {
      setThemeIndex((index) => wrapSelectionIndex(index, -1, UI_THEMES.length));
      return;
    }
    if (viewMode === "theme" && key.downArrow) {
      setThemeIndex((index) => wrapSelectionIndex(index, 1, UI_THEMES.length));
      return;
    }
    if (viewMode === "theme" && key.return && !input) {
      const selectedTheme = UI_THEMES[themeIndex];
      if (selectedTheme) {
        applyTheme(selectedTheme);
        setViewMode("chat");
      }
      return;
    }
    if (viewMode === "language" && key.upArrow) {
      setLanguageIndex((index) => wrapSelectionIndex(index, -1, LANGUAGE_OPTIONS.length));
      return;
    }
    if (viewMode === "language" && key.downArrow) {
      setLanguageIndex((index) => wrapSelectionIndex(index, 1, LANGUAGE_OPTIONS.length));
      return;
    }
    if (viewMode === "language" && key.return && !input) {
      const selectedLanguage = LANGUAGE_OPTIONS[languageIndex];
      if (selectedLanguage) {
        applyLanguage(selectedLanguage.id);
        setViewMode("chat");
      }
      return;
    }
    if (viewMode === "model" && key.upArrow) {
      setModelIndex((index) => wrapSelectionIndex(index, -1, DISPLAY_MODELS.length));
      return;
    }
    if (viewMode === "model" && key.downArrow) {
      setModelIndex((index) => wrapSelectionIndex(index, 1, DISPLAY_MODELS.length));
      return;
    }
    if (viewMode === "model" && key.return && !input) {
      const selectedModel = DISPLAY_MODELS[modelIndex];
      if (selectedModel) chooseModel(selectedModel);
      return;
    }
    if (viewMode === "effort" && key.upArrow) {
      setEffortIndex((index) => wrapSelectionIndex(index, -1, effortModel.efforts?.length ?? 0));
      return;
    }
    if (viewMode === "effort" && key.downArrow) {
      setEffortIndex((index) => wrapSelectionIndex(index, 1, effortModel.efforts?.length ?? 0));
      return;
    }
    if (viewMode === "effort" && key.return && !input) {
      const selectedEffort = effortModel.efforts?.[effortIndex];
      if (selectedEffort) {
        applyModel(effortModel, selectedEffort);
        setViewMode("chat");
      }
      return;
    }
    if (viewMode === "conversations" && key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
    }
    if (
      viewMode === "conversations" &&
      (key.tab || key.leftArrow || key.rightArrow)
    ) {
      setConversationProvider((provider) =>
        provider === "instagram" ? "kakaotalk" : "instagram",
      );
      setSelectedIndex(0);
      return;
    }
    if (viewMode === "conversations" && key.downArrow) {
      const lastIndex = Math.max(0, conversations.length - 1);
      if (selectedIndex >= lastIndex) loadMoreConversationRows();
      else setSelectedIndex((index) => Math.min(lastIndex, index + 1));
      return;
    }
    if (viewMode === "conversations" && key.return && !input) {
      const conversation = conversations[selectedIndex];
      if (conversation) openConversation(conversation);
    }
    if (viewMode === "chat" && !input && (key.upArrow || key.pageUp)) {
      if (!snapshot.activeConversationId || workspaceCleared) {
        setNotice(copy.chooseConversationFirst);
        return;
      }
      enterHistoryScreen();
      const nextOffset = key.pageUp
        ? getOlderMessageOffset(0, messageWindow.maxOffset, messageWindow.items.length, true)
        : 0;
      setMessageOffset(nextOffset);
      setNotice(copy.historyNotice);
      if (key.pageUp && nextOffset === messageWindow.maxOffset) loadOlderMessages();
      return;
    }
    if (viewMode === "history" && (key.upArrow || key.pageUp)) {
      if (messageOffset < messageWindow.maxOffset) {
        const nextOffset = getOlderMessageOffset(
          messageOffset,
          messageWindow.maxOffset,
          messageWindow.items.length,
          key.pageUp,
        );
        setMessageOffset(nextOffset);
        if (nextOffset === messageWindow.maxOffset) loadOlderMessages();
      } else {
        loadOlderMessages();
      }
      return;
    }
    if (viewMode === "history" && (key.downArrow || key.pageDown)) {
      setMessageOffset((offset) => (key.pageDown ? 0 : Math.max(0, offset - 1)));
      return;
    }
  });

  const activeConversation = useMemo(
    () =>
      workspaceCleared
        ? undefined
        : snapshot.conversations.find((item) => item.id === snapshot.activeConversationId),
    [snapshot, workspaceCleared],
  );
  const activeTitle = activeConversation?.title ?? copy.selectConversation;
  const activeProvider = activeConversation?.provider ?? "instagram";
  const activePath =
    !activeConversation
      ? "~/conversations"
      : `~/${activeProvider}/${toPathSegment(activeTitle)}`;
  const footerRows = Math.max(
    1,
    Math.ceil(
      stringWidth(`${displayModelLabel} · ${activePath}`) /
        Math.max(1, terminalSize.columns - 4),
    ),
  );
  const commandPanelRows = commandMode
    ? 3 + Math.max(1, commandWindow.items.length)
    : 0;
  const chatChromeRows =
    4 + footerRows + commandPanelRows + (error ? 1 : 0);
  const chatSpacerHeight = Math.max(
    0,
    terminalSize.rows -
      (commandMode && commandAlternateScreen.current ? 0 : transcriptRows) -
      chatChromeRows,
  );

  const handleInputChange = (nextInput: string): void => {
    const nextCommandMode = nextInput.startsWith("/") && !nextInput.startsWith("//");
    if (!nextCommandMode) leaveCommandScreenImmediately();
    if (nextCommandMode && !commandAlternateScreen.current && viewMode === "chat") {
      const nextMatches = filterSlashCommands(nextInput, language);
      const nextPanelRows = 3 + Math.max(1, Math.min(commandWindowSize, nextMatches.length));
      const nextChromeRows =
        4 + footerRows + nextPanelRows + (error ? 1 : 0);
      if (transcriptRows + nextChromeRows > terminalSize.rows) {
        // Once Static content has filled the viewport, opening an inline palette
        // scrolls the primary buffer. It cannot be pulled back when the palette
        // shrinks, which leaves blank rows below the footer. Use a temporary
        // screen for only that overflowing palette and restore the chat exactly.
        stdout.write("\u001B[?1049h\u001B[2J\u001B[H");
        commandAlternateScreen.current = true;
      }
    }
    setInput(nextInput);
  };

  useEffect(() => {
    if (viewMode === "history" || commandAlternateScreen.current) return;
    const conversationId = snapshot.activeConversationId;
    if (!conversationId || messagesHidden || workspaceCleared) return;
    const additions: TranscriptItem[] = [];
    if (transcriptConversation.current !== conversationId) {
      transcriptConversation.current = conversationId;
      emittedMessageIds.current.clear();
    }
    for (const message of snapshot.messages) {
      if (emittedMessageIds.current.has(message.id)) continue;
      emittedMessageIds.current.add(message.id);
      additions.push({ id: `message:${conversationId}:${message.id}`, kind: "message", message });
    }
    if (additions.length > 0) setTranscript((items) => [...items, ...additions]);
  }, [
    conversationOpenEpoch,
    commandMode,
    messagesHidden,
    snapshot.activeConversationId,
    snapshot.messages,
    viewMode,
    workspaceCleared,
  ]);

  const executeCommand = async (command: SlashCommand, args: string[]): Promise<void> => {
    switch (command.name) {
      case "help":
        setNotice(
          slashCommands.map((item) => item.usage).join(" · ") +
            ` · ${copy.slashMessageHelp}`,
        );
        return;
      case "open": {
        const query = args.join(" ").trim().toLowerCase();
        if (!query) {
          setNotice(copy.openUsage);
          return;
        }
        const matches = snapshot.conversations.filter((conversation) =>
          conversation.title.toLowerCase().includes(query),
        );
        if (matches.length === 1) {
          openConversation(matches[0]!);
        } else if (matches.length === 0) {
          setNotice(copy.noConversationMatch(args.join(" ")));
        } else {
          setNotice(copy.candidates(matches.slice(0, 5).map((item) => item.title).join(", ")));
        }
        return;
      }
      case "conversations":
        await connector.refresh();
        setConversationFilter("all");
        setConversationProvider("instagram");
        setViewMode("conversations");
        setSelectedIndex(0);
        setNotice(copy.conversationsNotice);
        return;
      case "unread":
        await connector.refresh();
        setConversationFilter("unread");
        setViewMode("conversations");
        setSelectedIndex(0);
        setNotice(copy.unreadNotice);
        return;
      case "all":
        await connector.refresh();
        setConversationFilter("all");
        setViewMode("conversations");
        setSelectedIndex(0);
        setNotice(copy.allNotice);
        return;
      case "connectors":
        setViewMode("connectors");
        setNotice(undefined);
        return;
      case "history":
        if (!snapshot.activeConversationId || workspaceCleared) {
          setNotice(copy.chooseConversationFirst);
          return;
        }
        setMessageOffset(0);
        enterHistoryScreen();
        setNotice(copy.historyNotice);
        return;
      case "model": {
        const requested = args.join(" ").trim();
        if (requested) {
          const selectedModel = findDisplayModel(requested);
          if (!selectedModel) {
            setNotice(copy.modelNotFound(requested));
            return;
          }
          const requestedEffort = effortFromModelValue(requested);
          if (requestedEffort && selectedModel.efforts?.includes(requestedEffort)) {
            applyModel(selectedModel, requestedEffort);
            setViewMode("chat");
          } else {
            chooseModel(selectedModel);
          }
          return;
        }
        setModelIndex(Math.max(0, DISPLAY_MODELS.findIndex((item) => item.id === modelId)));
        setViewMode("model");
        setNotice(undefined);
        return;
      }
      case "theme": {
        const requested = args.join(" ").trim();
        if (requested) {
          const selectedTheme = findTheme(requested);
          if (!selectedTheme) {
            setNotice(copy.themeNotFound(requested));
            return;
          }
          applyTheme(selectedTheme);
          return;
        }
        setThemeIndex(Math.max(0, UI_THEMES.findIndex((item) => item.id === themeId)));
        setViewMode("theme");
        setNotice(undefined);
        return;
      }
      case "language": {
        const requested = args[0]?.trim().toLowerCase();
        if (requested) {
          if (!isLanguagePreference(requested)) {
            setNotice(copy.languageUsage);
            return;
          }
          applyLanguage(requested);
          setViewMode("chat");
          return;
        }
        setLanguageIndex(Math.max(0, LANGUAGE_OPTIONS.findIndex((item) => item.id === languagePreference)));
        setViewMode("language");
        setNotice(undefined);
        return;
      }
      case "refresh":
        setNotice(copy.refreshing);
        await connector.refresh();
        setNotice(copy.refreshed);
        return;
      case "update":
        leaveHistoryScreenImmediately();
        onUpdate?.();
        exit();
        return;
      case "clear":
        // Static output has already been committed to terminal scrollback. Reset both
        // Ink's static buffer and the terminal's visible screen/scrollback buffer.
        emittedMessageIds.current.clear();
        transcriptConversation.current = undefined;
        leaveHistoryScreenImmediately();
        setTranscript([]);
        setTranscriptEpoch((epoch) => epoch + 1);
        setMessagesHidden(false);
        setWorkspaceCleared(true);
        setMessageOffset(0);
        setViewMode("chat");
        setNotice(undefined);
        write("\u001B[2J\u001B[3J\u001B[H");
        return;
      case "exit":
        leaveHistoryScreenImmediately();
        exit();
        return;
    }
  };

  const submit = (value: string): void => {
    const parsed = parseSubmission(value);
    if (parsed.kind === "empty") return;

    if (parsed.kind === "command") {
      const command = findSlashCommand(parsed.name) ?? commandMatches[commandIndex];
      if (command?.name === "open" && parsed.args.length === 0) {
        // /open requires a conversation name. Selecting it from the palette
        // should continue argument entry instead of behaving like
        // /conversations or clearing the composer with no visible result.
        setInput("/open ");
        setInputEpoch((epoch) => epoch + 1);
        setError(undefined);
        setNotice(copy.openUsage);
        return;
      }
      leaveCommandScreenImmediately();
      setInput("");
      setError(undefined);
      if (!command) {
        setNotice(copy.unknownCommand(parsed.name));
        return;
      }
      void executeCommand(command, parsed.args).catch(showError);
      return;
    }

    leaveCommandScreenImmediately();
    setInput("");
    setError(undefined);

    if (!snapshot.activeConversationId || workspaceCleared) {
      setNotice(copy.chooseConversationFirst);
      return;
    }
    setMessagesHidden(false);
    setMessageOffset(0);
    setViewMode("chat");
    void connector.sendMessage(parsed.text).catch(showError);
  };

  if (terminalTooSmall) {
    return (
      <Text color={theme.muted}>
        {truncateToWidth("oh-my-dm · resize ≥24×10", terminalSize.columns)}
      </Text>
    );
  }

  return (
    <>
      <Static key={transcriptEpoch} items={transcript}>
        {(item) => {
          if (item.kind === "signature") {
            return item.full ? (
              <Box key={item.id} flexDirection="column" marginTop={1} paddingX={1}>
                <Text>
                  <Text color={theme.accent}>{" /\\_/\\  "}</Text>
                  <Text bold>  oh-my-dm</Text>
                  <Text color={theme.muted}> v{APP_VERSION}</Text>
                </Text>
                <Text>
                  <Text color={theme.accent}>{"( o.o ) "}</Text>
                  <Text color={theme.muted}>  terminal workspace</Text>
                </Text>
                <Text>
                  <Text color={theme.accent}>{" > ^ <  "}</Text>
                  <Text color={theme.muted}>  local · ephemeral</Text>
                </Text>
                <Text> </Text>
                <Text color={theme.muted} wrap="wrap">{copy.starPrompt}</Text>
                <Text color={theme.path} wrap="wrap">{PROJECT_URL}</Text>
              </Box>
            ) : (
              <Box key={item.id} flexDirection="column" marginTop={1} paddingX={1}>
                <Text>
                  <Text bold color={theme.accent}>oh-my-dm</Text>
                  <Text color={theme.muted}> v{APP_VERSION}</Text>
                </Text>
                <Text> </Text>
                <Text color={theme.muted}>
                  {truncateToWidth(`⭐ ${PROJECT_URL.replace("https://", "")}`, signatureContentWidth)}
                </Text>
              </Box>
            );
          }
          const messageText = formatMessageText(item.message, language).replaceAll("\n", " ");
          return item.message.sender === "나" ? (
            <Box key={item.id} flexDirection="column" marginTop={1} paddingX={1}>
              {formatUserMessageLines(messageText, messageContentWidth).map((line, index) => (
                <Text
                  key={`${item.id}:${index}`}
                  color={theme.userForeground}
                  backgroundColor={theme.userBackground}
                >
                  {line}
                </Text>
              ))}
            </Box>
          ) : (
            <Box key={item.id} marginTop={1} paddingX={1}>
              <Text wrap="wrap">
                <Text>{item.message.sender}: </Text>
                {messageText}
              </Text>
            </Box>
          );
        }}
      </Static>

      <Box flexDirection="column" paddingX={1}>

      <Box
        marginTop={viewMode === "chat" ? 0 : 1}
        height={viewMode === "chat" ? chatSpacerHeight : mainHeight}
      >
        {viewMode === "history" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={1}>
            <Text>
              <Text bold color={theme.path}>{activePath}</Text>
              <Text color={theme.muted}> · history</Text>
            </Text>
            {messageWindow.items.length === 0 ? (
              <Text color={theme.muted}>{copy.noMessages}</Text>
            ) : (
              messageWindow.items.map((message) => {
                const messageText = formatMessageText(message, language).replaceAll("\n", " ");
                if (message.sender === "나") {
                  const lines = clipTerminalLines(
                    formatUserMessageLines(messageText, conversationContentWidth),
                    visibleMessageCount,
                    conversationContentWidth,
                    true,
                  );
                  return (
                    <Box key={message.id} flexDirection="column">
                      {lines.map((line, index) => (
                        <Text
                          key={`${message.id}:${index}`}
                          color={theme.userForeground}
                          backgroundColor={theme.userBackground}
                        >
                          {line}
                        </Text>
                      ))}
                    </Box>
                  );
                }
                const lines = clipTerminalLines(
                  wrapTerminalLines(`${message.sender}: ${messageText}`, conversationContentWidth),
                  visibleMessageCount,
                  conversationContentWidth,
                );
                return (
                  <Box key={message.id} flexDirection="column">
                    {lines.map((line, index) => (
                      <Text key={`${message.id}:${index}`}>{line}</Text>
                    ))}
                  </Box>
                );
              })
            )}
            <Box>
              <Text color={theme.muted}>
                {loadingOlder
                  ? copy.loadingOlder
                  : copy.historyKeys}
              </Text>
            </Box>
          </Box>
        ) : viewMode === "conversations" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={1}>
            <Box>
              {conversationPathWidth > 0 && (
                <Box width={conversationPathWidth} flexShrink={0}>
                  <Text bold color={theme.path} wrap="truncate-end">
                    {truncateToWidth(conversationPathLabel, conversationPathWidth)}
                  </Text>
                </Box>
              )}
              <Box width={conversationTabsWidth} flexShrink={0} justifyContent="flex-end">
                <Text
                  bold={conversationProvider === "instagram"}
                  color={conversationProvider === "instagram" ? "#000000" : theme.muted}
                  backgroundColor={
                    conversationProvider === "instagram"
                      ? CONNECTOR_COLORS.instagram
                      : undefined
                  }
                >
                  {useCompactConversationTabs ? " I " : " Instagram "}
                </Text>
                <Text color={theme.muted}> │ </Text>
                <Text
                  bold={conversationProvider === "kakaotalk"}
                  color={conversationProvider === "kakaotalk" ? "#000000" : theme.muted}
                  backgroundColor={
                    conversationProvider === "kakaotalk"
                      ? CONNECTOR_COLORS.kakaotalk
                      : undefined
                  }
                >
                  {useCompactConversationTabs ? " K " : " KakaoTalk "}
                </Text>
              </Box>
            </Box>
            {conversations.length === 0 ? (
              <Text color={theme.muted}>
                {conversationProvider === "instagram" && conversationConnector?.state === "login-required"
                  ? copy.instagramLoginRequired
                  : connectorFailure
                    ? `error: ${connectorFailure}`
                  : conversationFilter === "unread"
                  ? copy.noUnread
                  : copy.waitingConversations}
              </Text>
            ) : (
              conversationWindow.items.map((conversation, index) => {
                const absoluteIndex = conversationWindow.start + index;
                const selected = absoluteIndex === selectedIndex;
                const selectionMark = selected ? "> " : "  ";
                const unreadMark = conversation.unread ? " ●" : "  ";
                const isKakaoTalk = conversation.provider === "kakaotalk";
                const providerMark = isKakaoTalk ? "K" : "I";
                const providerColor = isKakaoTalk
                  ? CONNECTOR_COLORS.kakaotalk
                  : CONNECTOR_COLORS.instagram;
                const titleCellWidth = Math.max(1, conversationTitleWidth - 1);
                const title = truncateToWidth(
                  conversation.title,
                  Math.max(0, titleCellWidth - 1),
                );
                const preview = truncateToWidth(
                  formatMessagePreview(
                    conversation.preview?.replaceAll("\n", " ") ?? "",
                    language,
                  ),
                  conversationPreviewWidth,
                );
                return (
                  <Box key={conversation.id} width={conversationContentWidth}>
                    <Box width={2} flexShrink={0}>
                      <Text color={selected ? theme.accent : undefined}>
                        {selectionMark}
                      </Text>
                    </Box>
                    <Box width={1} flexShrink={0}>
                      <Text color={providerColor}>{providerMark}</Text>
                    </Box>
                    <Box width={2} flexShrink={0}>
                      <Text color={conversation.unread ? theme.accent : undefined}>
                        {unreadMark}
                      </Text>
                    </Box>
                    <Box width={titleCellWidth} flexShrink={0}>
                      <Text>{` ${title}`}</Text>
                    </Box>
                    {showConversationPreview && (
                      <Box width={conversationPreviewWidth + 1} flexShrink={0}>
                        <Text color={theme.muted}>{` ${preview}`}</Text>
                      </Box>
                    )}
                  </Box>
                );
              })
            )}
          </Box>
        ) : viewMode === "connectors" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={2}>
            <Text bold>{copy.manageConnectors}</Text>
            <Text color={theme.muted}>{snapshot.connectors?.length ?? 1} connectors</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>{copy.chatConnectors}</Text>
              {(snapshot.connectors ?? [
                { id: "instagram", label: "Instagram", state: snapshot.state, detail: snapshot.detail },
              ]).map((connectorStatus, index) => (
                <Box key={connectorStatus.id} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                  <Text>
                    <Text color={theme.accent}>❯ </Text>
                    <Text bold>{connectorStatus.id}</Text>
                    <Text> · </Text>
                    <Text color={serviceStateColor(connectorStatus.state, theme)}>
                      {serviceStateIcon(connectorStatus.state)} {connectorStatus.state}
                    </Text>
                  </Text>
                  <Box marginLeft={3} flexDirection="column">
                    <Text color={theme.muted}>
                      source      {connectorStatus.id === "instagram" ? "instagram.com/direct · live DOM + WebSocket" : "KakaoTalk for macOS · persistent native bridge"}
                    </Text>
                    <Text color={theme.muted}>storage     {copy.storage}</Text>
                    {connectorStatus.detail && <Text color={theme.muted}>detail      {connectorStatus.detail}</Text>}
                  </Box>
                </Box>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>{copy.refreshConnectorsHelp}</Text>
            </Box>
          </Box>
        ) : viewMode === "model" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={2}>
            <Text bold>
              {copy.chooseModel} <Text color={theme.muted}>· {DISPLAY_MODELS.length} models</Text>
            </Text>
            <Box flexDirection="column">
              {modelWindow.items.map((item, index) => {
                const absoluteIndex = modelWindow.start + index;
                const selected = absoluteIndex === modelIndex;
                return (
                  <Text key={item.id} color={selected ? theme.accent : undefined}>
                    {selected ? "❯" : " "} {item.label.padEnd(24)} · {item.source}
                    {item.id === modelId ? ` · ${copy.active}` : ""}
                  </Text>
                );
              })}
            </Box>
            <Box>
              <Text color={theme.muted}>{copy.navigateApplyCancel}</Text>
            </Box>
          </Box>
        ) : viewMode === "effort" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={2}>
            <Text bold>
              {copy.chooseEffort} <Text color={theme.muted}>· {effortModel.label}</Text>
            </Text>
            <Box flexDirection="column">
              {effortWindow.items.map((effort, index) => {
                const absoluteIndex = effortWindow.start + index;
                return (
                  <Text key={effort} color={absoluteIndex === effortIndex ? theme.accent : undefined}>
                    {absoluteIndex === effortIndex ? "❯" : " "} {effort}
                    {effortModel.id === modelId && effort === modelEffort ? ` · ${copy.active}` : ""}
                  </Text>
                );
              })}
            </Box>
            <Box>
              <Text color={theme.muted}>{copy.navigateApplyBack}</Text>
            </Box>
          </Box>
        ) : viewMode === "theme" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={2}>
            <Text bold>{copy.chooseTheme}</Text>
            <Text color={theme.muted}>{UI_THEMES.length} themes</Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>UI themes</Text>
              {UI_THEMES.map((item, index) => (
                <Text key={item.id} color={index === themeIndex ? item.accent : undefined}>
                  {index === themeIndex ? "❯" : " "} {item.id.padEnd(12)} · {item.source}
                  {item.id === themeId ? ` · ${copy.active}` : ""}
                </Text>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>{copy.navigateApplyCancel}</Text>
            </Box>
          </Box>
        ) : viewMode === "language" ? (
          <Box flexGrow={1} flexDirection="column" borderStyle="single" paddingX={2}>
            <Text bold>{copy.chooseLanguage}</Text>
            <Box marginTop={1} flexDirection="column">
              {languageWindow.items.map((item, index) => {
                const absoluteIndex = languageWindow.start + index;
                const selected = absoluteIndex === languageIndex;
                return (
                  <Text key={item.id} color={selected ? theme.accent : undefined}>
                    {selected ? "❯" : " "} {item.label.padEnd(10)} · {item.detail}
                    {item.id === languagePreference ? ` · ${copy.active}` : ""}
                  </Text>
                );
              })}
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>{copy.navigateApplyCancel}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>

      {commandMode && (
        <Box flexDirection="column" borderStyle="single" borderColor={theme.command} paddingX={1}>
          <Text bold color={theme.command}>
            {copy.commands}
            {commandMatches.length > commandWindowSize
              ? ` [${commandWindow.start + 1}-${commandWindow.end}/${commandMatches.length}]`
              : ""}
          </Text>
          {commandMatches.length === 0 ? (
            <Text color={theme.muted}>{copy.noMatchingCommands}</Text>
          ) : (
            <>
              {commandWindow.items.map((command, index) => {
                const absoluteIndex = commandWindow.start + index;
                return (
                  <Text
                    key={command.name}
                    color={absoluteIndex === commandIndex ? theme.command : undefined}
                  >
                    {absoluteIndex === commandIndex ? ">" : " "} /{command.name.padEnd(13)}{" "}
                    {command.description}
                  </Text>
                );
              })}
            </>
          )}
        </Box>
      )}

      {updateNotice && (
        <Box paddingX={1} justifyContent="flex-end">
          <Text bold color={theme.accent}>
            {truncateToWidth(updateNotice, Math.max(1, terminalSize.columns - 2))}
          </Text>
        </Box>
      )}

      <Box
        marginTop={updateNotice ? 0 : 1}
        borderStyle="round"
        borderColor={commandMode ? theme.command : theme.border}
        paddingX={1}
      >
        <Text color={theme.prompt} bold>&gt; </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={1}>
          <ImeTextInput
            key={inputEpoch}
            value={input}
            onChange={handleInputChange}
            onSubmit={submit}
            placeholder={copy.placeholder}
            cursorPosition={
              viewMode === "chat"
                ? { x: 5, y: chatSpacerHeight + commandPanelRows + 2 }
                : undefined
            }
          />
        </Box>
        {showComposerHints && (
          <Text color={theme.muted}>
            ↩: {viewMode === "conversations" ? copy.open : copy.send} · /: {copy.commands} · Esc: {viewMode === "chat" ? copy.exit : copy.back}
          </Text>
        )}
      </Box>
      {pathFooterVisible && (
        <Text>
          {"  "}
          <Text color={theme.muted}>{displayModelLabel} · </Text>
          <Text color={theme.path}>{activePath}</Text>
        </Text>
      )}
      {error && <Text color={theme.danger}>error: {error}</Text>}
      </Box>
    </>
  );
}

function toPathSegment(value: string): string {
  return value.replaceAll("/", "／").replaceAll("\\", "＼").trim();
}

function wrapTerminalLines(value: string, width: number): string[] {
  return wrapAnsi(value, Math.max(1, width), {
    hard: true,
    wordWrap: false,
    trim: false,
  }).split("\n");
}

function clipTerminalLines(
  lines: string[],
  maxRows: number,
  width: number,
  pad: boolean = false,
): string[] {
  const limit = Math.max(1, maxRows);
  if (lines.length <= limit) return lines;
  const clipped = lines.slice(0, limit);
  const lastIndex = clipped.length - 1;
  const lastLine = truncateToWidth(clipped[lastIndex]!.trimEnd(), Math.max(1, width - 1));
  const ellipsized = `${lastLine}…`;
  clipped[lastIndex] = pad ? padToWidth(ellipsized, width) : ellipsized;
  return clipped;
}

function serviceStateIcon(state: ChatSnapshot["state"]): string {
  if (state === "connected") return "✔";
  if (state === "error" || state === "disconnected") return "✘";
  return "…";
}

function serviceStateColor(state: ChatSnapshot["state"], theme: UiTheme): string {
  if (state === "connected") return theme.success;
  if (state === "error" || state === "disconnected") return theme.danger;
  return theme.warning;
}

function nextRenderTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function useTerminalSize(stdout: NodeJS.WriteStream): { rows: number; columns: number } {
  const readSize = (): { rows: number; columns: number } => ({
    rows: stdout.rows || 32,
    columns: stdout.columns || 80,
  });
  const [size, setSize] = useState(readSize);

  useEffect(() => {
    const update = (): void => setSize(readSize());
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  return size;
}
