/**
 * v2.2 M1：VST3 Node sidecar 客户端（JSON lines over stdin/stdout）。
 *
 * - 开发用 Node 子进程（AIMS_NODE_BIN 或 PATH node；Electron 内建 Node 不加载 native addon）；
 * - 协议：{id,type,payload} → {id,ok,result?,error?,code?}；
 * - 超时/退出/启动失败均转中文错误，句柄可复用；不抛裸异常给工具层。
 *
 * 测试可注入 spawnImpl / nodeBin / sidecarPath 做纯 mock。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SIDECAR_PATH = path.resolve(MODULE_DIR, '..', '..', 'desktop', 'plugin-host-node.cjs')
export const DEFAULT_TIMEOUT_MS = 20000

/** M5：解析 asar 外 sidecar 脚本（packaged 优先 resources/native/plugin-host-node.cjs；dev 用 desktop/plugin-host-node.cjs）。 */
export function resolveSidecarPath(options = {}) {
  const env = options.env ?? process.env
  const explicit = options.sidecarPath ?? env.AIMS_PLUGIN_HOST_SCRIPT
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const resolved = path.resolve(explicit.trim())
    if (existsSync(resolved)) return resolved
    throw new PluginHostError(`AIMS_PLUGIN_HOST_SCRIPT/sidecar 脚本不存在：${resolved}`, 'PLUGIN_HOST_NO_SIDECAR')
  }
  const resourcesPath = typeof options.resourcesPath === 'string'
    ? options.resourcesPath
    : (typeof process.resourcesPath === 'string' ? process.resourcesPath : '')
  const execPath = options.execPath ?? process.execPath
  const execDir = execPath ? path.dirname(execPath) : ''
  // packaged 安装包：sidecar 与 native 模块放在 asar 外 resources/native/（外部 node 不能读 asar）。
  const packagedCandidates = [
    resourcesPath ? path.join(resourcesPath, 'native', 'plugin-host-node.cjs') : null,
    resourcesPath ? path.join(resourcesPath, 'app-resources', 'desktop', 'plugin-host-node.cjs') : null,
    resourcesPath ? path.join(resourcesPath, 'native', 'node', 'plugin-host-node.cjs') : null,
    execDir ? path.join(execDir, 'resources', 'native', 'plugin-host-node.cjs') : null,
    execDir ? path.join(execDir, '..', 'Resources', 'native', 'plugin-host-node.cjs') : null,
  ].filter(Boolean)
  for (const candidate of packagedCandidates) {
    if (existsSync(candidate)) return candidate
  }
  // 开发版 resources 模式（--m2-dev/--m3-dev/--m4-dev/--v23-dev）布局：sidecar 在
  // <app>/resources/desktop/plugin-host-node.cjs（remote node 可执行的真实路径）。
  const devResourceCandidates = [
    resourcesPath ? path.join(resourcesPath, 'desktop', 'plugin-host-node.cjs') : null,
    resourcesPath ? path.join(resourcesPath, 'plugin-host-node.cjs') : null,
  ].filter(Boolean)
  for (const candidate of devResourceCandidates) {
    if (existsSync(candidate)) return candidate
  }
  // 明确给了存在的 resourcesPath（安装包布局）但缺 sidecar：返回首选 packaged 路径，
  // 让 start() 给出 PLUGIN_HOST_NO_SIDECAR 中文错误，而不是误用 dev 仓库文件。
  if (resourcesPath && existsSync(resourcesPath)) return packagedCandidates[0] ?? DEFAULT_SIDECAR_PATH
  // 开发模式（无 resourcesPath/目录）：回退仓库 desktop/plugin-host-node.cjs。
  return DEFAULT_SIDECAR_PATH
}

export class PluginHostError extends Error {
  constructor(message, code = 'PLUGIN_HOST_ERROR') {
    super(message)
    this.name = 'PluginHostError'
    this.code = code
  }
}

/** 在 PATH 中查找 node/node.exe（Electron 内建 Node 不可加载 native addon）。 */
export function findNodeInPath(env = process.env) {
  const pathValue = String(env.PATH ?? env.Path ?? '')
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const name of process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 解析 Node 运行时（M5 发布包优先 bundled resources/native/node/node.exe，不依赖 PATH）。
 * 顺序：AIMS_NODE_BIN（显式/环境）→ packaged resources/native/node/node.exe（兼容 legacy native/node.exe）
 *      → 开发非 Electron execPath → PATH node → 中文错误。
 */
export function resolveNodeBin(options = {}) {
  const env = options.env ?? process.env
  const explicit = options.nodeBin ?? env.AIMS_NODE_BIN
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const resolved = path.resolve(explicit.trim())
    if (!existsSync(resolved)) throw new PluginHostError(`AIMS_NODE_BIN 不存在：${resolved}（请指向可用的 node.exe）`, 'PLUGIN_HOST_NO_NODE')
    return resolved
  }
  const resourcesPath = typeof options.resourcesPath === 'string'
    ? options.resourcesPath
    : (typeof process.resourcesPath === 'string' ? process.resourcesPath : '')
  const execPath = options.execPath ?? process.execPath
  const execDir = execPath ? path.dirname(execPath) : ''
  // M5：packaged Electron 运行时（asar 外）：resources/native/node/node.exe（首选），兼容 native/node.exe。
  const packagedCandidates = [
    resourcesPath ? path.join(resourcesPath, 'native', 'node', 'node.exe') : null,
    resourcesPath ? path.join(resourcesPath, 'native', 'node.exe') : null,
    resourcesPath ? path.join(resourcesPath, 'native', 'node', 'node') : null,
    execDir ? path.join(execDir, 'resources', 'native', 'node', 'node.exe') : null,
    execDir ? path.join(execDir, 'resources', 'native', 'node.exe') : null,
    execDir ? path.join(execDir, '..', 'Resources', 'native', 'node', 'node') : null,
  ].filter(Boolean)
  for (const candidate of packagedCandidates) {
    if (existsSync(candidate)) return candidate
  }
  // 开发模式：当前非 Electron 进程本身即 node。
  if (execPath && !process.versions?.electron && existsSync(execPath)) return execPath
  const fromPath = findNodeInPath(env)
  if (fromPath) return fromPath
  throw new PluginHostError(
    '找不到可用的 Node 运行时（外部插件需要桌面版 Node sidecar）；请确认安装包含 resources/native/node/node.exe，或设置 AIMS_NODE_BIN',
    'PLUGIN_HOST_NO_NODE',
  )
}

/**
 * 创建 sidecar 客户端（lazy start；同实例复用子进程）。
 * @param {{nodeBin?:string, sidecarPath?:string, timeoutMs?:number, spawnImpl?:Function, env?:object, cwd?:string}} [options]
 */
export function createPluginHostClient(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  // 显式 sidecarPath 保留 lazy 校验（start() 报中文错误，兼容旧调用方不抛于创建期）；
  // 未显式传入时按 packaged resources / dev 仓库布局解析。
  const explicitSidecar = options.sidecarPath === undefined || options.sidecarPath === null || options.sidecarPath === ''
    ? ''
    : String(options.sidecarPath)
  const sidecarPath = explicitSidecar !== ''
    ? path.resolve(explicitSidecar)
    : resolveSidecarPath({ sidecarPath: undefined, resourcesPath: options.resourcesPath, execPath: options.execPath, env: options.env })
  const spawnImpl = options.spawnImpl ?? nodeSpawn
  const spawnEnv = options.env ?? process.env
  let child = null
  let started = null
  let nextId = 0
  let closed = false
  let buffer = ''
  let readyResolve = null
  let readyReject = null
  const pending = new Map()

  const rejectAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  function handleLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.type === 'ready') {
      readyResolve?.(message)
      readyResolve = null
      readyReject = null
      return
    }
    const entry = pending.get(message?.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === true) entry.resolve(message.result)
    else {
      const error = new PluginHostError(String(message.error ?? '插件 sidecar 执行失败'), message.code ?? 'PLUGIN_HOST_REQUEST_FAILED')
      entry.reject(error)
    }
  }

  function handleExit(code, signal) {
    const error = new PluginHostError(`插件 sidecar 已退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}）`, 'PLUGIN_HOST_EXIT')
    readyReject?.(error)
    readyReject = null
    rejectAll(error)
    child = null
    started = null
    if (!closed) closed = true
  }

  function start() {
    if (started) return started
    if (closed) return Promise.reject(new PluginHostError('插件 sidecar 客户端已关闭', 'PLUGIN_HOST_CLOSED'))
    if (!existsSync(sidecarPath)) {
      return Promise.reject(new PluginHostError(
        `插件 sidecar 脚本不存在：${sidecarPath}（开发：desktop/plugin-host-node.cjs；安装包：resources/native/plugin-host-node.cjs；可用 AIMS_PLUGIN_HOST_SCRIPT 指定）`,
        'PLUGIN_HOST_NO_SIDECAR',
      ))
    }
    let nodeBin
    try {
      nodeBin = resolveNodeBin({ nodeBin: options.nodeBin, execPath: options.execPath, resourcesPath: options.resourcesPath, env: spawnEnv })
    } catch (error) {
      return Promise.reject(error)
    }
    started = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      child = spawnImpl(nodeBin, [sidecarPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd ?? path.dirname(sidecarPath),
        env: spawnEnv,
        windowsHide: true,
      })
      child.on('error', (error) => {
        readyReject?.(new PluginHostError(`启动插件 sidecar 失败：${error?.message ?? error}`, 'PLUGIN_HOST_SPAWN_FAILED'))
        readyReject = null
        started = null
      })
      child.on('exit', handleExit)
      child.stdout?.on?.('data', (chunk) => {
        buffer += String(chunk)
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          handleLine(line)
          index = buffer.indexOf('\n')
        }
      })
      child.stderr?.on?.('data', () => {})
    })
    return started
  }

  async function request(type, payload = {}, requestTimeoutMs = timeoutMs) {
    await start()
    if (!child || !child.stdin?.writable) throw new PluginHostError('插件 sidecar 未就绪', 'PLUGIN_HOST_NOT_READY')
    nextId += 1
    const id = `req_${nextId}`
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new PluginHostError(`插件 sidecar 请求超时（${requestTimeoutMs}ms，type=${type}）`, 'PLUGIN_HOST_TIMEOUT'))
      }, requestTimeoutMs)
      // 注意：请求进行中不 unref 定时器，否则只有 sidecar（unref 子进程）时 Node 会提前退出。
      pending.set(id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ id, type, payload })}\n`)
    return response
  }

  return {
    get timeoutMs() { return timeoutMs },
    get nodeBin() { return resolveNodeBin({ nodeBin: options.nodeBin, execPath: options.execPath, resourcesPath: options.resourcesPath, env: spawnEnv }) },
    start,
    async ping() { return request('ping', {}) },
    async scan({ dirs = [], includeDefaults = true } = {}) {
      return request('scan', { dirs: Array.isArray(dirs) ? dirs : [], includeDefaults })
    },
    async inspect(pluginPath) { return request('inspect', { path: String(pluginPath ?? '') }) },
    // M2：多实例协议
    async loadInstance(options = {}) { return request('loadInstance', { ...options }) },
    async renderOffline(options = {}) { return request('renderOffline', { ...options }, Math.max(timeoutMs, 60000)) },
    async unloadInstance(instanceId) { return request('unloadInstance', { instanceId: String(instanceId ?? '') }) },
    async processInstance(options = {}) { return request('processInstance', { ...options }) },
    async setInstanceParam({ instanceId, paramId, value } = {}) { return request('setInstanceParam', { instanceId: String(instanceId ?? ''), paramId, value }) },
    async getInstanceParams(instanceId, options = {}) { return request('getInstanceParams', { instanceId: String(instanceId ?? ''), ...options }) },
    async listPrograms(options = {}) { return request('listPrograms', { ...options }) },
    async selectProgram(options = {}) { return request('selectProgram', { ...options }) },
    async saveInstanceState(instanceId) { return request('saveInstanceState', { instanceId: String(instanceId ?? '') }) },
    async loadInstanceState(instanceId, state) { return request('loadInstanceState', { instanceId: String(instanceId ?? ''), state: String(state ?? '') }) },
    async listInstances() { return request('listInstances', {}) },
    // M0/M1 单实例兼容
    async load(pluginPath, loadOptions = {}) { return request('load', { path: String(pluginPath ?? ''), ...loadOptions }) },
    async getParameterCount() { return request('getParameterCount', {}) },
    async getParameterInfo(index) { return request('getParameterInfo', { index: Number(index) }) },
    async getParamsList() { return request('getParamsList', {}) },
    async saveState() { return request('saveState', {}) },
    async loadState(state) { return request('loadState', { state: String(state ?? '') }) },
    async setParameter(paramId, value) { return request('setParam', { paramId: Number(paramId), value: Number(value) }) },
    async getParameter(paramId) { return request('getParam', { paramId: Number(paramId) }) },
    async unload() { return request('unload', {}) },
    async close() {
      closed = true
      const active = child
      child = null
      started = null
      rejectAll(new PluginHostError('插件 sidecar 客户端已关闭', 'PLUGIN_HOST_CLOSED'))
      if (active && !active.killed) {
        try { active.stdin?.end?.() } catch { /* ignore */ }
        try { active.kill?.() } catch { /* ignore */ }
      }
    },
  }
}
