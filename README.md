# Muse-Ai

A-GP 的插件与信号仓库。**定位：A-GP 是基座，插件就是生态。**

## 这是干什么的

- `signals/` — Muse 每分钟推送的量化信号（JSON），A-GP 插件读取后在分时图上画买卖点
- `plugins/` — 远端插件代码，A-GP 远程加载
- `manifest.json` — 插件清单（id、版本、入口、槽位）
- `docs/` — 需求与架构文档

## 先读文档

- [架构总览](docs/architecture.md) — 全景图、数据流、代码流
- [需求文档](docs/requirements.md) — **唯一事实来源**，动手前先读

## 约定

- 插件只动 `plugins/` + `manifest.json`，不动 A-GP 核心
- 信号只写 `signals/`，格式见需求文档
- 文档和代码一起提交
