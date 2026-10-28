/**
 * DSH 插件的「空浏览器半区」。
 *
 * 现在的产品形态是「独立窗口软件 + DSH AI 控制桥」：DSH 插件只注册 Host 工具（studio_*），
 * 不再往 DSH 界面里塞 DAW 面板。为了让升级后旧 client 图里的残留 row 无害化（加载即空注册），
 * 这里保留一个最小可加载的 client bundle。
 */
export const inject = []

export function apply() {
  /* intentionally empty：DSH 侧不再提供界面 */
}
