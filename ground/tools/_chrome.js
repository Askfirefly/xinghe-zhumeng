// _chrome.js — 跨平台找 Chrome / Chromium（macOS / Windows / Linux）
//
// 用法：
//   const { chrome, args } = require('./_chrome');
//   spawn(chrome, [...args, '--remote-debugging-port=9222', 'about:blank'])
//
// 优先级：环境变量 CHROME_BIN → Playwright 缓存 → 系统安装路径
const fs = require('fs');
const path = require('path');
const os = require('os');

function exists(p) { try { return !!p && fs.existsSync(p); } catch (e) { return false; } }

function candidates() {
  const list = [];
  if (process.env.CHROME_BIN) list.push(process.env.CHROME_BIN);

  const plat = process.platform;
  if (plat === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    list.push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    if (exists(cache)) {
      for (const d of fs.readdirSync(cache)) {
        if (!d.startsWith('chromium')) continue;
        list.push(path.join(cache, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
        list.push(path.join(cache, d, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'));
      }
    }
  } else if (plat === 'win32') {
    const lad = process.env.LOCALAPPDATA || '';
    list.push(path.join(process.env['PROGRAMFILES'] || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'));
    list.push(path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'));
    list.push(path.join(lad, 'Google/Chrome/Application/chrome.exe'));
    const pw = path.join(lad, 'ms-playwright');
    if (exists(pw)) {
      for (const d of fs.readdirSync(pw)) {
        if (!d.startsWith('chromium')) continue;
        list.push(path.join(pw, d, 'chrome-headless-shell-win64/chrome-headless-shell.exe'));
        list.push(path.join(pw, d, 'chrome-win/chrome.exe'));
      }
    }
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
    const cache = path.join(os.homedir(), '.cache/ms-playwright');
    if (exists(cache)) {
      for (const d of fs.readdirSync(cache)) {
        if (!d.startsWith('chromium')) continue;
        list.push(path.join(cache, d, 'chrome-linux/chrome'));
        list.push(path.join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell'));
      }
    }
  }
  return list;
}

const chrome = candidates().find(exists);

// 平台相关启动参数：Windows 上强制用独显；macOS 不加这些（会报未知开关）
const args = ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars'];
if (process.platform === 'win32') {
  args.push('--use-angle=d3d11', '--force_high_performance_gpu');
}

if (!chrome) {
  console.error([
    '找不到 Chrome/Chromium。三种办法任选：',
    '  1) 装 Google Chrome（macOS 默认路径 /Applications/Google Chrome.app）',
    '  2) 用 Playwright 装：npx playwright install chromium',
    '  3) 指定路径：CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/eval_shot.js ...'
  ].join('\n'));
  process.exit(2);
}

module.exports = { chrome, args };
