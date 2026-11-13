# market-pulse

定时任务仓库：用无头浏览器加载目标页面，调用页面自身使用的公开数据接口，对比前后快照，
把变化推送到 Telegram。

## 怎么跑

GitHub Actions 每 30 分钟触发一次，每次在 runner 里连续轮询 28 分钟（间隔 90 秒）。
`concurrency` 保证同一时间只有一个任务，cron 排队时后一个会接着跑。

## 配置

- `config.json` — 目标标识、轮询间隔、回看窗口
- `state.json` — 已处理记录的指纹，由 workflow 自动提交回仓库，用于跨任务去重
- Repository secrets：
  - `TG_TOKEN`
  - `TG_CHAT_ID`

## 本地运行

```
node monitor.js --once      # 抓一次并打印
node monitor.js             # 持续轮询
```

需要本机有 Chrome / Chromium。敏感凭据放在 `secrets.json`（已被 .gitignore 忽略）。
