/**
 * Regression tests for Telegram lifecycle hook helpers
 * Covers pi lifecycle hook registration and hook composition ordering
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import {
  appendTelegramLifecycleHooks,
  createTelegramCompactionObserverRuntime,
  createTelegramSessionContextStore,
  createTelegramSessionGenerationFence,
  createTelegramMessageActivityTypingHooks,
  registerTelegramLifecycleHooks,
  TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS,
  type TelegramLifecycleRegistrationDeps,
} from "../lib/lifecycle.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";
import {
  createTelegramAgentLifecycleHooks,
  type PendingTelegramTurn,
  type TelegramAgentLifecycleHooksRuntimeDeps,
} from "../lib/queue.ts";
import {
  createTelegramBridgeRuntime,
  createTelegramTypingLoopStarter,
} from "../lib/runtime.ts";

type RegisteredLifecycleHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createLifecycleApiHarness() {
  const handlers = new Map<string, RegisteredLifecycleHandler>();
  const api = {
    on: (event: string, handler: RegisteredLifecycleHandler) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function getRequiredLifecycleHandler(
  handlers: Map<string, RegisteredLifecycleHandler>,
  name: string,
): RegisteredLifecycleHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected lifecycle handler ${name}`);
  return handler;
}

function createLifecycleContext(): ExtensionContext {
  return {} as ExtensionContext;
}

test("Session generation fence ignores delayed shutdown from a replaced context", async () => {
  const store = createTelegramSessionContextStore<ExtensionContext>();
  const shutdowns: ExtensionContext[] = [];
  const runtime = createTelegramSessionGenerationFence(store, {
    onSessionStart: async () => undefined,
    onSessionShutdown: async (_event, ctx) => {
      shutdowns.push(ctx);
    },
  });
  const oldContext = { cwd: "/old" } as ExtensionContext;
  const newContext = { cwd: "/new" } as ExtensionContext;

  await runtime.onSessionStart({} as never, oldContext);
  await runtime.onSessionStart({} as never, newContext);
  await runtime.onSessionShutdown({} as never, oldContext);

  assert.equal(store.get(), newContext);
  assert.deepEqual(shutdowns, []);
  await runtime.onSessionShutdown({} as never, newContext);
  assert.equal(store.get(), undefined);
  assert.deepEqual(shutdowns, [newContext]);
});

test("Session context store accepts only the current explicit session identity", () => {
  type Context = { session: object };
  const store = createTelegramSessionContextStore<Context>({
    getIdentity: (ctx) => ctx.session,
  });
  const currentSession = {};
  const currentStart = { session: currentSession };
  const currentEvent = { session: currentSession };
  const unseenStaleEvent = { session: {} };

  const generation = store.set(currentStart);
  assert.equal(store.isCurrent(currentEvent, generation), true);
  assert.equal(store.isCurrent(unseenStaleEvent, generation), false);
  assert.equal(store.isCurrent(unseenStaleEvent), false);
  assert.equal(store.getGeneration(), generation);
});

test("Lifecycle composition skips old shutdown extras after replacement during await", async () => {
  let active = true;
  let releaseBase: (() => void) | undefined;
  const baseBlocked = new Promise<void>((resolve) => {
    releaseBase = resolve;
  });
  const events: string[] = [];
  const ctx = createLifecycleContext();
  const hooks = appendTelegramLifecycleHooks(
    {
      onSessionStart: async () => {},
      onSessionShutdown: async () => {
        events.push("base-start");
        await baseBlocked;
        events.push("base-end");
      },
    },
    {
      onSessionShutdown: async () => {
        events.push("extra-shutdown");
      },
    },
    () => active,
  );

  const shutdown = hooks.onSessionShutdown({} as never, ctx);
  await Promise.resolve();
  active = false;
  releaseBase?.();
  await shutdown;

  assert.deepEqual(events, ["base-start", "base-end"]);
});

test("Lifecycle helpers compose session hooks in order", async () => {
  const events: string[] = [];
  const hooks = appendTelegramLifecycleHooks(
    {
      onSessionStart: async () => {
        events.push("base-start");
      },
      onSessionShutdown: async () => {
        events.push("base-shutdown");
      },
    },
    {
      onSessionStart: async () => {
        events.push("extra-start");
      },
      onSessionShutdown: async () => {
        events.push("extra-shutdown");
      },
    },
  );
  await hooks.onSessionStart({} as never, createLifecycleContext());
  await hooks.onSessionShutdown({} as never, createLifecycleContext());
  assert.deepEqual(events, [
    "base-start",
    "extra-start",
    "base-shutdown",
    "extra-shutdown",
  ]);
});

test("Compaction observer mirrors active work with native typing", () => {
  const events: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn(dispatch) {
      events.push("dispatch:request");
      dispatch(createLifecycleContext());
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    recordRuntimeEvent(category, error) {
      events.push(`${category}:${(error as Error).message}`);
    },
    timeoutMs: 10,
    setTimer(callback) {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimer(timer) {
      timers.delete(timer as number);
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
  ]);
});

test("Compaction observer keeps native typing for non-turn compaction", () => {
  const events: string[] = [];
  let timerCallback: (() => void) | undefined;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn(dispatch) {
      events.push("dispatch:request");
      dispatch(createLifecycleContext());
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() {
      timerCallback = undefined;
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionCompact({} as never, createLifecycleContext());
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  timerCallback?.();
  observer.onSessionShutdown();
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "dispatch:request",
    "dispatch",
  ]);
});

test("Compaction observer sends native typing to the resolved thread and All", async () => {
  const runtime = createTelegramBridgeRuntime();
  const actions: Array<string> = [];
  const startTyping = createTelegramTypingLoopStarter({
    typing: runtime.typing,
    getDefaultChatId: () => 77,
    sendTypingAction: async (chatId, options) => {
      actions.push(`thread:${chatId}:${options?.message_thread_id ?? "all"}`);
    },
    sendAggregateTypingAction: async (chatId) => {
      actions.push(`aggregate:${chatId}`);
    },
    updateStatus: () => {},
    intervalMs: 60_000,
  });
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: runtime.lifecycle.setCompactionInProgress,
    updateStatus: () => {},
    startTypingLoop: (ctx) =>
      startTyping(ctx, 77, { target: { chatId: 77, threadId: 12 } }),
    stopTypingLoop: runtime.typing.stop,
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });

  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  await new Promise<void>((resolve) => setImmediate(resolve));
  observer.onSessionCompact({} as never, createLifecycleContext());
  await runtime.typing.waitForIdle();

  assert.deepEqual(actions, ["thread:77:12", "aggregate:77"]);
  assert.equal(runtime.lifecycle.isCompactionInProgress(), false);
});

test("Compaction observer unrefs fallback timers when supported", () => {
  const events: string[] = [];
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress: () => {},
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    setTimer(callback) {
      assert.equal(typeof callback, "function");
      return {
        unref() {
          events.push("unref");
        },
      } as ReturnType<typeof setTimeout>;
    },
    clearTimer() {},
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  assert.deepEqual(events, ["unref"]);
});

test("Compaction observer stops typing on timeout and shutdown", () => {
  const events: string[] = [];
  let timerCallback: (() => void) | undefined;
  const observer = createTelegramCompactionObserverRuntime({
    setCompactionInProgress(inProgress) {
      events.push(`compact:${String(inProgress)}`);
    },
    updateStatus() {
      events.push("status");
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    stopTypingLoop() {
      events.push("typing:stop");
    },
    requestDeferredDispatchNextQueuedTelegramTurn() {
      events.push("dispatch:request");
    },
    dispatchNextQueuedTelegramTurn() {
      events.push("dispatch");
    },
    recordRuntimeEvent(category, error) {
      events.push(`${category}:${(error as Error).message}`);
    },
    onCompactionAbandoned() {
      events.push("activity:compact-abandoned");
    },
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() {
      timerCallback = undefined;
    },
  });
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  timerCallback?.();
  observer.onSessionBeforeCompact({} as never, createLifecycleContext());
  observer.onSessionShutdown();
  assert.deepEqual(events, [
    "compact:true",
    "typing:start",
    "status",
    "compact:false",
    "typing:stop",
    "status",
    "compact:Compaction observer timed out",
    "activity:compact-abandoned",
    "dispatch:request",
    "compact:true",
    "typing:start",
    "status",
    "typing:stop",
  ]);
});

test("Message activity hooks re-arm typing for active Telegram turns", async () => {
  const events: string[] = [];
  let active = true;
  const hooks = createTelegramMessageActivityTypingHooks({
    hasActiveTurn() {
      return active;
    },
    startTypingLoop() {
      events.push("typing:start");
    },
    async onMessageStart() {
      events.push("message:start");
    },
    async onMessageUpdate() {
      events.push("message:update");
    },
  });
  await hooks.onMessageStart(
    { message: {} as never },
    createLifecycleContext(),
  );
  active = false;
  await hooks.onMessageUpdate(
    { message: {} as never, assistantMessageEvent: {} as never },
    createLifecycleContext(),
  );
  assert.deepEqual(events, [
    "typing:start",
    "message:start",
    "typing:start",
    "message:update",
  ]);
});

test("Message activity hooks preserve typing after transient preview errors", async () => {
  const events: string[] = [];
  const hooks = createTelegramMessageActivityTypingHooks({
    hasActiveTurn: () => true,
    startTypingLoop: () => {
      events.push("typing:start");
    },
    onMessageStart: async () => {
      events.push("message:start");
    },
    onMessageUpdate: async () => {
      events.push("message:update");
      throw new Error("websocket disconnected");
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`${category}:${message}:${details?.phase}`);
    },
  });

  await hooks.onMessageUpdate(
    { message: {} as never, assistantMessageEvent: {} as never },
    createLifecycleContext(),
  );

  assert.deepEqual(events, [
    "typing:start",
    "message:update",
    "message-activity:websocket disconnected:update",
    "typing:start",
  ]);
});

test("Lifecycle helpers register pi hooks and delegate to handlers", async () => {
  const harness = createLifecycleApiHarness();
  const events: string[] = [];
  registerTelegramLifecycleHooks(harness.api, {
    onSessionStart: async () => {
      events.push("session-start");
    },
    onSessionShutdown: async () => {
      events.push("session-shutdown");
    },
    onSessionBeforeCompact: () => {
      events.push("session-before-compact");
    },
    onSessionCompact: () => {
      events.push("session-compact");
    },
    onBeforeAgentStart: (event) => {
      events.push("before-agent-start");
      return { systemPrompt: event.systemPrompt };
    },
    onModelSelect: () => {
      events.push("model-select");
    },
    onAgentStart: async () => {
      events.push("agent-start");
    },
    onToolExecutionStart: () => {
      events.push("tool-start");
    },
    onToolExecutionUpdate: () => {
      events.push("tool-update");
    },
    onToolExecutionEnd: () => {
      events.push("tool-end");
    },
    onMessageStart: async () => {
      events.push("message-start");
    },
    onMessageUpdate: async () => {
      events.push("message-update");
    },
    onAgentEnd: async () => {
      events.push("agent-end");
    },
  });
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "input",
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "before_agent_start",
      "model_select",
      "agent_start",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_update",
      "agent_end",
      "agent_settled",
    ],
  );
  const ctx = createLifecycleContext();
  await getRequiredLifecycleHandler(harness.handlers, "input")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "session_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "session_shutdown")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "session_before_compact")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "session_compact")(
    {},
    ctx,
  );
  const beforeAgentStartResult = await getRequiredLifecycleHandler(
    harness.handlers,
    "before_agent_start",
  )({ systemPrompt: ["base", "project context"] }, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "model_select")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_start")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_update")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "tool_execution_end")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "message_start")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "message_update")(
    {},
    ctx,
  );
  await getRequiredLifecycleHandler(harness.handlers, "agent_end")({}, ctx);
  await getRequiredLifecycleHandler(harness.handlers, "agent_settled")({}, ctx);
  assert.deepEqual(beforeAgentStartResult, {
    systemPrompt: ["base", "project context"],
  });
  assert.deepEqual(events, [
    "session-start",
    "session-shutdown",
    "session-before-compact",
    "session-compact",
    "before-agent-start",
    "model-select",
    "agent-start",
    "tool-start",
    "tool-update",
    "tool-end",
    "message-start",
    "message-update",
    "agent-end",
  ]);
});

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HOST_0_8_1_EVENT_NAMES = [
  "after_provider_response",
  "agent_end",
  "agent_start",
  "before_agent_start",
  "before_provider_request",
  "context",
  "input",
  "message_end",
  "message_start",
  "message_update",
  "model_select",
  "refine_complete",
  "resources_discover",
  "session_before_compact",
  "session_before_fork",
  "session_before_refine",
  "session_before_switch",
  "session_before_tree",
  "session_compact",
  "session_shutdown",
  "session_start",
  "session_tree",
  "thinking_level_select",
  "tool_call",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_result",
  "turn_end",
  "turn_start",
  "user_bash",
] as const;

const FORK_SUBSCRIBED_EVENT_NAMES = [
  "input",
  "session_start",
  "session_shutdown",
  "session_before_compact",
  "session_compact",
  "before_agent_start",
  "model_select",
  "agent_start",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "message_start",
  "message_update",
  "agent_end",
  "agent_settled",
  "resources_discover",
] as const;

function resolveHostExtensionTypesPath(): string | undefined {
  const candidates = [
    process.env.PI_AGENT_DIST,
    join(
      dirname(dirname(process.execPath)),
      "lib",
      "node_modules",
      "prime-agent",
      "dist",
    ),
  ];
  for (const dist of candidates) {
    if (!dist) continue;
    const typesPath = join(dist, "core", "extensions", "types.d.ts");
    if (existsSync(typesPath)) return typesPath;
  }
  return undefined;
}

function readHostEventDiscriminants(typesPath: string): Set<string> {
  const source = readFileSync(typesPath, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*type: "([a-z_]+)";$/gm)) {
    names.add(match[1] as string);
  }
  return names;
}

interface ManualClock {
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  advance: (ms: number) => Promise<void>;
  pendingCount: () => number;
}

function createManualClock(): ManualClock {
  let now = 0;
  let sequence = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  const drain = async (): Promise<void> => {
    for (let index = 0; index < 25; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  return {
    setTimer: (callback, ms) => {
      sequence += 1;
      const id = sequence;
      scheduled.set(id, { at: now + Math.max(0, ms), callback });
      const handle = { id, unref: () => handle };
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      const handle = timer as unknown as { id?: number };
      if (typeof handle?.id === "number") scheduled.delete(handle.id);
    },
    advance: async (ms) => {
      now += ms;
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, entry] of due) {
        scheduled.delete(id);
        entry.callback();
        await drain();
      }
      await drain();
    },
    pendingCount: () => scheduled.size,
  };
}

type DaemonEventHandler = (event: unknown, ctx: unknown) => unknown;

interface DaemonExtensionHost {
  pi: { on: (event: string, handler: DaemonEventHandler) => void };
  ctx: Record<string, unknown>;
  emit: (name: string, event?: unknown) => Promise<void>;
  registeredEventNames: () => string[];
  droppedEmits: string[];
  notifications: Array<{ message: string; notifyType?: string }>;
}

function createDaemonExtensionHost(options: {
  hostEventNames: ReadonlySet<string>;
}): DaemonExtensionHost {
  const handlers = new Map<string, DaemonEventHandler[]>();
  const notifications: Array<{ message: string; notifyType?: string }> = [];
  const droppedEmits: string[] = [];
  const ui = {
    notify: (message: string, notifyType?: string) => {
      notifications.push({ message, notifyType });
    },
    setStatus: () => {},
    setTitle: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    setEditorText: () => {},
    pasteToEditor: () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "Theme switching is not supported in daemon mode",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    custom: async () => undefined,
  };
  const ctx: Record<string, unknown> = {
    ui,
    hasUI: true,
    cwd: REPO_ROOT,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };
  return {
    pi: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    },
    ctx,
    emit: async (name, event = {}) => {
      if (!options.hostEventNames.has(name)) {
        droppedEmits.push(name);
        return;
      }
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx);
      }
    },
    registeredEventNames: () => [...handlers.keys()],
    droppedEmits,
    notifications,
  };
}

interface AgentSettledScenario {
  deliveries: string[];
  phases: string[];
  activeTurnAfter: () => PendingTelegramTurn | undefined;
  settledActivityCount: () => number;
  pendingTimerCount: () => number;
  emitAgentStart: () => Promise<void>;
  emitErroredTurn: () => Promise<void>;
  emitRecoveredTurn: () => Promise<void>;
  emitAgentSettled: () => Promise<void>;
  emitSessionShutdown: () => Promise<void>;
  advance: (ms: number) => Promise<void>;
  host: DaemonExtensionHost;
}

interface ForkLifecycleModules {
  createTelegramAgentLifecycleHooks: typeof createTelegramAgentLifecycleHooks;
  registerTelegramLifecycleHooks: typeof registerTelegramLifecycleHooks;
}

const CURRENT_MODULES: ForkLifecycleModules = {
  createTelegramAgentLifecycleHooks,
  registerTelegramLifecycleHooks,
};

function createScenario(options: {
  hostEventNames: ReadonlySet<string>;
  modules: ForkLifecycleModules;
  settleFallbackDelayMs?: number;
}): AgentSettledScenario {
  const clock = createManualClock();
  const host = createDaemonExtensionHost({
    hostEventNames: options.hostEventNames,
  });
  const deliveries: string[] = [];
  const phases: string[] = [];
  let settledActivityCount = 0;
  const turn: PendingTelegramTurn = {
    kind: "prompt",
    chatId: 7,
    replyToMessageId: 8,
    sourceMessageIds: [8],
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text", text: "prompt" }],
    historyText: "prompt",
    statusSummary: "prompt",
  };
  let activeTurn: PendingTelegramTurn | undefined = turn;
  const hookDeps: TelegramAgentLifecycleHooksRuntimeDeps<
    PendingTelegramTurn,
    unknown,
    { result: "error" | "success" }
  > = {
    setAbortHandler: () => {},
    getQueuedItems: () => [],
    hasPendingDispatch: () => false,
    hasActiveTurn: () => !!activeTurn,
    resetToolExecutions: () => {},
    resetPendingModelSwitch: () => {},
    setQueuedItems: () => {},
    clearDispatchPending: () => {},
    setFoldQueuedPromptsIntoHistory: () => {},
    setActiveTurn: (nextTurn) => {
      activeTurn = nextTurn;
    },
    createPreviewState: () => {},
    startTypingLoop: () => {},
    updateStatus: () => {},
    getActiveTurn: () => activeTurn,
    extractAssistant: ([message]) =>
      message?.result === "success"
        ? { text: "Recovered answer" }
        : { stopReason: "error", errorMessage: "WebSocket error" },
    getFoldQueuedPromptsIntoHistory: () => false,
    resetRuntimeState: () => {
      activeTurn = undefined;
    },
    dispatchNextQueuedTelegramTurn: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      dispatch(undefined);
    },
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async (_chatId, text) => {
      deliveries.push(`markdown:${text}`);
      return true;
    },
    sendMarkdownReply: async () => {},
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      deliveries.push(`text:${text}`);
    },
    sendQueuedAttachments: async () => {},
    getActiveToolExecutions: () => 0,
    setActiveToolExecutions: () => {},
    triggerPendingModelSwitchAbort: () => {},
    recordRuntimeEvent: (_category, _error, details) => {
      const phase = details?.phase;
      if (typeof phase === "string") phases.push(phase);
    },
  };
  const hooks = options.modules.createTelegramAgentLifecycleHooks<
    PendingTelegramTurn,
    unknown,
    { result: "error" | "success" }
  >(hookDeps);
  const lifecycleDeps: TelegramLifecycleRegistrationDeps = {
    onSessionStart: async () => {},
    onSessionShutdown: async () => {},
    onBeforeAgentStart: () => undefined,
    onModelSelect: () => {},
    onAgentStart: hooks.onAgentStart,
    onToolExecutionStart: hooks.onToolExecutionStart,
    onToolExecutionEnd: hooks.onToolExecutionEnd,
    onMessageStart: async () => {},
    onMessageUpdate: async () => {},
    onAgentEnd:
      hooks.onAgentEnd as unknown as TelegramLifecycleRegistrationDeps["onAgentEnd"],
    onAgentSettled: async (event, ctx) => {
      await hooks.onAgentSettled(event, ctx);
      settledActivityCount += 1;
    },
    agentSettledFallbackDelayMs: options.settleFallbackDelayMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    recordRuntimeEvent: (_category, _error, details) => {
      const phase = details?.phase;
      if (typeof phase === "string") phases.push(phase);
    },
  };
  options.modules.registerTelegramLifecycleHooks(
    host.pi as unknown as ExtensionAPI,
    lifecycleDeps,
  );
  return {
    deliveries,
    phases,
    activeTurnAfter: () => activeTurn,
    settledActivityCount: () => settledActivityCount,
    pendingTimerCount: clock.pendingCount,
    emitAgentStart: async () => {
      await host.emit("agent_start", {});
    },
    emitErroredTurn: async () => {
      await host.emit("agent_end", { messages: [{ result: "error" }] });
    },
    emitRecoveredTurn: async () => {
      await host.emit("agent_end", { messages: [{ result: "success" }] });
    },
    emitAgentSettled: async () => {
      await host.emit("agent_settled", {});
    },
    emitSessionShutdown: async () => {
      await host.emit("session_shutdown", { reason: "quit" });
    },
    advance: clock.advance,
    host,
  };
}

const AGENT_SETTLED_BASELINE_COMMIT =
  "fcc2ee9514e6d1371680fd7e2f7719407a1b33a2";

let baselineDir: string | undefined;

function materializeBaselineLib(): string {
  if (baselineDir) return baselineDir;
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-baseline-"));
  const libDir = join(dir, "lib");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  execFileSync("mkdir", ["-p", libDir]);
  for (const entry of readdirSync(join(REPO_ROOT, "lib"))) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".mjs")) continue;
    const source = execFileSync(
      "git",
      ["show", `${AGENT_SETTLED_BASELINE_COMMIT}:lib/${entry}`],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    writeFileSync(join(libDir, entry), source);
  }
  baselineDir = dir;
  return dir;
}

after(() => {
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

async function loadBaselineModules(): Promise<ForkLifecycleModules> {
  const dir = materializeBaselineLib();
  const queueUrl = pathToFileURL(join(dir, "lib", "queue.ts")).href;
  const lifecycleUrl = pathToFileURL(join(dir, "lib", "lifecycle.ts")).href;
  const queueModule = (await import(queueUrl)) as ForkLifecycleModules;
  const lifecycleModule = (await import(lifecycleUrl)) as ForkLifecycleModules &
    Record<string, unknown>;
  assert.equal(
    lifecycleModule.TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS,
    undefined,
    `Baseline commit ${AGENT_SETTLED_BASELINE_COMMIT} already contains the agent_settled fallback, so this negative control proves nothing. Repoint AGENT_SETTLED_BASELINE_COMMIT at a commit before the fix.`,
  );
  return {
    createTelegramAgentLifecycleHooks:
      queueModule.createTelegramAgentLifecycleHooks,
    registerTelegramLifecycleHooks:
      lifecycleModule.registerTelegramLifecycleHooks,
  };
}

test("host 0.8.1 never exposes agent_settled to extensions", () => {
  const typesPath = resolveHostExtensionTypesPath();
  assert.ok(
    typesPath,
    "prime-agent host dist not found; set PI_AGENT_DIST to the host dist directory",
  );
  const discriminants = readHostEventDiscriminants(typesPath);
  for (const name of HOST_0_8_1_EVENT_NAMES) {
    assert.ok(
      discriminants.has(name),
      `frozen host event ${name} is missing from ${typesPath}`,
    );
  }
  assert.equal(
    discriminants.has("agent_settled"),
    false,
    "agent_settled unexpectedly present in the host extension event union",
  );
  assert.equal(
    readFileSync(typesPath, "utf8").includes("agent_settled"),
    false,
    "agent_settled unexpectedly present in the host extension type surface",
  );
});

test("fork subscribes to exactly one event the host never emits", () => {
  const hostEventNames = new Set<string>(HOST_0_8_1_EVENT_NAMES);
  const scenario = createScenario({
    hostEventNames,
    modules: CURRENT_MODULES,
  });
  const registered = scenario.host.registeredEventNames();
  for (const name of FORK_SUBSCRIBED_EVENT_NAMES) {
    if (name === "resources_discover") continue;
    assert.ok(
      registered.includes(name),
      `lifecycle registration no longer subscribes to ${name}`,
    );
  }
  const absent = registered.filter((name) => !hostEventNames.has(name));
  assert.deepEqual(absent, ["agent_settled"]);
});

test("NEGATIVE CONTROL: pinned pre-fix baseline drops the errored reply on host 0.8.1", async () => {
  const modules = await loadBaselineModules();
  const scenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  await scenario.advance(600_000);
  await scenario.emitAgentSettled();
  await scenario.advance(600_000);
  assert.deepEqual(scenario.host.droppedEmits, ["agent_settled"]);
  assert.deepEqual(scenario.phases, ["retained"]);
  assert.deepEqual(scenario.deliveries, []);
  assert.notEqual(scenario.activeTurnAfter(), undefined);
  await assert.rejects(
    async () => {
      assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
    },
    { name: "AssertionError" },
    "baseline unexpectedly delivered the retained reply",
  );
});

test("fallback delivers the retained reply exactly once on host 0.8.1", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  assert.deepEqual(scenario.deliveries, []);
  await scenario.advance(TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS);
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
  assert.deepEqual(scenario.phases, [
    "retained",
    "agent-settled-fallback-engaged",
    "settled-failure",
  ]);
  assert.equal(scenario.activeTurnAfter(), undefined);
  await scenario.advance(600_000);
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
});

test("a real agent_settled disarms the fallback and delivers once", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>([
      ...HOST_0_8_1_EVENT_NAMES,
      "agent_settled",
    ]),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  await scenario.emitAgentSettled();
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
  assert.deepEqual(scenario.phases, ["retained", "settled-failure"]);
  assert.equal(scenario.pendingTimerCount(), 0);
  await scenario.advance(600_000);
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
  assert.deepEqual(scenario.phases, ["retained", "settled-failure"]);
});

test("a late agent_settled after the fallback cannot double deliver", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>([
      ...HOST_0_8_1_EVENT_NAMES,
      "agent_settled",
    ]),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  await scenario.advance(TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS);
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
  await scenario.emitAgentSettled();
  await scenario.advance(600_000);
  assert.deepEqual(scenario.deliveries, ["text:WebSocket error"]);
});

test("a recovery agent_end disarms the fallback and wins", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  await scenario.emitAgentStart();
  await scenario.emitRecoveredTurn();
  assert.deepEqual(scenario.phases, ["retained", "recovered"]);
  await scenario.advance(600_000);
  assert.deepEqual(scenario.deliveries, ["markdown:Recovered answer"]);
  assert.deepEqual(scenario.phases, [
    "retained",
    "recovered",
    "agent-settled-fallback-engaged",
  ]);
});

test("a new agent_start disarms the previous fallback", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  assert.equal(scenario.pendingTimerCount(), 1);
  await scenario.emitAgentStart();
  assert.equal(scenario.pendingTimerCount(), 0);
});

test("session_shutdown disarms a pending fallback", async () => {
  const scenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: CURRENT_MODULES,
  });
  await scenario.emitAgentStart();
  await scenario.emitErroredTurn();
  assert.equal(scenario.pendingTimerCount(), 1);
  await scenario.emitSessionShutdown();
  assert.equal(scenario.pendingTimerCount(), 0);
  await scenario.advance(600_000);
  assert.deepEqual(scenario.deliveries, []);
});

test("NEGATIVE CONTROL: pinned pre-fix baseline never settles activity after a clean turn", async () => {
  const baseline = await loadBaselineModules();
  const baselineScenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: baseline,
  });
  await baselineScenario.emitAgentStart();
  await baselineScenario.emitRecoveredTurn();
  await baselineScenario.advance(600_000);
  assert.deepEqual(baselineScenario.settledActivityCount(), 0);

  const fixedScenario = createScenario({
    hostEventNames: new Set<string>(HOST_0_8_1_EVENT_NAMES),
    modules: CURRENT_MODULES,
  });
  await fixedScenario.emitAgentStart();
  await fixedScenario.emitRecoveredTurn();
  await fixedScenario.advance(TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS);
  assert.equal(fixedScenario.settledActivityCount(), 1);
});
