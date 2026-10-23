// Shared isolated Chrome lifecycle; callers own their CDP transport and signal handlers.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env["PROGRAMFILES"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
  }[process.platform];
  for (const c of candidates || []) if (c && existsSync(c)) return c;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error("没找到 Chrome、Chromium 或 Edge；安装其一，或用环境变量 CHROME_PATH 指定路径。");
}

export function createChrome({ timeoutMs = ms => ms, prefix = "oil-browser-", label = "browser" } = {}) {
  const chromePath = findChrome();
  let profile, chrome, handedOff;
  // 启动的那个进程不一定是真正的浏览器：有的版本把浏览器交给另一个进程后自己退出。
  // 所以关闭时先让浏览器自己退出，再按本次临时目录的名字找还活着的进程。
  function closeBrowser(ws) {
    return new Promise((ok) => {
      const socket = ws, timer = setTimeout(() => ok(false), 3000);
      socket.onerror = null; socket.onclose = () => { clearTimeout(timer); ok(true); };
      try { socket.send(JSON.stringify({ id: 2147483647, method: "Browser.close" })); } catch { clearTimeout(timer); ok(false); }
    });
  }
  function profileProcesses() {
    const name = basename(profile);
    if (process.platform === "win32") {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${name}') } | ForEach-Object { $_.ProcessId }`;
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000, windowsHide: true });
      return (r.stdout || "").split(/\s+/).map(Number).filter((pid) => pid && pid !== process.pid);
    }
    const r = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 10000 });
    return (r.stdout || "").split("\n").filter((line) => line.includes(name)).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid && pid !== process.pid);
  }
  function killProfileProcesses() {
    // 查两遍：第一遍之后才冒出来的子进程也要关掉。
    for (let pass = 0; pass < 2; pass++) {
      const pids = profileProcesses(); if (!pids.length) return;
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }
  function removeProfile(closed) {
    if (!profile) return;
    const remove = (maxRetries) => rmSync(profile, { recursive: true, force: true, maxRetries, retryDelay: 100 });
    try {
      // 浏览器不是启动的那个进程时，连接断开不等于它已经退出，等不到它的退出事件，直接按目录名收尾。
      if (!closed || handedOff) killProfileProcesses();
      try { remove(5); } catch { killProfileProcesses(); remove(10); }
    } catch (error) { console.error(`${label}：临时目录没删掉（${error.code || error.message}），可以稍后手动删除：${profile}`); }
    profile = undefined;
  }
  async function stopChrome(ws) {
    const closed = ws?.readyState === WebSocket.OPEN ? await closeBrowser(ws) : false;
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) await new Promise((ok) => {
      const timer = setTimeout(() => { chrome.kill("SIGKILL"); ok(); }, 3000);
      chrome.once("close", () => { clearTimeout(timer); ok(); }); chrome.kill();
    });
    removeProfile(closed);
  }
  async function launchChrome() {
    profile = mkdtempSync(join(tmpdir(), prefix)); handedOff = false;
    chrome = spawn(chromePath, ["--headless=new", "--enable-unsafe-swiftshader", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const portFile = join(profile, "DevToolsActivePort");
    const fromPortFile = () => {
      try {
        const [port, path] = readFileSync(portFile, "utf8").split("\n").map((line) => line.trim());
        return /^\d+$/.test(port) && path?.startsWith("/devtools/browser/") ? `ws://127.0.0.1:${port}${path}` : null;
      } catch { return null; }
    };
    return new Promise((ok, no) => {
      let buf = "", exited;
      const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs(45000));
      const poll = setInterval(() => { const url = fromPortFile(); if (url) finish(null, url); }, 100);
      const onData = (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) finish(null, m[1]); };
      const onError = (e) => finish(e);
      // 浏览器可能已经交给另一个进程，端口文件稍后才出现，所以不马上判失败。
      const onExit = () => { handedOff = true; exited = setTimeout(() => finish(new Error("浏览器提前退出")), timeoutMs(10000)); };
      function finish(error, url) {
        clearTimeout(timer); clearTimeout(exited); clearInterval(poll);
        chrome.stderr.off("data", onData); chrome.off("error", onError); chrome.off("exit", onExit);
        error ? no(error) : ok(url);
      }
      chrome.stderr.on("data", onData); chrome.once("error", onError); chrome.once("exit", onExit);
    });
  }
  return {
    launch: launchChrome,
    stop: stopChrome,
    tempFile(name) { return join(profile, name); },
    dispose() {
      try { chrome?.kill(); } catch {}
      removeProfile(false);
    },
  };
}
