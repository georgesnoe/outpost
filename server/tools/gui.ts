import { spawnSync } from "node:child_process";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ANNOTATIONS,
  IS_MACOS,
  IS_WINDOWS,
  auditAction,
  executeTool,
  imageResult,
  jsonResult,
  ok,
  powershell,
  runCapture,
  type ToolContext,
} from "~/tools/shared";

/** Runs a PowerShell script and returns stdout, throwing on failure. */
async function ps(script: string): Promise<string> {
  const [command, args] = powershell(script);
  const result = await runCapture(command, args, 15_000, 2_000_000);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || `PowerShell exited with ${result.code}`,
    );
  }
  return result.stdout.trim();
}

const MOUSE_PInvoke = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OutpostMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
}
'@
`;

function sendKeysLiteral(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\n") out += "{ENTER}";
    else if (char === "\r") continue;
    else if ("+^%~(){}[]".includes(char)) out += `{${char}}`;
    else out += char;
  }
  return out;
}

const KEY_MAP: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  esc: "{ESC}",
  escape: "{ESC}",
  tab: "{TAB}",
  backspace: "{BACKSPACE}",
  delete: "{DEL}",
  del: "{DEL}",
  space: " ",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  insert: "{INSERT}",
  capture: "{PRTSC}",
  f1: "{F1}",
  f2: "{F2}",
  f3: "{F3}",
  f4: "{F4}",
  f5: "{F5}",
  f6: "{F6}",
  f7: "{F7}",
  f8: "{F8}",
  f9: "{F9}",
  f10: "{F10}",
  f11: "{F11}",
  f12: "{F12}",
};

function keyToken(key: string): string {
  const normalized = key.trim().toLowerCase();
  return KEY_MAP[normalized] ?? key.trim();
}

export async function mouseMove(x: number, y: number): Promise<void> {
  if (IS_WINDOWS) {
    await ps(
      `${MOUSE_PInvoke}[OutpostMouse]::SetCursorPos(${x}, ${y}) | Out-Null`,
    );
    return;
  }
  if (IS_MACOS) {
    await runCommand("cliclick", [`m:${x},${y}`]);
    return;
  }
  await runCommand("xdotool", ["mousemove", String(x), String(y)]);
}

export async function mouseClick(
  x: number | undefined,
  y: number | undefined,
  button: "left" | "right" | "middle",
  clicks: number,
): Promise<void> {
  if (IS_WINDOWS) {
    const down =
      button === "right" ? 0x0008 : button === "middle" ? 0x0020 : 0x0002;
    const up =
      button === "right" ? 0x0010 : button === "middle" ? 0x0040 : 0x0004;
    const position =
      x !== undefined && y !== undefined
        ? `[OutpostMouse]::SetCursorPos(${x}, ${y}) | Out-Null; `
        : "";
    let script = MOUSE_PInvoke + position;
    for (let i = 0; i < clicks; i += 1) {
      script += `[OutpostMouse]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero); `;
      script += `[OutpostMouse]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero); `;
      if (i < clicks - 1) script += "Start-Sleep -Milliseconds 80; ";
    }
    await ps(script);
    return;
  }
  if (IS_MACOS) {
    const flag = button === "right" ? "rc" : button === "middle" ? "mc" : "c";
    const parts = [...Array(clicks)].map(() => flag);
    const args = [
      ...(x !== undefined && y !== undefined ? [`m:${x},${y}`] : []),
      ...parts,
    ];
    await runCommand("cliclick", args);
    return;
  }
  const args =
    x !== undefined && y !== undefined
      ? [
          "mousemove",
          String(x),
          String(y),
          "click",
          String(button === "right" ? 3 : button === "middle" ? 2 : 1),
        ]
      : [
          "click",
          "--repeat",
          String(clicks),
          "--delay",
          "80",
          String(button === "right" ? 3 : button === "middle" ? 2 : 1),
        ];
  await runCommand("xdotool", args);
}

async function mouseScroll(
  delta: number,
  x?: number,
  y?: number,
): Promise<void> {
  if (x !== undefined && y !== undefined) await mouseMove(x, y);
  if (IS_WINDOWS) {
    await ps(
      `${MOUSE_PInvoke}[OutpostMouse]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)`,
    );
    return;
  }
  if (IS_MACOS) {
    const clicks = Math.max(1, Math.round(Math.abs(delta) / 120));
    const direction = delta > 0 ? "scroll up" : "scroll down";
    await runCommand(
      "cliclick",
      [...Array(clicks)].map(() => direction),
    );
    return;
  }
  await runCommand("xdotool", ["click", String(delta > 0 ? 4 : 5)]);
}

export async function mouseDrag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  button: "left" | "right",
): Promise<void> {
  await mouseMove(fromX, fromY);
  if (IS_WINDOWS) {
    const down = button === "right" ? 0x0008 : 0x0002;
    const up = button === "right" ? 0x0010 : 0x0004;
    const script = `${MOUSE_PInvoke}
[OutpostMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)
foreach ($i in 1..10) {{
  $x = [int](${fromX} + (${toX} - ${fromX}) * $i / 10)
  $y = [int](${fromY} + (${toY} - ${fromY}) * $i / 10)
  [OutpostMouse]::SetCursorPos($x,$y) | Out-Null
  Start-Sleep -Milliseconds 15
}}
[OutpostMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
    await ps(script);
    return;
  }
  if (IS_MACOS) {
    const down = button === "right" ? "rd" : "ld";
    const up = button === "right" ? "ru" : "lu";
    await runCommand("cliclick", [
      `m:${fromX},${fromY}`,
      down,
      `m:${toX},${toY}`,
      up,
    ]);
    return;
  }
  await runCommand("xdotool", [
    "mousemove",
    String(fromX),
    String(fromY),
    "mousedown",
    String(button === "right" ? 3 : 1),
    "mousemove",
    String(toX),
    String(toY),
    "mouseup",
    String(button === "right" ? 3 : 1),
  ]);
}

export async function keyboardType(text: string): Promise<void> {
  if (IS_WINDOWS) {
    await ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysLiteral(text).replace(/'/g, "''")}')`,
    );
    return;
  }
  if (IS_MACOS) {
    await runCommand("osascript", [
      "-e",
      `tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"`,
    ]);
    return;
  }
  await runCommand("xdotool", [
    "type",
    "--clearmodifiers",
    "--delay",
    "12",
    text,
  ]);
}

export async function keyboardPress(key: string): Promise<void> {
  const token = keyToken(key);
  if (IS_WINDOWS) {
    await ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${token.replace(/'/g, "''")}')`,
    );
    return;
  }
  if (IS_MACOS) {
    const name = token.replace(/[{}]/g, "").toLowerCase();
    await runCommand("osascript", [
      "-e",
      `tell application "System Events" to key code ${macKeyCode(name)}`,
    ]);
    return;
  }
  await runCommand("xdotool", [
    "key",
    token.replace(/[{}]/g, "").toLowerCase(),
  ]);
}

function macKeyCode(name: string): number {
  const codes: Record<string, number> = {
    enter: 36,
    return: 36,
    esc: 53,
    escape: 53,
    tab: 48,
    backspace: 51,
    delete: 118,
    del: 118,
    space: 49,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    home: 115,
    end: 119,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };
  return codes[name] ?? 0;
}

export async function keyboardHotkey(combo: string): Promise<void> {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts[parts.length - 1] ?? "";
  const modifiers = parts.slice(0, -1);

  if (IS_WINDOWS) {
    let prefix = "";
    if (modifiers.includes("ctrl") || modifiers.includes("control"))
      prefix += "^";
    if (modifiers.includes("alt")) prefix += "%";
    if (modifiers.includes("shift")) prefix += "+";
    const windowsKey = modifiers.includes("win") || modifiers.includes("super");
    if (windowsKey) {
      await ps(`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OutpostKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }
'@
[OutpostKeys]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)`);
    }
    await ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${keyToken(key).replace(/'/g, "''")}')`,
    );
    if (windowsKey) {
      await ps(`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OutpostKeys2 { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }
'@
[OutpostKeys2]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`);
    }
    return;
  }
  if (IS_MACOS) {
    const maps: Record<string, string> = {
      ctrl: "control",
      control: "control",
      alt: "option",
      shift: "shift",
      cmd: "command",
      win: "command",
    };
    const mods = modifiers.map((m) => maps[m] ?? m).join(", ");
    await runCommand("osascript", [
      "-e",
      `tell application "System Events" to keystroke "${key}"${mods ? ` using {${mods}}` : ""}`,
    ]);
    return;
  }
  const names: Record<string, string> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    shift: "shift",
    win: "super",
    super: "super",
  };
  const args = [
    ...modifiers.map((m) => names[m] ?? m),
    keyToken(key).replace(/[{}]/g, "").toLowerCase(),
  ];
  await runCommand("xdotool", ["key", ...args]);
}

export async function screenshotBase64(): Promise<string> {
  if (IS_WINDOWS) {
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`;
    const output = await ps(script);
    return output.replace(/\s+/g, "");
  }
  if (IS_MACOS) {
    const file = `${process.env.TMPDIR ?? "/tmp"}/outpost-shot-${Date.now()}.png`;
    await runCommand("screencapture", ["-x", file]);
    const { readFileSync, unlinkSync } = await import("node:fs");
    const data = readFileSync(file).toString("base64");
    unlinkSync(file);
    return data;
  }
  const file = `/tmp/outpost-shot-${Date.now()}.png`;
  const tool = commandExists("scrot") ? "scrot" : "import";
  const args = tool === "scrot" ? [file] : ["-window", "root", file];
  await runCommand(tool, args);
  const { readFileSync, unlinkSync } = await import("node:fs");
  const data = readFileSync(file).toString("base64");
  unlinkSync(file);
  return data;
}

async function screenInfo(): Promise<Record<string, unknown>> {
  if (IS_WINDOWS) {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$out = @()
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $out += [pscustomobject]@{
    device = $s.DeviceName; primary = $s.Primary
    width = $s.Bounds.Width; height = $s.Bounds.Height
    left = $s.Bounds.Left; top = $s.Bounds.Top
    workingWidth = $s.WorkingArea.Width; workingHeight = $s.WorkingArea.Height
  }
}
$out | ConvertTo-Json -Compress
`;
    const text = await ps(script);
    return JSON.parse(text || "[]");
  }
  if (IS_MACOS) {
    const result = await runCapture(
      "system_profiler",
      ["SPDisplaysDataType"],
      15_000,
    );
    return { platform: "darwin", displays: result.stdout.trim() };
  }
  const result = await runCapture("xrandr", ["--current"], 10_000);
  return { platform: "linux", displays: result.stdout.trim() };
}

export async function activeWindow(): Promise<Record<string, unknown>> {
  if (IS_WINDOWS) {
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OutpostWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$h = [OutpostWindow]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][OutpostWindow]::GetWindowText($h, $sb, 512)
$pid = 0
[void][OutpostWindow]::GetWindowThreadProcessId($h, [ref]$pid)
[pscustomobject]@{ title = $sb.ToString(); pid = $pid } | ConvertTo-Json -Compress
`;
    const text = await ps(script);
    const info = JSON.parse(text || "{}") as { title?: string; pid?: number };
    let processName = "";
    if (info.pid) {
      const procScript = `try { (Get-Process -Id ${info.pid} -ErrorAction Stop).ProcessName } catch { '' }`;
      const [pc, pa] = powershell(procScript);
      const proc = spawnSync(pc, pa, { encoding: "utf8" });
      processName = (proc.stdout || "").trim().split(/\r?\n/)[0] ?? "";
    }
    return { ...info, process: processName };
  }
  if (IS_MACOS) {
    const script = `tell application "System Events" to get name of first application process whose frontmost is true`;
    const result = await runCapture("osascript", ["-e", script]);
    return { title: result.stdout.trim(), platform: "darwin" };
  }
  const result = await runCapture("xdotool", [
    "getactivewindow",
    "getwindowname",
  ]);
  return { title: result.stdout.trim(), platform: "linux" };
}

async function cursorPosition(): Promise<{ x: number; y: number }> {
  if (IS_WINDOWS) {
    const text = await ps(
      `Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"`,
    );
    const [x, y] = text.split(",").map(Number);
    return { x, y };
  }
  if (IS_MACOS) {
    const result = await runCapture("cliclick", ["p"]);
    const match = result.stdout.match(/(\d+),(\d+)/);
    return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
  }
  const result = await runCapture("xdotool", ["getmouselocation", "--shell"]);
  const x = Number(result.stdout.match(/X=(\d+)/)?.[1] ?? 0);
  const y = Number(result.stdout.match(/Y=(\d+)/)?.[1] ?? 0);
  return { x, y };
}

function commandExists(command: string): boolean {
  const result = spawnSync(IS_WINDOWS ? "where" : "which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const result = await runCapture(command, args, 15_000, 2_000_000);
  if (result.code !== 0) {
    throw new Error(
      `${command}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
}

const coordinateSchema = {
  x: z.number().int().describe("Screen X coordinate in pixels"),
  y: z.number().int().describe("Screen Y coordinate in pixels"),
};

export function registerGuiTools(
  server: McpServer,
  context?: ToolContext,
): void {
  server.registerTool(
    "mouse_move",
    {
      title: "Move Mouse",
      description: "Move the cursor to an absolute screen coordinate.",
      inputSchema: z.object(coordinateSchema),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "mouse_move",
        args,
        async () => {
          await mouseMove(args.x, args.y);
          return ok(`Moved cursor to ${args.x},${args.y}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "mouse_click",
    {
      title: "Click Mouse",
      description:
        "Click at the current cursor position or at given coordinates.",
      inputSchema: z.object({
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        button: z.enum(["left", "right", "middle"]).default("left"),
        clicks: z
          .number()
          .int()
          .positive()
          .max(5)
          .default(1)
          .describe("Number of clicks (e.g. 2 for double-click)"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "mouse_click",
        args,
        async () => {
          await mouseClick(args.x, args.y, args.button, args.clicks);
          return ok(`Clicked ${args.button} ${args.clicks} time(s).`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "mouse_scroll",
    {
      title: "Scroll Mouse Wheel",
      description:
        "Scroll the mouse wheel; positive delta scrolls up, negative down.",
      inputSchema: z.object({
        delta: z
          .number()
          .int()
          .refine((v) => v !== 0, "delta must not be zero")
          .describe("Wheel delta, e.g. 120 or -120"),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "mouse_scroll",
        args,
        async () => {
          await mouseScroll(args.delta, args.x, args.y);
          return ok(`Scrolled by ${args.delta}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "mouse_drag",
    {
      title: "Drag Mouse",
      description: "Drag from one screen coordinate to another.",
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
        "mouse_drag",
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
    "keyboard_type",
    {
      title: "Type Text",
      description: "Type text into the focused window using the OS keyboard.",
      inputSchema: z.object({ text: z.string().describe("Text to type") }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "keyboard_type",
        args,
        async () => {
          await keyboardType(args.text);
          return ok(`Typed ${args.text.length} characters.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "keyboard_press",
    {
      title: "Press Key",
      description:
        "Press a single key (enter, esc, tab, arrow keys, F1-F12, ...).",
      inputSchema: z.object({ key: z.string().min(1).describe("Key name") }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "keyboard_press",
        args,
        async () => {
          await keyboardPress(args.key);
          return ok(`Pressed ${args.key}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "keyboard_hotkey",
    {
      title: "Press Hotkey",
      description: "Press a key combination, e.g. ctrl+shift+a or alt+f4.",
      inputSchema: z.object({
        combo: z
          .string()
          .min(1)
          .describe("Combination such as ctrl+c, win+r, ctrl+alt+delete"),
      }),
      annotations: ANNOTATIONS.write,
    },
    async (args) =>
      executeTool(
        "keyboard_hotkey",
        args,
        async () => {
          await keyboardHotkey(args.combo);
          return ok(`Pressed ${args.combo}.`);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Take Screenshot",
      description:
        "Capture the whole virtual screen and return it as an MCP image the agent can see.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "screenshot",
        {},
        async () => {
          const data = await screenshotBase64();
          auditAction("screenshot", context);
          return imageResult(data, "image/png");
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "get_screen_info",
    {
      title: "Get Screen Info",
      description: "Report connected displays, resolutions and work areas.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "get_screen_info",
        {},
        async () => {
          const info = await screenInfo();
          return jsonResult(info);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "get_active_window",
    {
      title: "Get Active Window",
      description: "Report the foreground window title and owning process.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "get_active_window",
        {},
        async () => {
          const info = await activeWindow();
          return jsonResult(info);
        },
        context?.ip ?? null,
      ),
  );

  server.registerTool(
    "get_cursor_position",
    {
      title: "Get Cursor Position",
      description: "Report the current mouse cursor coordinates.",
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.read,
    },
    async () =>
      executeTool(
        "get_cursor_position",
        {},
        async () => {
          return jsonResult(await cursorPosition());
        },
        context?.ip ?? null,
      ),
  );
}
