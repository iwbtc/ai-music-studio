/**
 * v2.2 M2：桌面窗口 preload —— 向渲染进程暴露 window.aimsPlugins。
 *
 * - 仅暴露受限 IPC 方法（load/process/setParam/unload/status/params/reportStatus），不暴露 Node/ipcRenderer。
 * - 浏览器/独立页面无此 preload：window.aimsPlugins === undefined，UI 显示「外部插件仅桌面版」。
 * - 实例 id 约定：effect = `fx:<effectId>`；instrument（M3）= `trk:<trackId>`。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function unavailable(method) {
  return async () => ({ ok: false, error: `外部插件需要桌面版（window.aimsPlugins.${method} 不可用）`, code: 'PLUGIN_HOST_UNAVAILABLE' })
}

let api = null
if (ipcRenderer) {
  api = {
    supported: true,
    /** load(pluginId, {instanceId（effect=fx:<effectId>；instrument=track:<trackId>）,kind?:'instrument'|'effect',effectId?,trackId?,sampleRate,maxBlockSize,audioInputs,audioOutputs,stateBase64?}) */
    load: (pluginId, options = {}) => ipcRenderer.invoke('aims-plugin:load', { ...options, pluginId: String(pluginId ?? '') }),
    /** process({instanceId,inputs: base64[]|Float32Array[],numSamples,midi?: [{type:'noteOn'|'noteOff'|'cc'|'pitchBend',...}]}) → {ok,outputs: base64[],outputsF32,midiEventCount,ms} */
    process: (options = {}) => ipcRenderer.invoke('aims-plugin:process', options),
    /** setParam({instanceId,paramId,value}) */
    setParam: (options = {}) => ipcRenderer.invoke('aims-plugin:set-param', options),
    /** unload({instanceId}) 或 unload('fx:fx_1') */
    unload: (instanceIdOrOptions) => ipcRenderer.invoke('aims-plugin:unload', typeof instanceIdOrOptions === 'string' ? { instanceId: instanceIdOrOptions } : (instanceIdOrOptions ?? {})),
    /** saveState({instanceId}) → {ok,instanceId,stateBase64}（M4：工程保存前持久化插件状态） */
    saveState: (instanceIdOrOptions) => ipcRenderer.invoke('aims-plugin:save-state', typeof instanceIdOrOptions === 'string' ? { instanceId: instanceIdOrOptions } : (instanceIdOrOptions ?? {})),
    /** selectProgram({instanceId,listId,index}) → 选择插件 program（v2.3 P1；audio 实时节点用） */
    selectProgram: (options) => ipcRenderer.invoke('aims-plugin:select-program', options ?? {}),
    /** loadState({instanceId,stateBase64}) → 加载插件 state（v2.3 P1；audio 实时节点用） */
    loadState: (options) => ipcRenderer.invoke('aims-plugin:load-state', options ?? {}),
    /** status(instanceId?) → 无参：{ok,supported,sidecar,instances}；带 id：单实例 {loaded,underrun,bufferMs,latencyMs,...} */
    status: (instanceIdOrOptions) => ipcRenderer.invoke('aims-plugin:status', typeof instanceIdOrOptions === 'string' ? { instanceId: instanceIdOrOptions } : (instanceIdOrOptions ?? {})),
    /** params({instanceId}) → {ok,count,params} */
    params: (instanceIdOrOptions) => ipcRenderer.invoke('aims-plugin:params', typeof instanceIdOrOptions === 'string' ? { instanceId: instanceIdOrOptions } : (instanceIdOrOptions ?? {})),
    /** reportStatus({instanceId,underrun,underruns,bufferMs,error}) 音频桥上报运行状态 */
    reportStatus: (options = {}) => ipcRenderer.invoke('aims-plugin:report-status', options),
  }
} else {
  api = {
    supported: false,
    load: unavailable('load'),
    process: unavailable('process'),
    setParam: unavailable('setParam'),
    unload: unavailable('unload'),
    status: async () => ({ ok: false, supported: false, loaded: false, instances: [], error: '外部插件需要桌面版/后端未启用', code: 'PLUGIN_HOST_UNAVAILABLE' }),
    params: unavailable('params'),
    reportStatus: unavailable('reportStatus'),
  }
}

contextBridge.exposeInMainWorld('aimsPlugins', api)
