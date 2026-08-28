/**
 * Telegram lifecycle hook registration helpers
 * Zones: pi agent lifecycle, telegram session
 * Binds prepared Telegram lifecycle runtimes to pi extension lifecycle events
 */

import * as BusFollower from "./bus-follower.ts";
import * as Queue from "./queue.ts";
import * as TextGroups from "./text-groups.ts";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  AssistantMessageEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "./pi.ts";

let resetTransportReplyDedupFn: (() => void) | undefined;

export function setResetTransportReplyDedup(fn: () => void): void {
  resetTransportReplyDedupFn = fn;
}

export function createAgentStartDedupHook(
  inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>,
): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void> {
  return async (event, ctx) => {
    if (resetTransportReplyDedupFn) resetTransportReplyDedupFn();
    return inner(event, ctx);
  };
}

type TelegramBeforeAgentStartEvent = Omit<
  BeforeAgentStartEvent,
  "systemPrompt"
> & {
  systemPrompt: string | string[];
};

export interface TelegramBeforeAgentStartResult {
  systemPrompt?: string | string[];
}

type TelegramBeforeAgentStartReturn =
  | Promise<TelegramBeforeAgentStartResult | undefined>
  | TelegramBeforeAgentStartResult
  | undefined;

type TelegramLifecycleModel = ExtensionContext["model"];
type TelegramLifecycleMessage = AgentEndEvent["messages"][number];

export interface TelegramLifecycleRegistrationDeps {
  isSessionActive?: (ctx: ExtensionContext) => boolean;
  onInput?: (event: InputEvent, ctx: ExtensionContext) => Promise<void> | void;
  onSessionStart: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionBeforeCompact?: (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onSessionCompact?: (
    event: SessionCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onBeforeAgentStart: (
    event: TelegramBeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => TelegramBeforeAgentStartReturn;
  onModelSelect: (
    event: { model: TelegramLifecycleModel },
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onAgentStart: (
    event: AgentStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onToolExecutionStart: (
    event: ToolExecutionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onToolExecutionUpdate?: (
    event: ToolExecutionUpdateEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onToolExecutionEnd: (
    event: ToolExecutionEndEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onMessageStart: (
    event: { message: TelegramLifecycleMessage },
    ctx: ExtensionContext,
  ) => Promise<void>;
  onMessageUpdate: (
    event: {
      message: TelegramLifecycleMessage;
      assistantMessageEvent?: AssistantMessageEvent;
    },
    ctx: ExtensionContext,
  ) => Promise<void>;
  onAgentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
  onAgentSettled?: (
    event: AgentSettledEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  agentSettledFallbackDelayMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export const TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS = 1500;

export interface TelegramSessionLifecycleHooks {
  onSessionStart: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export interface TelegramSessionContextStore<TContext> {
  get: () => TContext | undefined;
  getGeneration: () => number;
  isCurrent: (ctx: TContext, generation?: number) => boolean;
  set: (ctx: TContext) => number;
  clear: (ctx?: TContext) => boolean;
}

export function createTelegramSessionContextStore<TContext>(
  options: {
    getIdentity?: (ctx: TContext) => unknown;
  } = {},
): TelegramSessionContextStore<TContext> {
  let currentContext: TContext | undefined;
  let currentIdentity: unknown;
  let generation = 0;
  const objectIdentityGenerations = new WeakMap<object, number>();
  const primitiveIdentityGenerations = new Map<unknown, number>();
  const resolveIdentity = (ctx: TContext): unknown =>
    options.getIdentity?.(ctx) ?? ctx;
  const getIdentityGeneration = (identity: unknown): number | undefined =>
    (typeof identity === "object" && identity !== null) ||
    typeof identity === "function"
      ? objectIdentityGenerations.get(identity as object)
      : primitiveIdentityGenerations.get(identity);
  const setIdentityGeneration = (identity: unknown, value: number): void => {
    if (
      (typeof identity === "object" && identity !== null) ||
      typeof identity === "function"
    ) {
      objectIdentityGenerations.set(identity as object, value);
    } else {
      primitiveIdentityGenerations.set(identity, value);
    }
  };
  return {
    get: () => currentContext,
    getGeneration: () => generation,
    isCurrent: (ctx, expectedGeneration) => {
      if (currentContext === undefined) return false;
      const identity = resolveIdentity(ctx);
      return (
        identity === currentIdentity &&
        getIdentityGeneration(identity) === generation &&
        (expectedGeneration === undefined || generation === expectedGeneration)
      );
    },
    set: (ctx) => {
      currentContext = ctx;
      currentIdentity = resolveIdentity(ctx);
      generation += 1;
      setIdentityGeneration(currentIdentity, generation);
      return generation;
    },
    clear: (ctx) => {
      if (ctx !== undefined) {
        const identity = resolveIdentity(ctx);
        if (
          identity !== currentIdentity ||
          getIdentityGeneration(identity) !== generation
        ) {
          return false;
        }
      }
      if (currentContext === undefined) return false;
      currentContext = undefined;
      currentIdentity = undefined;
      generation += 1;
      return true;
    },
  };
}

export function createTelegramSessionGenerationFence(
  store: TelegramSessionContextStore<ExtensionContext>,
  hooks: TelegramSessionLifecycleHooks,
): TelegramSessionLifecycleHooks {
  return {
    async onSessionStart(event, ctx) {
      const generation = store.set(ctx);
      await hooks.onSessionStart(event, ctx);
      if (!store.isCurrent(ctx, generation)) return;
    },
    async onSessionShutdown(event, ctx) {
      const generation = store.getGeneration();
      if (!store.isCurrent(ctx, generation)) return;
      await hooks.onSessionShutdown(event, ctx);
      store.clear(ctx);
    },
  };
}

export interface TelegramBridgeSessionServiceRuntime {
  resumeGroupedInput(ctx: ExtensionContext): void;
  suspendGroupedInput(): void;
  delivery: {
    onSessionStart(): Promise<void>;
    onSessionShutdown(): Promise<void>;
  };
  polling: {
    onSessionStart(
      event: SessionStartEvent,
      ctx: ExtensionContext,
    ): Promise<void>;
  };
  inboundWorker: { onSessionShutdown(): Promise<void> };
  capabilityMonitor: { start(ctx: ExtensionContext): void; stop(): void };
  queueWatchdog: { start(ctx: ExtensionContext): void; stop(): void };
}

export interface TelegramBridgeSessionLifecycleAssemblyDeps<
  TQueueItem,
  TModel = unknown,
> {
  contextStore: TelegramSessionContextStore<ExtensionContext>;
  queue: Omit<
    Queue.TelegramSessionLifecycleRuntimeDeps<
      ExtensionContext,
      TQueueItem,
      TModel
    >,
    "isSessionActive" | "stopPolling" | "clearPendingMediaGroups"
  >;
  follower: Omit<
    BusFollower.TelegramBusFollowerSessionRefreshHookDeps<ExtensionContext>,
    "isSessionActive"
  > &
    BusFollower.TelegramBusFollowerSessionReplacementSuspenderDeps;
  services: TelegramBridgeSessionServiceRuntime;
}

export interface TelegramBridgeSessionLifecyclePorts<
  TQueueItem,
  TModel = unknown,
> {
  contextStore: TelegramSessionContextStore<ExtensionContext>;
  queue: Omit<
    Queue.TelegramSessionLifecycleRuntimeDeps<
      ExtensionContext,
      TQueueItem,
      TModel
    >,
    "isSessionActive" | "stopPolling" | "clearPendingMediaGroups"
  >;
  follower: Omit<
    BusFollower.TelegramBusFollowerSessionRefreshHookDeps<ExtensionContext>,
    "isSessionActive"
  > &
    BusFollower.TelegramBusFollowerSessionReplacementSuspenderDeps;
  services: {
    mediaGroup: {
      resume(ctx: ExtensionContext): void;
      suspend(): void;
    };
    textGroup: {
      resume(ctx: ExtensionContext): void;
      suspend(): void;
    };
    delivery: TelegramBridgeSessionServiceRuntime["delivery"];
    polling: TelegramBridgeSessionServiceRuntime["polling"];
    inboundWorker: TelegramBridgeSessionServiceRuntime["inboundWorker"];
    capabilityMonitor: TelegramBridgeSessionServiceRuntime["capabilityMonitor"];
    queueWatchdog: TelegramBridgeSessionServiceRuntime["queueWatchdog"];
  };
}

export function createTelegramBridgeSessionLifecycleDeps<
  TQueueItem,
  TModel = unknown,
>(
  ports: TelegramBridgeSessionLifecyclePorts<TQueueItem, TModel>,
): TelegramBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel> {
  return {
    contextStore: ports.contextStore,
    queue: ports.queue,
    follower: ports.follower,
    services: {
      resumeGroupedInput(ctx) {
        ports.services.mediaGroup.resume(ctx);
        ports.services.textGroup.resume(ctx);
      },
      suspendGroupedInput: TextGroups.createTelegramGroupedInputClearer({
        clearMediaGroups: ports.services.mediaGroup.suspend,
        clearTextGroups: ports.services.textGroup.suspend,
      }),
      delivery: ports.services.delivery,
      polling: ports.services.polling,
      inboundWorker: ports.services.inboundWorker,
      capabilityMonitor: ports.services.capabilityMonitor,
      queueWatchdog: ports.services.queueWatchdog,
    },
  };
}

export function createTelegramBridgeSessionLifecycleAssembly<
  TQueueItem,
  TModel = unknown,
>(
  deps: TelegramBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel>,
): TelegramSessionLifecycleHooks {
  const isSessionActive = deps.contextStore.isCurrent;
  const suspendForReplacement =
    BusFollower.createTelegramBusFollowerSessionReplacementSuspender({
      registrationState: deps.follower.registrationState,
      instanceId: deps.follower.instanceId,
      suspendPolling: deps.follower.suspendPolling,
      recordRuntimeEvent: deps.follower.recordRuntimeEvent,
    });
  const queueLifecycle = Queue.createTelegramSessionLifecycleRuntime({
    ...deps.queue,
    isSessionActive,
    stopPolling: suspendForReplacement,
    clearPendingMediaGroups: deps.services.suspendGroupedInput,
  });
  const servicesLifecycle: TelegramSessionLifecycleHooks = {
    async onSessionStart(event, ctx) {
      await queueLifecycle.onSessionStart(event, ctx);
      if (!isSessionActive(ctx)) return;
      deps.services.resumeGroupedInput(ctx);
      await deps.services.delivery.onSessionStart();
      await deps.services.polling.onSessionStart(event, ctx);
      deps.services.capabilityMonitor.start(ctx);
      deps.services.queueWatchdog.start(ctx);
    },
    async onSessionShutdown(event, ctx) {
      if (!isSessionActive(ctx)) return;
      await deps.services.delivery.onSessionShutdown();
      if (!isSessionActive(ctx)) return;
      deps.services.queueWatchdog.stop();
      deps.services.capabilityMonitor.stop();
      await queueLifecycle.onSessionShutdown(event, ctx);
      if (!isSessionActive(ctx)) return;
      await deps.services.inboundWorker.onSessionShutdown();
    },
  };
  const followerLifecycle = appendTelegramLifecycleHooks(
    servicesLifecycle,
    {
      onSessionStart: BusFollower.createTelegramBusFollowerSessionRefreshHook({
        registrationState: deps.follower.registrationState,
        registrationRuntime: deps.follower.registrationRuntime,
        getLeaderState: deps.follower.getLeaderState,
        isSessionActive,
        updateStatus: deps.follower.updateStatus,
        recordRuntimeEvent: deps.follower.recordRuntimeEvent,
      }),
    },
    isSessionActive,
  );
  return createTelegramSessionGenerationFence(
    deps.contextStore,
    followerLifecycle,
  );
}

type TelegramLifecycleTimer = number | ReturnType<typeof setTimeout>;

function unrefTelegramLifecycleTimer(timer: TelegramLifecycleTimer): void {
  if (!timer || typeof timer !== "object") return;
  if (typeof timer.unref === "function") timer.unref();
}

export interface TelegramCompactionObserverRuntimeDeps<TContext> {
  isContextActive?: (ctx: TContext) => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  updateStatus: (ctx: TContext) => void;
  startTypingLoop?: (ctx: TContext) => boolean | void;
  stopTypingLoop?: () => void;
  requestDeferredDispatchNextQueuedTelegramTurn: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  recordRuntimeEvent?: (category: string, error: unknown) => void;
  onCompactionAbandoned?: () => void;
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => TelegramLifecycleTimer;
  clearTimer?: (timer: TelegramLifecycleTimer) => void;
}

export interface TelegramCompactionObserverRuntime<TContext> {
  onSessionBeforeCompact: (
    event: SessionBeforeCompactEvent,
    ctx: TContext,
  ) => void;
  onSessionCompact: (event: SessionCompactEvent, ctx: TContext) => void;
  onSessionShutdown: () => void;
}

export function createTelegramCompactionObserverRuntime<TContext>(
  deps: TelegramCompactionObserverRuntimeDeps<TContext>,
): TelegramCompactionObserverRuntime<TContext> {
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let fallbackTimer: TelegramLifecycleTimer | undefined;
  let typingStartedByObserver = false;
  const clearFallbackTimer = (): void => {
    if (!fallbackTimer) return;
    clearTimer(fallbackTimer);
    fallbackTimer = undefined;
  };
  const requestDispatch = (): void => {
    deps.requestDeferredDispatchNextQueuedTelegramTurn(
      deps.dispatchNextQueuedTelegramTurn,
    );
  };
  return {
    onSessionBeforeCompact: (_event, ctx) => {
      if (deps.isContextActive && !deps.isContextActive(ctx)) return;
      deps.setCompactionInProgress(true);
      const typingStartResult = deps.startTypingLoop?.(ctx);
      typingStartedByObserver =
        !!deps.startTypingLoop && typingStartResult !== false;
      deps.updateStatus(ctx);
      clearFallbackTimer();
      fallbackTimer = setTimer(() => {
        fallbackTimer = undefined;
        if (deps.isContextActive && !deps.isContextActive(ctx)) return;
        deps.setCompactionInProgress(false);
        if (typingStartedByObserver) deps.stopTypingLoop?.();
        typingStartedByObserver = false;
        deps.updateStatus(ctx);
        deps.recordRuntimeEvent?.(
          "compact",
          new Error("Compaction observer timed out"),
        );
        deps.onCompactionAbandoned?.();
        requestDispatch();
      }, timeoutMs);
      unrefTelegramLifecycleTimer(fallbackTimer);
    },
    onSessionCompact: (_event, ctx) => {
      clearFallbackTimer();
      if (deps.isContextActive && !deps.isContextActive(ctx)) return;
      deps.setCompactionInProgress(false);
      if (typingStartedByObserver) deps.stopTypingLoop?.();
      typingStartedByObserver = false;
      deps.updateStatus(ctx);
      requestDispatch();
    },
    onSessionShutdown: () => {
      clearFallbackTimer();
      if (typingStartedByObserver) deps.stopTypingLoop?.();
      typingStartedByObserver = false;
    },
  };
}

export interface TelegramMessageActivityTypingDeps<TContext> {
  hasActiveTurn: () => boolean;
  startTypingLoop: (ctx: TContext) => void;
  onMessageStart: TelegramLifecycleRegistrationDeps["onMessageStart"];
  onMessageUpdate: TelegramLifecycleRegistrationDeps["onMessageUpdate"];
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramMessageActivityTypingHooks<
  TContext extends ExtensionContext,
>(
  deps: TelegramMessageActivityTypingDeps<TContext>,
): Pick<
  TelegramLifecycleRegistrationDeps,
  "onMessageStart" | "onMessageUpdate"
> {
  const ensureTyping = (ctx: TContext): void => {
    if (deps.hasActiveTurn()) deps.startTypingLoop(ctx);
  };
  const handleMessageActivity = async <TEvent>(
    phase: "start" | "update",
    event: TEvent,
    ctx: ExtensionContext,
    inner: (event: TEvent, ctx: ExtensionContext) => Promise<void>,
  ): Promise<void> => {
    const typedCtx = ctx as TContext;
    ensureTyping(typedCtx);
    try {
      await inner(event, ctx);
    } catch (error) {
      deps.recordRuntimeEvent?.("message-activity", error, { phase });
    } finally {
      ensureTyping(typedCtx);
    }
  };
  return {
    onMessageStart: (event, ctx) =>
      handleMessageActivity("start", event, ctx, deps.onMessageStart),
    onMessageUpdate: (event, ctx) =>
      handleMessageActivity("update", event, ctx, deps.onMessageUpdate),
  };
}

export function createDedupAgentStartHook(
  dedup: { reset(): void },
  inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>,
): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void> {
  return async (event, ctx) => {
    dedup.reset();
    await inner(event, ctx);
  };
}

export interface TelegramExtraLifecycleHooks {
  onSessionStart?: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
  onSessionShutdown?: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => Promise<void>;
}

export function appendTelegramLifecycleHooks(
  base: TelegramSessionLifecycleHooks,
  extra: TelegramExtraLifecycleHooks,
  isSessionActive?: (ctx: ExtensionContext) => boolean,
): TelegramSessionLifecycleHooks {
  return {
    onSessionStart: async (event, ctx) => {
      await base.onSessionStart(event, ctx);
      if (isSessionActive?.(ctx) === false) return;
      await extra.onSessionStart?.(event, ctx);
    },
    onSessionShutdown: async (event, ctx) => {
      await base.onSessionShutdown(event, ctx);
      if (isSessionActive?.(ctx) === false) return;
      await extra.onSessionShutdown?.(event, ctx);
    },
  };
}

export function registerTelegramLifecycleHooks(
  pi: ExtensionAPI,
  deps: TelegramLifecycleRegistrationDeps,
): void {
  const isActive = (ctx: ExtensionContext): boolean =>
    deps.isSessionActive?.(ctx) !== false;
  const settleFallbackDelayMs =
    deps.agentSettledFallbackDelayMs ??
    TELEGRAM_AGENT_SETTLED_FALLBACK_DELAY_MS;
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ??
    ((timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer));
  let pendingSettle:
    | { event: AgentSettledEvent; ctx: ExtensionContext }
    | undefined;
  let settleFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let reportedMissingAgentSettled = false;
  const disarmSettleFallback = (): void => {
    pendingSettle = undefined;
    if (!settleFallbackTimer) return;
    clearTimer(settleFallbackTimer);
    settleFallbackTimer = undefined;
  };
  const takePendingSettle = ():
    | { event: AgentSettledEvent; ctx: ExtensionContext }
    | undefined => {
    const pending = pendingSettle;
    pendingSettle = undefined;
    return pending;
  };
  const armSettleFallback = (ctx: ExtensionContext): void => {
    if (!deps.onAgentSettled) return;
    if (settleFallbackTimer) clearTimer(settleFallbackTimer);
    pendingSettle = { event: {} as AgentSettledEvent, ctx };
    const timer = setTimer(() => {
      settleFallbackTimer = undefined;
      const pending = takePendingSettle();
      if (!pending) return;
      if (!isActive(pending.ctx)) return;
      void (async () => {
        try {
          if (!reportedMissingAgentSettled) {
            reportedMissingAgentSettled = true;
            deps.recordRuntimeEvent?.(
              "session",
              new Error(
                "Host never emitted agent_settled; Telegram turns settle from the lifecycle fallback",
              ),
              { phase: "agent-settled-fallback-engaged" },
            );
          }
          await deps.onAgentSettled?.(pending.event, pending.ctx);
        } catch (error) {
          try {
            deps.recordRuntimeEvent?.("session", error, {
              phase: "agent-settled-fallback-failed",
            });
          } catch {}
        }
      })();
    }, settleFallbackDelayMs);
    timer.unref?.();
    settleFallbackTimer = timer;
  };
  pi.on("input", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onInput?.(event, ctx);
  });
  pi.on("session_start", async (event, ctx) => {
    await deps.onSessionStart(event, ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    disarmSettleFallback();
    await deps.onSessionShutdown(event, ctx);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onSessionBeforeCompact?.(event, ctx);
  });
  pi.on("session_compact", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onSessionCompact?.(event, ctx);
  });
  // The Pi SDK still types this result as a string; compatible runtimes may
  // preserve ordered system prompt blocks through the same public hook.
  const registerBeforeAgentStart = pi.on.bind(pi) as unknown as (
    event: "before_agent_start",
    handler: (
      event: TelegramBeforeAgentStartEvent,
      ctx: ExtensionContext,
    ) => TelegramBeforeAgentStartReturn,
  ) => void;
  registerBeforeAgentStart("before_agent_start", async (event, ctx) => {
    return deps.onBeforeAgentStart(event, ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onModelSelect(event, ctx);
  });
  pi.on("agent_start", async (event, ctx) => {
    disarmSettleFallback();
    if (!isActive(ctx)) return;
    await deps.onAgentStart(event, ctx);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onToolExecutionStart(event, ctx);
  });
  pi.on("tool_execution_update", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onToolExecutionUpdate?.(event, ctx);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onToolExecutionEnd(event, ctx);
  });
  pi.on("message_start", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onMessageStart(event, ctx);
  });
  pi.on("message_update", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onMessageUpdate(event, ctx);
  });
  pi.on("agent_end", async (event, ctx) => {
    if (!isActive(ctx)) return;
    await deps.onAgentEnd(event, ctx);
    armSettleFallback(ctx);
  });
  pi.on("agent_settled", async (event, ctx) => {
    disarmSettleFallback();
    if (!isActive(ctx)) return;
    await deps.onAgentSettled?.(event, ctx);
  });
}
