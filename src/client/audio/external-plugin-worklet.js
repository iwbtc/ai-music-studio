/**
 * v2.2 M2/M3：外部 VST3 实时 AudioWorkletProcessor 源码（effect + instrument 模式）。
 *
 * 以源码字符串形式导出，由 external-plugin.js 生成 Blob URL 后
 * `audioWorklet.addModule(url)` 注册；模块加载时不做任何 Web Audio 调用，
 * Node 单测可安全 import（只读字符串/常量）。
 *
 * SAB 布局（每 node 一个 SharedArrayBuffer，stereo planar）：
 *   Int32Array 控制区（32 ints = 128B，Atomics）：
 *     0 INPUT_WRITE  主线程写入帧数（单调递增，仅 effect）
 *     1 INPUT_READ   worklet 读取帧数（仅 effect）
 *     2 OUTPUT_WRITE worklet 写入帧数
 *     3 OUTPUT_READ  主线程读取帧数
 *     4 UNDERRUN     输出不足次数
 *     5 BYPASS       0/1 旁路直通（instrument 时静音）
 *     6 SEQ          主线程写 output 后递增（调试）
 *     7 ERROR        0/1 bridge 错误 → 直通/静音
 *     8 INPUT_OVERRUN 输入环满丢弃次数
 *     9 MIDI_WRITE   MIDI 事件写入计数（instrument，主线程）
 *    10 MIDI_READ    MIDI 事件读取计数（instrument，主线程 bridge）
 *    11 MIDI_DROPPED MIDI 队列满丢弃次数
 *   effect 数据区：input 先 channels×ringFrames，output 紧随其后（planar）。
 *   instrument 数据区：output 先 channels×ringFrames，MIDI 队列紧随其后（Int32 记录）。
 */

export const EXTERNAL_PLUGIN_WORKLET_NAME = 'aims-external-plugin'

/** 控制区 int 下标（worklet 与主线程共享）。 */
export const EXTERNAL_CONTROL = Object.freeze({
  INPUT_WRITE: 0,
  INPUT_READ: 1,
  OUTPUT_WRITE: 2,
  OUTPUT_READ: 3,
  UNDERRUN: 4,
  BYPASS: 5,
  SEQ: 6,
  ERROR: 7,
  INPUT_OVERRUN: 8,
  MIDI_WRITE: 9,
  MIDI_READ: 10,
  MIDI_DROPPED: 11,
})

/** 控制区 int 数量（128B）。 */
export const EXTERNAL_CONTROL_INTS = 32
/** 每 node 默认环帧数。 */
export const EXTERNAL_RING_FRAMES = 8192
/** 默认声道数（stereo）。 */
export const EXTERNAL_CHANNELS = 2

export const EXTERNAL_PLUGIN_WORKLET_SOURCE = `/* aims-external-plugin worklet (v2.2 M2/M3) */
const CTRL = { INPUT_WRITE: 0, INPUT_READ: 1, OUTPUT_WRITE: 2, OUTPUT_READ: 3, UNDERRUN: 4, BYPASS: 5, SEQ: 6, ERROR: 7, INPUT_OVERRUN: 8, MIDI_WRITE: 9, MIDI_READ: 10, MIDI_DROPPED: 11 };
const CTRL_INTS = 32;

class AimsExternalPluginProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sab = opts.sab || null;
    this.ringFrames = Math.max(256, Number(opts.ringFrames) || 8192);
    this.channels = Math.max(1, Math.min(2, Number(opts.channels) || 2));
    this.instanceId = typeof opts.instanceId === 'string' ? opts.instanceId : '';
    this.mode = opts.mode === 'instrument' ? 'instrument' : 'effect';
    this.ready = false;
    if (this.sab) {
      try {
        this.control = new Int32Array(this.sab, 0, CTRL_INTS);
        const floatOffset = CTRL_INTS * 4;
        const frameLength = this.ringFrames * this.channels;
        if (this.mode === 'instrument') {
          this.input = null;
          this.output = new Float32Array(this.sab, floatOffset, frameLength);
        } else {
          this.input = new Float32Array(this.sab, floatOffset, frameLength);
          this.output = new Float32Array(this.sab, floatOffset + frameLength * 4, frameLength);
        }
        this.ready = true;
      } catch (error) {
        this.ready = false;
        this.port && this.port.postMessage({ type: 'error', message: String((error && error.message) || error) });
      }
    }
    if (this.port) {
      this.port.onmessage = (event) => {
        const data = event && event.data ? event.data : {};
        if (data.type === 'set-bypass' && this.ready) Atomics.store(this.control, CTRL.BYPASS, data.bypass === true ? 1 : 0);
        if (data.type === 'reset' && this.ready) {
          Atomics.store(this.control, CTRL.INPUT_WRITE, 0);
          Atomics.store(this.control, CTRL.INPUT_READ, 0);
          Atomics.store(this.control, CTRL.OUTPUT_WRITE, 0);
          Atomics.store(this.control, CTRL.OUTPUT_READ, 0);
          Atomics.store(this.control, CTRL.UNDERRUN, 0);
          Atomics.store(this.control, CTRL.ERROR, 0);
        }
      };
    }
  }

  _available(start, end) {
    const capacity = this.ringFrames;
    return (Atomics.load(this.control, end) - Atomics.load(this.control, start) + capacity) % capacity;
  }

  _writeInput(inputs, frames) {
    if (!inputs || inputs.length === 0) return;
    const free = this.ringFrames - this._available(CTRL.INPUT_READ, CTRL.INPUT_WRITE);
    if (free < frames) {
      Atomics.add(this.control, CTRL.INPUT_OVERRUN, 1);
      return;
    }
    let write = Atomics.load(this.control, CTRL.INPUT_WRITE) % this.ringFrames;
    for (let channel = 0; channel < this.channels; channel++) {
      const source = inputs[channel] || inputs[0] || null;
      const base = channel * this.ringFrames;
      for (let i = 0; i < frames; i++) this.input[base + write + i] = source && i < source.length ? source[i] : 0;
    }
    Atomics.add(this.control, CTRL.INPUT_WRITE, frames);
  }

  _readOutput(outputs, frames) {
    const available = this._available(CTRL.OUTPUT_READ, CTRL.OUTPUT_WRITE);
    for (let channel = 0; channel < outputs.length; channel++) outputs[channel].fill(0);
    if (available < frames) {
      Atomics.add(this.control, CTRL.UNDERRUN, 1);
      return false;
    }
    let read = Atomics.load(this.control, CTRL.OUTPUT_READ) % this.ringFrames;
    for (let channel = 0; channel < outputs.length; channel++) {
      const target = outputs[channel];
      const sourceChannel = Math.min(channel, this.channels - 1);
      const base = sourceChannel * this.ringFrames;
      for (let i = 0; i < frames; i++) target[i] = this.output[base + read + i];
    }
    Atomics.add(this.control, CTRL.OUTPUT_READ, frames);
    return true;
  }

  process(inputs, outputs) {
    const input = (inputs && inputs[0]) || [];
    const output = (outputs && outputs[0]) || [];
    const frames = output.length ? output[0].length : 128;
    if (!this.ready || Atomics.load(this.control, CTRL.BYPASS) === 1 || Atomics.load(this.control, CTRL.ERROR) === 1) {
      for (let channel = 0; channel < output.length; channel++) {
        const source = this.mode === 'instrument' ? null : input[Math.min(channel, input.length - 1)] || null;
        for (let i = 0; i < frames; i++) output[channel][i] = source && i < source.length ? source[i] : 0;
      }
      return true;
    }
    if (this.mode !== 'instrument') this._writeInput(input, frames);
    this._readOutput(output, frames);
    return true;
  }
}

registerProcessor('${EXTERNAL_PLUGIN_WORKLET_NAME}', AimsExternalPluginProcessor);
`
