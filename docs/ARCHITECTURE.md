# 架构说明

## 总览

```
┌──────────────────────────────────────────────────────────────┐
│ Electron 桌面窗口                                             │
│  React UI (src/client)  ←→  Web Audio 引擎 (src/client/audio) │
│         │                              │                     │
│         │ HTTP/JSON（127.0.0.1）        │ AudioWorklet/SAB     │
│         ▼                              ▼                     │
│  本地 Host 服务 (src/host)        外部 VST3 桥                │
│  工程状态 / AI 工具 / 路由         (preload + IPC + sidecar)  │
└─────────────┬────────────────────────────────────────────────┘
              │ JSON line
              ▼
      Node VST3 sidecar (desktop/plugin-host-node.cjs)
              │
              ▼
        nvst3-host native addon
              │
              ▼
           VST3 插件
```

## 关键模块

| 路径 | 作用 |
|---|---|
| `src/client/` | React 界面：播放列表、钢琴卷帘、混音台、VST3 面板、自动化 |
| `src/client/audio/` | Web Audio 实时图、采样器、合成器、效果器、离线渲染、WAV 编码 |
| `src/host/` | 本地 HTTP 服务、工程状态/撤销、AI 工具、导入导出、VST3 管理 |
| `src/shared/` | schemaVersion=3 工程模型、音色目录、乐理/音频分析/生成算法 |
| `src/standalone/` | 独立窗口页面入口 |
| `desktop/main.cjs` | Electron 主进程、窗口、本地服务生命周期、preload/IPC |
| `desktop/plugin-host-node.cjs` | VST3 sidecar：加载/扫描/处理/参数/预设/状态/离线渲染 |
| `desktop/build-exe.mjs` | Electron 便携版打包，内置 Node runtime 和 native sidecar |
| `desktop/build-installer.mjs` | 生成 Setup 安装包（7-Zip SFX） |

## 数据流

### 手动编辑
1. UI 操作 → `POST /studio/api/edit`。
2. Host 在工程副本上执行原子编辑，生成 undo 快照，bump `revision`。
3. UI 长轮询 `/studio/api/state` 收到新工程；`engine.setProject()` 增量更新 Web Audio 图。
4. 播放时 Web Audio 调度音符/音频片段；导出时 OfflineAudioContext 渲染。

### AI 工具
1. DSH 插件把 `studio_*` 工具注册给 AI Agent。
2. 工具调用进入本地 Host（同一 Electron 进程内的 HTTP 服务）。
3. Host 修改工程 / 触发 UI 渲染预览 / 读取分析。
4. 结果以 JSON 返回 AI。AI 与手动编辑共享同一个工程和撤销栈。

### 外部 VST3
1. Host 扫描/安装插件，登记到 `data/plugins.json`。
2. 播放时 UI 创建 AudioWorklet 节点；主线程 pump 通过 SharedArrayBuffer 环把 256 帧音频送到 preload。
3. preload → Electron main → Host 管理的 Node sidecar → `nvst3-host` → VST3。
4. 参数、预设、状态写回工程；冻结时 Host 通过 sidecar 离线渲染为 WAV 缓存。

## 工程格式

- `schemaVersion=3`，JSON 保存到 `data/project.json` 或命名工程 `data/projects/*.json`。
- 轨道类型：`synth`（采样器/合成器）、`drum`、`audio`、`vst3`。
- 效果器：内置 type 或 `vst3`（仅轨道 FX 链末尾）。
- 数据目录：桌面 exe 为 `%APPDATA%\AI音乐工作室\data`；源码/独立服务为仓库或 `--data-dir` 指定的 `data/`。
- 工程/导出/媒体都不上传；无账号、无遥测。

## 安全边界

- 渲染进程 `contextIsolation: true`、`sandbox: true`，通过 preload 暴露窄 API。
- VST3 是第三方原生代码，运行在独立 Node 进程；仍可能崩溃/占用资源，不能视为安全沙箱。
- 外部插件首次加载需用户确认；缺失插件保留引用并标记 missing。
- 本地 HTTP 只监听 `127.0.0.1`，不是公网服务。
