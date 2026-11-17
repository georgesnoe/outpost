import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  IS_WINDOWS,
  IS_MACOS,
  executeTool,
  imageResult,
  jsonResult,
  ok,
  powershell,
  runCapture,
  runWithInput,
  type ToolContext,
} from "~/tools/shared";
import {
  activeWindow,
  keyboardHotkey,
  keyboardPress,
  keyboardType,
  mouseClick,
  mouseDrag,
  screenshotBase64,
} from "~/tools/gui";

/** Opens a URL with the operating system's default browser. */
async function openInDefaultBrowser(url: string): Promise<void> {
  let result;
  if (IS_WINDOWS) {
    const escaped = url.replace(/'/g, "''");
    const [command, args] = powershell(`Start-Process '${escaped}'`);
    result = await runCapture(command, args, 10_000);
  } else if (IS_MACOS) {
    result = await runCapture("open", [url], 10_000);
  } else {
    result = await runCapture("xdg-open", [url], 10_000);
  }
  if (result.code !== 0) {
    throw new Error(
      `Could not open browser: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
}

async function readClipboard(): Promise<string> {
  const [command, args] = IS_WINDOWS
    ? powershell("Get-Clipboard -Raw")
    : IS_MACOS
      ? ["pbpaste", []]
      : ["xclip", ["-selection", "clipboard", "-o"]];
  const result = await runCapture(command, args, 5_000);
  return result.stdout;
}

async function writeClipboard(text: string): Promise<void> {
  if (IS_WINDOWS) {
    const [command, args] = powershell(
      "$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t",
    );
    const result = await runWithInput(command, args, text, 5_000);
    if (result.code !== 0) throw new Error(result.stderr.trim());
    return;
  }
  const command = IS_MACOS ? "pbcopy" : "xclip";
  const args = IS_MACOS ? [] : ["-selection", "clipboard"];
  const result = await runWithInput(command, args, text, 5_000);
  if (result.code !== 0) throw new Error(result.stderr.trim());
}

/** Reads the current tab URL via the address bar, preserving the clipboard. */
async function currentUrl(): Promise<string> {
  let previous = "";
  try {
    previous = await readClipboard();
  } catch {
    // Clipboard might be unavailable; still try to read the URL.
  }

  await keyboardHotkey("ctrl+l");
  await new Promise((done) => setTimeout(done, 150));
  await keyboardHotkey("ctrl+c");
  await new Promise((done) => setTimeout(done, 150));
  const url = (await readClipboard()).trim();
  await keyboardPress("esc");

  if (previous) {
    try {
      await writeClipboard(previous);
    } catch {
      // Best effort restore.
    }
  }
  return url;
}

/** Enumerates tabs using UI Automation, falling back to browser window titles. */
async function listTabs(): Promise<Record<string, unknown>[]> {
  if (IS_WINDOWS) {
    const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = @()
  for ($i = 0; $i -lt $tabs.Count; $i++) { $out += [pscustomobject]@{ index = $i + 1; title = $tabs.Item($i).Current.Name; source = "ui-automation" } }
  $out | ConvertTo-Json -Compress
} catch { '' }
`;
    const [command, args] = powershell(script);
    const result = await runCapture(command, args, 20_000);
    try {
      const parsed = JSON.parse(result.stdout.trim() || "[]");
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // Fall through to window titles.
    }

    const procScript = `
Get-Process | Where-Object { $_.ProcessName -match 'msedge|chrome|firefox|brave|opera' -and $_.MainWindowTitle } |
  Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress
`;
    const [pc, pa] = powershell(procScript);
    const procResult = await runCapture(pc, pa, 10_000);
    try {
      const parsed = JSON.parse(procResult.stdout.trim() || "[]") as Record<
        string,
        unknown
      >[];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items.map((item, index) => ({
        index: index + 1,
        title: item.MainWindowTitle ?? "",
        process: item.ProcessName ?? "",
        pid: item.Id ?? null,
        source: "window-title",
      }));
    } catch {
      return [];
    }
  }

  if (IS_MACOS) {
    const script = `tell application "System Events" to get name of every window of (first application process whose frontmost is true)`;
    const result = await runCapture("osascript", ["-e", script]);
    return result.stdout.split(",").map((title, index) => ({
      index: index + 1,
      title: title.trim().replace(/^"|"$/g, ""),
      source: "window-title",
    }));
  }

  const result = await runCapture("wmctrl", ["-l"]);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => ({
      index: index + 1,
      title: line.replace(/^\S+\s+\S+\s+\S+\s+/, ""),
      source: "window-title",
    }));
}

async function switchTab(target: {
  index?: number;
  title?: string;
}): Promise<string> {
  if (target.index !== undefined) {
    if (target.index < 1 || target.index > 9) {
      throw new Error("Tab index must be between 1 and 9.");
    }
    await keyboardHotkey(`ctrl+${target.index}`);
    return `Switched to tab ${target.index}.`;
  }
  if (target.title) {
    const tabs = await listTabs();
    const match = tabs.find((tab) =>
      String(tab.title ?? "")
        .toLowerCase()
        .includes(target.title!.toLowerCase()),
    );
    if (!match) throw new Error(`No tab matching "${target.title}" was found.`);
    const index = Number(match.index);
    if (index >= 1 && index <= 9) await keyboardHotkey(`ctrl+${index}`);
    else {
      for (let i = 1; i < index; i += 1) await keyboardHotkey("ctrl+tab");
    }
    return `Switched to tab ${index}: ${String(match.title ?? "")}`;
  }
  throw new Error("Provide either tab index or title.");
}

export function registerBrowserTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate Browser",
      description:
        "Open a URL in the system's default browser (Edge, Chrome, Firefox, ...).",
      inputSchema: z.object({
        url: z.string().url().describe("Absolute URL to open"),
      }),
      annotations: ANNOTATIONS.open,
    },
    async (args) =>
      executeTool(
        "browser_navigate",
        args,
        async () => {
          await openInDefaultBrowser(args.url);
          return ok(`Opened ${args.url} in the default browser.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_get_info",
    {
      title: "Get Browser Info",
      description:
        "Report the active window title, process and current tab URL.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "browser_get_info",
        {},
        async () => {
          const window = await activeWindow();
          const url = await currentUrl().catch(() => "");
          return jsonResult({ ...window, url });
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_get_tabs",
    {
      title: "Get Browser Tabs",
      description: "List open tabs in the foreground browser.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "browser_get_tabs",
        {},
        async () => jsonResult({ tabs: await listTabs() }),
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_switch_tab",
    {
      title: "Switch Browser Tab",
      description: "Switch to a tab by 1-based index or by title substring.",
      inputSchema: z.object({
        index: z.number().int().positive().optional(),
        title: z.string().optional(),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "browser_switch_tab",
        args,
        async () => ok(await switchTab(args)),
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click in Browser",
      description: "Click at screen coordinates in the browser window.",
      inputSchema: z.object({
        x: z.number().int(),
        y: z.number().int(),
        button: z.enum(["left", "right", "middle"]).default("left"),
        clicks: z.number().int().positive().max(5).default(1),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "browser_click",
        args,
        async () => {
          await mouseClick(args.x, args.y, args.button, args.clicks);
          return ok(`Clicked ${args.button} at ${args.x},${args.y}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type in Browser",
      description: "Type text into the focused browser element.",
      inputSchema: z.object({ text: z.string() }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "browser_type",
        args,
        async () => {
          await keyboardType(args.text);
          return ok(`Typed ${args.text.length} characters.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_press",
    {
      title: "Press Key in Browser",
      description: "Press a key in the browser (enter, esc, tab, arrows, ...).",
      inputSchema: z.object({ key: z.string().min(1) }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "browser_press",
        args,
        async () => {
          await keyboardPress(args.key);
          return ok(`Pressed ${args.key}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_drag",
    {
      title: "Drag in Browser",
      description:
        "Drag from one screen coordinate to another inside the browser.",
      inputSchema: z.object({
        fromX: z.number().int(),
        fromY: z.number().int(),
        toX: z.number().int(),
        toY: z.number().int(),
        button: z.enum(["left", "right"]).default("left"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "browser_drag",
        args,
        async () => {
          await mouseDrag(
            args.fromX,
            args.fromY,
            args.toX,
            args.toY,
            args.button,
          );
          return ok(
            `Dragged from ${args.fromX},${args.fromY} to ${args.toX},${args.toY}.`,
          );
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Browser Screenshot",
      description:
        "Capture the screen and return it as an MCP image the agent can see.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "browser_screenshot",
        {},
        async () => imageResult(await screenshotBase64(), "image/png"),
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_back",
    {
      title: "Browser Back",
      description: "Navigate back in the active browser tab.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.write,
    },
    async () =>
      executeTool(
        "browser_back",
        {},
        async () => {
          await keyboardHotkey("alt+left");
          return ok("Navigated back.");
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "browser_forward",
    {
      title: "Browser Forward",
      description: "Navigate forward in the active browser tab.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.write,
    },
    async () =>
      executeTool(
        "browser_forward",
        {},
        async () => {
          await keyboardHotkey("alt+right");
          return ok("Navigated forward.");
        },
        context?.ip ?? null,
      ),
  );
}
