#!/usr/bin/env node
/**
 * 币安带单员交易记录监控
 * 原理：用本机 Chrome 过一次 AWS WAF 挑战，之后在页面上下文里直接调币安公开的
 *      copy-trade 接口（无需登录），对比新旧订单，把新成交推到 Telegram。
 *
 * 用法：
 *   node monitor.js            持续监控
 *   node monitor.js --once     只抓一次，打印本批订单（不发 TG，除非 --push）
 *   node monitor.js --selftest 发一条测试消息到 TG
 */
'use strict';

// 本机访问 api.telegram.org 需要走系统代理（127.0.0.1:10808）。
// Node 的 fetch 默认不读系统代理，所以启动时自动带上环境变量重新拉起自己。
// 云端（GitHub Actions）直连 Telegram，不需要代理，用 MONITOR_NO_PROXY=1 跳过。
if (!process.env.NODE_USE_ENV_PROXY && !process.env.MONITOR_NO_PROXY) {
  const { spawnSync } = require('child_process');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:10808';
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
  });
  process.exit(r.status === null ? 1 : r.status);
}

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = process.env.MONITOR_STATE || path.join(ROOT, 'state.json');
const LOG_FILE = process.env.MONITOR_LOG || path.join(ROOT, 'monitor.log');
const PROFILE = process.env.MONITOR_PROFILE || path.join(ROOT, 'chrome-profile');
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');
const CHROME_PORT = Number(process.env.CHROME_PORT || 9360);
const PAGE_URL = `https://www.binance.com/zh-CN/copy-trading/lead-details/${CONFIG.portfolioId}?timeRange=30D`;
const API_ORDER = '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history';

// 敏感信息：优先环境变量（云端 Secrets），其次本地 secrets.json（git 忽略）
let SECRETS = {};
try { SECRETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets.json'), 'utf8')); } catch {}
const TG_TOKEN = process.env.TG_TOKEN || SECRETS.telegramToken || (CONFIG.telegram && CONFIG.telegram.token);
const TG_CHAT_ID = process.env.TG_CHAT_ID || SECRETS.telegramChatId || (CONFIG.telegram && CONFIG.telegram.chatId);

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes('--once');
const PUSH = ARGS.includes('--push');
const SELFTEST = ARGS.includes('--selftest');
const DURATION_SEC = (() => {
  const i = ARGS.indexOf('--duration');
  return i >= 0 ? Number(ARGS[i + 1]) : 0;
})();

// ---------- 日志 ----------
function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 浏览器 ----------
class Browser {
  constructor() {
    this.proc = null;
    this.ws = null;
    this.sessionId = null;
    this.msgId = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ready = false;
  }

  async start() {
    const extra = process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    this.proc = spawn(CHROME, [
      '--headless=new',
      '--disable-blink-features=AutomationControlled',
      ...extra,
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run', '--no-default-browser-check',
      '--window-size=1400,1600',
      'about:blank',
    ], { stdio: 'ignore' });

    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
        if (r.ok) ver = await r.json();
      } catch {}
      if (!ver) await sleep(250);
    }
    if (!ver) throw new Error('Chrome 调试端口未就绪');

    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onclose = () => { this.ready = false; };

    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Page.enable', {});
    await this.send('Network.enable', {});
    await this.send('Runtime.enable', {});
    return this;
  }

  _onMessage(ev) {
    const m = JSON.parse(ev.data);
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    for (const h of this.handlers) h(m);
  }

  send(method, params = {}, sessionId = this.sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evalPage(expression, awaitPromise = false) {
    const out = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (out.exceptionDetails) {
      throw new Error('页面脚本异常: ' + (out.exceptionDetails.text || '') + ' ' +
        (out.exceptionDetails.exception && out.exceptionDetails.exception.description || ''));
    }
    return out.result.value;
  }

  /** 打开详情页并等待渲染完成 */
  async openPage() {
    log('打开带单员页面…');
    await this.send('Page.navigate', { url: PAGE_URL });
    for (let i = 0; i < 20; i++) {
      await sleep(2500);
      let len = 0;
      try { len = await this.evalPage('document.body ? document.body.innerText.length : 0'); } catch {}
      if (len > 1000) {
        this.ready = true;
        log(`页面就绪（文本长度 ${len}）`);
        return true;
      }
    }
    this.ready = false;
    log('页面加载失败（WAF 挑战未通过）');
    return false;
  }

  /** 在页面上下文里发请求，返回 {status, text} */
  async api(pathname, body, method = 'POST') {
    const opts = method === 'POST'
      ? `{method:"POST",headers:{"content-type":"application/json","clienttype":"web","lang":"zh-CN"},body:JSON.stringify(${JSON.stringify(body)})}`
      : `{method:"GET",headers:{"clienttype":"web","lang":"zh-CN"}}`;
    const expr = `(async()=>{try{const r=await fetch(${JSON.stringify(pathname)},${opts});const t=await r.text();return JSON.stringify({status:r.status,text:t})}catch(e){return JSON.stringify({status:0,text:String(e)})}})()`;
    const raw = await this.evalPage(expr, true);
    return JSON.parse(raw);
  }

  async close() {
    try { this.ws && this.ws.close(); } catch {}
    try { this.proc && this.proc.kill(); } catch {}
  }
}

// ---------- 订单处理 ----------
function actionOf(o) {
  // side/positionSide 组合 -> 开多 / 平多 / 开空 / 平空
  if (o.positionSide === 'LONG') return o.side === 'BUY' ? 'openLong' : 'closeLong';
  if (o.positionSide === 'SHORT') return o.side === 'SELL' ? 'openShort' : 'closeShort';
  return 'unknown';
}

const ACTION_CN = { openLong: '开多', closeLong: '平多', openShort: '开空', closeShort: '平空', unknown: '未知' };
const ACTION_EMOJI = { openLong: '🟢', closeLong: '🔴', openShort: '🔴', closeShort: '🟢' };

function orderKey(o) {
  return `${o.symbol}|${o.side}|${o.positionSide}|${o.orderTime}|${o.executedQty}`;
}

function fmtNum(n, digits = 2) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function fmtTime(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000); // 显示为 UTC+8
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function summarize(orders) {
  // 按 symbol + action 聚合
  const groups = new Map();
  for (const o of orders) {
    const act = actionOf(o);
    const key = `${o.symbol}|${act}`;
    const g = groups.get(key) || { symbol: o.symbol, action: act, fills: [], qty: 0, notional: 0, pnl: 0, first: o.orderTime, last: o.orderTime };
    const qty = Number(o.executedQty);
    const px = Number(o.avgPrice);
    g.fills.push({ qty, px });
    g.qty += qty;
    g.notional += qty * px;
    g.pnl += Number(o.totalPnl || 0);
    g.first = Math.min(g.first, Number(o.orderTime));
    g.last = Math.max(g.last, Number(o.orderTime));
    groups.set(key, g);
  }
  const lines = [];
  for (const g of [...groups.values()].sort((a, b) => a.last - b.last)) {
    const avg = g.notional / (g.qty || 1);
    const base = g.symbol.replace(/USDT$/, '');
    let line = `${ACTION_EMOJI[g.action] || '⚪'} ${ACTION_CN[g.action]} ${g.symbol}`;
    if (g.fills.length > 1) line += ` ×${g.fills.length}笔`;
    line += `\n   均价 ${fmtNum(avg, 5)}  数量 ${fmtNum(g.qty, 4)} ${base}  价值 ${fmtNum(g.notional, 0)} USDT`;
    if (g.pnl !== 0) line += `\n   已实现盈亏 ${g.pnl > 0 ? '+' : ''}${fmtNum(g.pnl, 2)} USDT`;
    line += `\n   ${fmtTime(g.first)}${g.fills.length > 1 ? ' ~ ' + fmtTime(g.last).slice(6) : ''}`;
    lines.push(line);
  }
  return lines.join('\n\n');
}

function buildMessage(orders) {
  const head = `🦅 <b>${CONFIG.nickname}</b> 新操作（${orders.length} 笔成交）\n`;
  const body = summarize(orders);
  const tail = `\n\n<a href="${PAGE_URL}">查看带单员页面</a>`;
  let msg = head + '\n' + body + tail;
  if (msg.length > 3800) msg = msg.slice(0, 3700) + `\n…（已截断，共 ${orders.length} 笔）`;
  return msg;
}

// ---------- Telegram ----------
async function tgSend(text) {
  const token = TG_TOKEN;
  const chatId = TG_CHAT_ID;
  if (!token || !chatId) throw new Error('未配置 Telegram token / chatId');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('TG 发送失败: ' + JSON.stringify(j).slice(0, 200));
  return true;
}

// ---------- 状态 ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: [], lastCheck: 0 }; }
}
function saveState(s) {
  // 只保留最近 5000 个键，防止无限膨胀
  if (s.seen.length > 5000) s.seen = s.seen.slice(-5000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8');
}

// ---------- 主流程 ----------
function fetchOrders(browser, fromMs, toMs, pageSize = 200) {
  return browser.api(API_ORDER, {
    portfolioId: CONFIG.portfolioId,
    startTime: fromMs,
    endTime: toMs,
    pageSize,
  }).then((r) => {
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    let j;
    try { j = JSON.parse(r.text); } catch { throw new Error('响应非 JSON（可能被 WAF 拦截）'); }
    if (!j.success) throw new Error('接口返回失败: ' + (j.message || j.code));
    const list = (j.data && j.data.list) || [];
    const total = Number(j.data && j.data.total || 0);
    if (!list.length) log(`接口返回空列表 | 请求 ${fromMs}~${toMs}`);
    else if (total > list.length) log(`⚠ 窗口内共 ${total} 笔，只取到 ${list.length} 笔，可能漏单`);
    return list;
  });
}

async function runOnce(browser, state, { push }) {
  const now = Date.now();
  const lookback = now - CONFIG.lookbackMinutes * 60 * 1000;
  // 正常轮询只回看 lastCheck 前 5 分钟（留重叠防漏）；程序停过很久时最多回溯 lookback
  const from = state.lastCheck
    ? Math.max(state.lastCheck - 5 * 60 * 1000, lookback)
    : lookback;
  const list = await fetchOrders(browser, from, now);
  const seen = new Set(state.seen);
  const fresh = list.filter((o) => !seen.has(orderKey(o)));
  state.lastCheck = now;

  if (!fresh.length) {
    log(`无新成交（窗口内 ${list.length} 笔，已见）`);
    return 0;
  }
  fresh.sort((a, b) => a.orderTime - b.orderTime);
  for (const o of fresh) state.seen.push(orderKey(o));
  log(`发现 ${fresh.length} 笔新成交：` + fresh.map((o) => `${ACTION_CN[actionOf(o)]}${o.symbol}`).join(', '));

  if (push) {
    await tgSend(buildMessage(fresh));
    log('已推送 Telegram');
  } else {
    console.log('\n' + buildMessage(fresh) + '\n');
  }
  return fresh.length;
}

async function main() {
  log(`启动监控：${CONFIG.nickname} (${CONFIG.portfolioId})`);

  if (SELFTEST) {
    await tgSend(`🦅 <b>${CONFIG.nickname}</b> 监控测试消息\n\n如果你看到这条，说明 Telegram 推送通道正常。`);
    log('测试消息已发送');
    return;
  }

  const state = loadState();
  let browser = await new Browser().start();

  const ensurePage = async () => {
    if (browser.ready) return;
    for (let i = 0; i < 3; i++) {
      if (await browser.openPage()) return;
      await sleep(20000);
    }
    log('多次加载失败，重启 Chrome');
    await browser.close();
    await sleep(3000);
    browser = await new Browser().start();
    await browser.openPage();
  };

  await ensurePage();

  if (ONCE) {
    const n = await runOnce(browser, state, { push: PUSH });
    if (!n) console.log('（没有新成交；首次运行会记录当前已有成交，不推送）');
    saveState(state);
    await browser.close();
    return;
  }

  // 首次运行：把窗口内现有订单标记为已见，不推送
  if (!state.lastCheck) {
    await runOnce(browser, state, { push: false });
    saveState(state);
    await tgSend(`🦅 <b>${CONFIG.nickname}</b> 监控已启动\n\n目前记录到 ${state.seen.length} 笔历史成交，之后的新开仓 / 平仓会实时推送到这里。`);
  }

  let lastReload = Date.now();
  let failures = 0;
  const deadline = DURATION_SEC ? Date.now() + DURATION_SEC * 1000 : Infinity;
  if (DURATION_SEC) log(`本次运行 ${DURATION_SEC} 秒后退出`);

  while (Date.now() < deadline) {
    await sleep(Math.min(CONFIG.pollIntervalSec * 1000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      await ensurePage();
      await runOnce(browser, state, { push: true });
      saveState(state);
      failures = 0;
    } catch (e) {
      failures++;
      log('轮询出错: ' + e.message);
      if (/WAF|非 JSON|HTTP 403|HTTP 429|超时/.test(e.message)) browser.ready = false;
      if (failures >= 3) {
        log('连续失败，重启 Chrome');
        await browser.close();
        await sleep(5000);
        browser = await new Browser().start();
        browser.ready = false;
        failures = 0;
      }
    }

    if (Date.now() - lastReload > CONFIG.pageReloadMinutes * 60 * 1000) {
      log('定期刷新页面，续 WAF token');
      browser.ready = false;
      lastReload = Date.now();
      await ensurePage();
    }
  }
  log('达到运行时长，退出');
  await browser.close();
}

process.on('SIGINT', async () => { log('收到退出信号'); process.exit(0); });
process.on('uncaughtException', (e) => log('未捕获异常: ' + (e && e.stack || e)));

main().catch((e) => { log('致命错误: ' + (e && e.stack || e)); process.exit(1); });
