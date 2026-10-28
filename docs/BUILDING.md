# 从源码构建

## 环境

- Windows 10/11 x64
- Node.js 24（项目 `engines` 要求 >=22，实际开发使用 24）
- npm 11+
- 可选：VS Code / PowerShell 7

项目是 Windows-first；Linux/macOS 未验证。

## 1. 安装根依赖并构建前端

```powershell
npm install
npm run build
```

`npm run build` 生成：
- `lib/client.js`（DSH 插件客户端）
- `standalone/assets/app.js`（独立窗口前端）

如果 npm 阻止 `esbuild` 的 install script，可执行：

```powershell
npm approve-scripts
# 或按 npm 提示选择 esbuild
npm rebuild esbuild
```

## 2. 运行 Electron 开发窗口

```powershell
cd desktop
npm install
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js
npx electron main.cjs
```

Electron 首次可能需要单独下载约 150MB 运行库。

## 3. 构建便携版 exe

在仓库根目录：

```powershell
node desktop/build-exe.mjs
# 产物：dist/AI音乐工作室-win32-x64/AI音乐工作室.exe
```

构建脚本会：
- 用 `@electron/packager` 打包；
- 准备 `resources/native/node/node.exe`（官方 Node 24 win-x64）；
- 放入 `nvst3-host` 原生 addon 和 `plugin-host-node.cjs`；
- 校验 preload/COOP/COEP/sidecar 资源。

## 4. 构建安装包

```powershell
node desktop/build-exe.mjs
node desktop/build-installer.mjs --skip-exe
# 产物：dist/installer/AI音乐工作室-Setup-2.4.0.exe
```

安装包使用 7-Zip SFX，用户级安装，不需要管理员权限。

## 5. 单元测试

```powershell
npm test
```

单元测试不打开窗口。浏览器 E2E、音频听感、安装包回归需要额外环境（本公开仓库不包含内部 E2E 工具和测试插件）。

## 常见问题

- **构建时提示找不到 esbuild/react**：先在根目录 `npm install`。
- **Electron 下载失败**：设置 `ELECTRON_MIRROR` 后重试。
- **VST3 无法加载**：确认 Windows x64、插件是 VST3、路径存在；安装版已内置 Node sidecar，源码运行可设置 `AIMS_NODE_BIN`。
- **安装包杀毒误报**：未签名 + 自解压安装器的常见问题；从本仓库 Release 下载并核对 SHA256。
- **端口占用**：默认 `127.0.0.1:41731`，被占用时 Host 会自动顺延；可用 `--port` 指定。
