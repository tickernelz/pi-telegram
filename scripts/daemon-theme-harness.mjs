import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const BASELINE_SHA = "84a7acc5c4a244f6e33ba97132353010bc95ce7e";
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

const hostTheme = new Proxy(
  {},
  {
    get(_target, prop) {
      const t = globalThis[THEME_KEY];
      if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
      return t[prop];
    },
  },
);

function createDaemonUiContext() {
  const calls = { notify: [], confirm: [], setStatus: [] };
  const ctx = {
    cwd: "/repo",
    ui: {
      notify: (message, kind) => {
        calls.notify.push({ message, kind });
      },
      confirm: async (title, message) => {
        calls.confirm.push({ title, message });
        return false;
      },
      setStatus: (key, text) => {
        calls.setStatus.push({ key, text });
      },
      get theme() {
        return hostTheme;
      },
    },
  };
  return { ctx, calls };
}

function createCommandRegistry() {
  const commands = new Map();
  const api = {
    registerCommand: (name, definition) => {
      commands.set(name, definition);
    },
  };
  return { api, commands };
}

async function captureThrow(run) {
  try {
    await run();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadTree(root) {
  const commands = await import(pathToFileURL(join(root, "lib", "commands.ts")).href);
  const status = await import(pathToFileURL(join(root, "lib", "status.ts")).href);
  return { commands, status };
}

async function scenarioTakeover(tree) {
  const { api, commands } = createCommandRegistry();
  const { ctx, calls } = createDaemonUiContext();
  tree.commands.registerTelegramBridgeCommands(api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async (_ctx, options) =>
      options?.force
        ? { ok: true, message: "connected" }
        : { ok: false, canTakeover: true, owner: "pid 42", message: "active elsewhere" },
    stopPolling: async () => undefined,
    updateStatus: () => {},
  });
  const outcome = await captureThrow(() =>
    commands.get("telegram-connect").handler("", ctx),
  );
  return { ...outcome, calls };
}

async function scenarioDisconnect(tree) {
  const { api, commands } = createCommandRegistry();
  const { ctx, calls } = createDaemonUiContext();
  tree.commands.registerTelegramBridgeCommands(api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => "stopped",
    getDisconnectThreadName: () => "Cinder",
    updateStatus: () => {},
  });
  const outcome = await captureThrow(() =>
    commands.get("telegram-disconnect").handler("", ctx),
  );
  return { ...outcome, calls };
}

async function scenarioStatusBar(tree) {
  const { ctx, calls } = createDaemonUiContext();
  const runtime = tree.status.createTelegramStatusRuntime({
    getStatusBarState: () => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    getBridgeStatusLineState: () => ({
      botUsername: undefined,
      allowedUserId: undefined,
      lockState: "active here",
      pollingActive: false,
      lastUpdateId: undefined,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  const outcome = await captureThrow(async () => runtime.updateStatus(ctx));
  return { ...outcome, calls };
}

async function runScenarios(root) {
  const tree = await loadTree(root);
  return {
    takeover: await scenarioTakeover(tree),
    disconnect: await scenarioDisconnect(tree),
    statusBar: await scenarioStatusBar(tree),
  };
}

function materializeBaseline() {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-baseline-"));
  execFileSync("sh", [
    "-c",
    `git -C ${JSON.stringify(REPO_ROOT)} archive ${BASELINE_SHA} | tar -x -C ${JSON.stringify(dir)}`,
  ]);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}

function report(label, result) {
  console.log(`\n[${label}]`);
  for (const [name, value] of Object.entries(result)) {
    console.log(
      `  ${name}: threw=${value.threw} error=${JSON.stringify(value.error)}` +
        ` confirm=${JSON.stringify(value.calls.confirm)}` +
        ` setStatus=${JSON.stringify(value.calls.setStatus)}`,
    );
  }
}

const UNGUARDED_TITLE = 'ctx.ui.theme.fg("accent", "pi-telegram")';
const FIX_MARKER = "resolveTelegramTheme";

async function main() {
  const mode = process.argv[2] ?? "both";
  let failures = 0;
  const check = (name, run) => {
    try {
      run();
      console.log(`  PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let baselineDir;
  if (mode !== "current") {
    baselineDir = materializeBaseline();
    const baselineCommandsSource = readFileSync(join(baselineDir, "lib", "commands.ts"), "utf8");
    const baselineStatusSource = readFileSync(join(baselineDir, "lib", "status.ts"), "utf8");
    const baseline = await runScenarios(baselineDir);
    report(`baseline ${BASELINE_SHA.slice(0, 12)}`, baseline);
    console.log("\nNEGATIVE CONTROL (baseline must be broken)");
    check("baseline pin genuinely lacks the fix", () => {
      assert.ok(
        baselineCommandsSource.includes(UNGUARDED_TITLE),
        "baseline lib/commands.ts no longer contains the unguarded theme access; the pin is wrong",
      );
      assert.equal(
        baselineCommandsSource.includes(FIX_MARKER),
        false,
        "baseline lib/commands.ts already contains the fix; the pin is wrong",
      );
      assert.equal(
        baselineStatusSource.includes(FIX_MARKER),
        false,
        "baseline lib/status.ts already contains the fix; the pin is wrong",
      );
    });
    check("baseline /telegram-connect takeover throws on uninitialized theme", () => {
      assert.equal(baseline.takeover.threw, true);
      assert.match(baseline.takeover.error ?? "", /Theme not initialized/);
    });
    check("baseline /telegram-connect never opens the takeover dialog", () => {
      assert.deepEqual(baseline.takeover.calls.confirm, []);
    });
    check("baseline /telegram-disconnect throws on uninitialized theme", () => {
      assert.equal(baseline.disconnect.threw, true);
      assert.match(baseline.disconnect.error ?? "", /Theme not initialized/);
    });
    check("baseline /telegram-disconnect never opens the delete dialog", () => {
      assert.deepEqual(baseline.disconnect.calls.confirm, []);
    });
    check("baseline never stops polling because the dialog throws first", () => {
      assert.deepEqual(baseline.disconnect.calls.notify, []);
    });
    check("baseline status bar stays silent under a daemon theme", () => {
      assert.equal(baseline.statusBar.threw, false);
      assert.deepEqual(baseline.statusBar.calls.setStatus, []);
    });
  }

  if (mode !== "baseline") {
    const current = await runScenarios(REPO_ROOT);
    report("working tree", current);
    console.log("\nFIX ASSERTIONS (working tree must survive)");
    check("/telegram-connect takeover completes", () => {
      assert.equal(current.takeover.threw, false, current.takeover.error ?? "");
    });
    check("/telegram-connect opens a readable takeover dialog", () => {
      assert.equal(current.takeover.calls.confirm.length, 1);
      assert.equal(current.takeover.calls.confirm[0].title, "pi-telegram");
      assert.match(current.takeover.calls.confirm[0].message, /move singleton lock here\?/);
      assert.match(current.takeover.calls.confirm[0].message, /from: pid 42/);
      assert.match(current.takeover.calls.confirm[0].message, /to: \/repo/);
    });
    check("/telegram-disconnect completes", () => {
      assert.equal(current.disconnect.threw, false, current.disconnect.error ?? "");
    });
    check("/telegram-disconnect opens a readable delete dialog", () => {
      assert.equal(current.disconnect.calls.confirm.length, 1);
      assert.equal(current.disconnect.calls.confirm[0].title, "pi-telegram");
      assert.match(
        current.disconnect.calls.confirm[0].message,
        /^Delete Telegram thread Cinder and disconnect this Pi session\?$/,
      );
    });
    check("status bar renders plain text under a daemon theme", () => {
      assert.equal(current.statusBar.threw, false, current.statusBar.error ?? "");
      assert.equal(current.statusBar.calls.setStatus.length, 1);
      assert.equal(current.statusBar.calls.setStatus[0].key, "telegram");
      assert.match(current.statusBar.calls.setStatus[0].text, /telegram/);
      assert.equal(
        current.statusBar.calls.setStatus[0].text.includes("\u001b"),
        false,
      );
    });

    globalThis[THEME_KEY] = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    };
    const themed = await runScenarios(REPO_ROOT);
    delete globalThis[THEME_KEY];
    report("working tree with an initialized theme", themed);
    console.log("\nCOLOUR PRESERVATION (a real theme must still colour)");
    check("takeover dialog keeps theme colour when the theme exists", () => {
      assert.equal(themed.takeover.threw, false, themed.takeover.error ?? "");
      assert.equal(themed.takeover.calls.confirm[0].title, "<accent>pi-telegram</accent>");
      assert.match(
        themed.takeover.calls.confirm[0].message,
        /<warning>move singleton lock here\?<\/warning>/,
      );
    });
    check("disconnect dialog keeps theme colour when the theme exists", () => {
      assert.equal(themed.disconnect.calls.confirm[0].title, "<accent>pi-telegram</accent>");
      assert.match(
        themed.disconnect.calls.confirm[0].message,
        /<warning>Cinder<\/warning>/,
      );
    });
    check("status bar keeps theme colour when the theme exists", () => {
      assert.match(themed.statusBar.calls.setStatus[0].text, /<accent>telegram<\/accent>/);
    });
  }

  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "HARNESS OK" : `HARNESS FAILURES: ${failures}`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
