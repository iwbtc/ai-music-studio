# 采样来源与许可（assets/samples）

本目录中的 39 个采样文件全部来自 **Sonic Pi 官方采样库**，均为
**Creative Commons Zero (CC0 / 公有领域)** 授权，可自由用于商业/非商业项目、可再分发，
无需署名（我们仍在此注明来源以示尊重）。

- 上游仓库：https://github.com/sonic-pi-net/sonic-pi（目录 `etc/samples/`）
- 上游许可说明：https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md
- 许可全文：https://creativecommons.org/publicdomain/zero/1.0/

Sonic Pi 采样库说明（摘自上游 README）：

> The samples prefixed with `arovane_` have been kindly donated by Uwe Zahn (Arovane)
> under a Creative Commons 0 license. All other samples in this directory are from
> freesound.org and have also been placed in the public domain via the CC0 License.
> Many of the samples have been slightly modified and trimmed for use with Sonic Pi.

本工作室用到的采样（按用途分组；未做任何修改，原样使用）：

## 采样鼓机（4 套，共 39 个文件）

| 鼓件 | Acoustic Kit | Electro Kit | Lo-Fi Kit | Percussion Kit |
|---|---|---|---|---|
| kick | drum_bass_hard | bd_808 | drum_bass_soft | bd_zum |
| snare | drum_snare_hard | elec_snare | drum_snare_soft | sn_zome |
| clap | drum_snare_soft | elec_hi_snare | sn_generic | perc_snap |
| rim | elec_tick | elec_tick | elec_tick | tabla_ke2 |
| hat | drum_cymbal_closed | hat_zan | hat_noiz | hat_tap |
| openhat | drum_cymbal_open | elec_cymbal | drum_cymbal_soft | drum_cymbal_pedal |
| tomLow | drum_tom_lo_hard | elec_fuzz_tom | drum_tom_lo_soft | tabla_ghe1 |
| tomHigh | drum_tom_hi_hard | elec_bong | drum_tom_hi_soft | tabla_na |
| crash | drum_cymbal_hard | elec_cymbal | drum_splash_hard | drum_splash_soft |
| ride | ride_via | elec_chime | ride_tri | ride_tri |
| perc | drum_cowbell | elec_blip2 | vinyl_scratch | perc_bell |

> 早期版本的 9 个采样乐器预设（采样钢琴/合唱/吉他等）已按用户反馈移除，对应未被鼓机引用的
> 7 个采样文件已删除；本目录只剩 4 套采样鼓机所需文件。

如需替换/新增采样鼓机采样：把 `.wav` / `.flac` / `.mp3` 文件放进本目录，在
`src/shared/catalog.js` 的 `DRUM_KITS`（`samplerPieces` 字段）里登记即可；注意确认新采样文件的授权允许分发。
