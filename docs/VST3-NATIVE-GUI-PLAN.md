# VST3 插件原生 GUI 方案（P3 / 不承诺 v2.3 交付）

> 状态：方案评估，未实现。v2.3 P0–P2 先交付通用参数/预设/自动化 UI；原生插件编辑器窗口留后续版本。

## 1. 现状与限制

- 当前 native host（nvst3-host）只加载插件并处理音频/参数，**不暴露 `IPlugView` / `IPlugFrame`**，因此无法打开插件自己的 GUI。
- AI 无法直接“看/点”插件 GUI；当前 AI 通过 `studio_*` 参数/预设/自动化工具控制。
- 一次性把 native host 改成 GUI host 会影响实时音频稳定性、打包和崩溃隔离，不适合塞进 v2.3。

## 2. 方案对比

### 方案 A：fork nvst3-host，原生嵌入 HWND（推荐评估）

- 在 native host 中调用 `IPlugView::createView`、`IPlugView::attached(HWND, platformType)`；
- Electron/主进程提供一个子窗口或 `BrowserWindow` 容器，把插件 view 的 HWND 嵌入（Windows `SetParent`/child window）；
- 通信：现有 JSON-line 协议增加 `openEditor/closeEditor/resizeEditor`；
- 优点：真正的插件原生界面，编辑器与实例同进程，参数/状态一致；
- 风险：C++ 改造、Windows 焦点/DPI/键盘、插件崩溃可能拖垮音频 host、VST3 SDK 许可、CI 构建链；
- 隔离建议：编辑器放独立 `plugin-gui-host` 进程，音频 host 保持无 GUI；通过共享参数/状态同步；编辑器崩溃不影响音频。

### 方案 B：独立 native GUI 进程 + 截图/输入代理

- 独立进程加载插件并显示窗口；主应用通过截图 + 坐标事件做“远程控制”；
- AI 可通过截图理解界面、发送受限点击/键入（需用户显式授权与安全策略）；
- 优点：隔离性最好，AI 可“看屏”操作；
- 缺点：窗口管理/输入合成/DPI 复杂，安全与可访问性风险高；仍不能真正得到插件参数语义。

### 方案 C：Web 通用参数 UI（现状）+ 原生窗口仅按需

- 保持 M0–M4 的数据库/参数/预设/自动化通用 UI；
- 插件原生 GUI 作为“打开编辑器”外部窗口，AI 不直接点，只通过参数/预设/自动化工具控制；
- 成本最低、风险最小，但用户需要原生界面时仍要手工操作。

## 3. 推荐路线

1. **v2.3**：只做通用参数写回（P0）、预设/state（P1）、参数自动化（P2），原生 GUI 不做；
2. **后续 M5/M6**：优先方案 A 的隔离版：独立 `plugin-gui-host` 进程 + HWND/child window，主进程只桥接打开/关闭/尺寸/焦点；
3. AI 侧始终通过参数/预设/自动化工具操作；如需 GUI 截图/点击，单独做“受控屏幕代理”（明确 opt-in、安全边界）；
4. 打包：native host/GUI host 与 Node runtime 一起签名、随安装包分发。

## 4. 关键风险

- 插件 GUI 崩溃/死锁隔离；音频线程与 GUI 线程分离；
- Windows 高 DPI、键盘焦点、拖拽、文件对话框；
- VST3 SDK 许可与代码签名；
- AI 截图/点击的隐私与安全（需用户授权，默认关闭）；
- 自动化测试难：插件 GUI 无统一可访问性树，只能截图/像素/坐标，不适合作为稳定 E2E 断言。

## 5. 验收草案（未来）

- 打开/关闭 TAL-Reverb-4 / TAL-NoiseMaker 原生编辑器，窗口标题/尺寸正确；
- 关闭 GUI 后音频不中断、参数/状态与工程一致；
- GUI host 崩溃时音频 host 不受影响并给出中文错误；
- 无 GUI/无 preload 环境降级为通用参数面板；
- 打包体积/启动时间可接受，安装包签名通过。
