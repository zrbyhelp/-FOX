# 小狐狸 · 3D 模型 + Live2D 风格 2D 版 + 网页交互动画

根据 `reference/` 中的参考图,从零制作的 Q 版植绒小狐狸与品牌 Logo(4 个奶白方块 + 橙色四角星)。
内容包括:
- 程序化建模、骨骼绑定(含手指 / 拇指骨骼)、18 个动作片段。
- 一个 Three.js 网页,带待机和交互动画、对话气泡、出场和离场动画,并能陪你一起打字。
- 一个 **Live2D 风格的 2D 版本**,在工具栏里可以和 3D 版一键切换。

> 原图尾巴的透视不对,像一张贴在画面上的平面。3D 模型里改成了真实透视:
> - 尾根在臀部后方中线,尾巴向后、向上弯,并偏向狐狸左侧,尾尖微微前卷。
> - 所以从正面 3/4 视角看,尾巴从身体右后方露出来,有正确的遮挡和前后缩短。
> - 尾巴长约 0.73(整只狐狸高 1.0),比原图加长约 15–20%。
>
> 在 3D 网页里拖动旋转视角,可以从侧面和背面看到立体的尾巴。

## 快速开始(只看网页)

```bash
cd web
npm install
npm run dev          # 打开终端里显示的地址,例如 http://localhost:5173
npm run build        # 生成静态站点到 web/dist(index.html + live2d.html),可部署到任意静态托管
```

仓库里已经提交了构建好的文件,只看网页不需要 Python 或 Blender:
- 3D:`web/public/models/`(`fox.glb`、`logo.glb`、`clips.json`)
- 2D:`web/public/live2d/`(分层贴图、`layers.json`、`rig.json`)

### 3D / 2D 切换

工具栏最右边的「3D | 2D」开关可以随时切换,切换时小狐狸会重新入场并挥手:
- **3D**:Three.js 模型,可以拖动旋转视角。
- **2D**:Live2D 风格的分层纸片人偶。用网格变形做转头、眨眼、呼吸、身体摆动,再加上耳朵、围巾、尾巴的物理摆动。

两个版本共用同一套工具栏按钮、对话气泡台词、「跟随鼠标」开关和键盘打字功能。

打开 `?mode=2d` 会直接进入 2D 版,切换后地址栏也会随之更新。`live2d.html` 是只有 2D 版的独立页面。

### 交互说明

| 操作 | 反应 |
|------|------|
| 移动鼠标 | 头和视线跟随鼠标(可在工具栏关闭「跟随鼠标」) |
| 点头 | 开心(双爪合于胸前,眯眼笑) |
| 点耳朵 | 抖耳朵 |
| 点身体 | 随机打招呼或摊手 |
| 点尾巴 | 回头看尾巴并甩尾 |
| **拖动尾巴** | 尾巴跟着指针弯曲,松手后带着回弹甩回去,然后回头看 |
| 鼠标划过尾巴 | 尾巴轻轻一甩 |
| 在头上拖动(抚摸) | 眯眼蹭手、尾巴快摇;松手后比心,并弹出一颗粉色爱心 |
| 双击狐狸 | 跳跃 |
| 鼠标悬停 Logo(手机上轻点) | 看向 Logo,手心朝上指向它 |
| 点击 Logo | Logo 激活:星星居中,方块环绕旋转;狐狸踮脚去够 |
| **敲键盘** | 小狐狸变出一个魔法键盘跟着你打字,按下的键会亮起;停止打字约 2 秒后键盘消失 |
| 15 秒无操作 | 坐下托腮思考 |
| 30 秒无操作 | 打盹,飘出 Z 字;再点一下会起身挥手 |
| 拖动空白处 / 滚轮(3D) | 旋转、缩放视角(可以绕到侧面和背面看尾巴) |

- **对话气泡**:每个动作都有一句台词,例如打招呼时说「嗨~」,开心时说「嘿嘿,好开心!」,比心时说「送你一颗小心心~」,打盹时是「Zzz…」。
  - 气泡带回弹效果地弹出,并跟着头部移动,不会挡住 Logo 和工具栏。
  - 说话时小狐狸会动嘴。
- **出场和离场**:
  - 打开页面时,小狐狸从画面左侧蹦跳着进场,然后挥手。
  - 点「离场」,它会挥手告别,然后蹦跳着离开画面;点「回来」,它又蹦跳着回来。
- **键盘打字**:
  - 在输入框里打字、按快捷键(Ctrl/⌘/Alt 组合)、只按修饰键时不会触发。
  - 手机上可以点工具栏的「打字」看 3 秒演示。
- **工具栏**:
  - 按钮分组:动作 · Logo · 休息 · 新功能 · 设置。
  - 正在播放的动作对应的按钮会高亮;当前模型没有的动作,按钮显示为不可用。
  - 在窄屏上只有工具栏横向滚动,页面本身不会。

平时的待机动画包括:呼吸、重心轻摆、尾巴从一侧摆到另一侧(尾巴是 6 节骨骼的弹簧链,跳跃和转身时会甩动)、随机眨眼、抖耳朵,偶尔左右张望。

URL 参数:
- `?mode=2d`:以 2D 版启动。
- `?quality=low`:低画质,适合低端手机。
- `?noui=1`:隐藏界面。
- `?logo=procedural`:使用代码生成的 Logo。
- `?debug=1`:冻结自动行为,截图时使用。

## 目录结构

```
reference/              参考图 1–5 与造型说明(图 6–8 的文字描述见 reference/README.md)
spec.json               模型与网页共用的约定:骨骼、表情、动作、材质、相机、Logo、键盘、碰撞体
tools/                  建模 / 绑定 / 动画 / 导出流水线(Python + Blender bpy)
  build.py              一键构建入口(--layers 另外导出 2D 分层用的姿势)
  fox_build/            config(比例、颜色、骨骼、爪子坐标系)、shapes(SDF 形体)、parts(颜色与权重)、
                        parametric(尾巴、围巾)、face(五官)、ao(环境光遮蔽)、rig、
                        poses(FK / IK / 带碰撞的手臂求解器)、clips(18 个动作)、layers(2D 分层)、logo、export
  validate_glb.py       模型校验(46 项,包括压缩后的发布文件)
  deform_qa.py          蒙皮形变检查(三角形拉伸 / 塌陷、穿地)
  motion_qa.py          动作平滑度检查(逐骨骼角加速度,找抽搐)
  clip_qa.py            穿模检查(手臂 / 头 / 围巾 / 尾巴 / 腿之间的穿插深度)
  export_psd.py         把 2D 分层导出为 PSD(models/fox_live2d_layers.psd)
models/fox.blend        Blender 工程(模型、骨架、权重、全部动作),可直接打开编辑
models/fox_live2d_layers.psd   2D 分层 PSD,可导入 Live2D Cubism Editor 做正式的 .moc3 绑定
web/                    Vite + Three.js 网页
  src/                  scene、fox、materials、animator(状态机)、procedural(视线 / 眨眼 / 尾巴弹簧链)、
                        interaction、logo、bubble(对话气泡)、keyboard(魔法键盘 + 打字)、heartfx(比心爱心)、ui、debug
  src/live2d/           2D 版:app(对外接口)、puppet(分层网格渲染)、rig(参数与变形器)、physics(钟摆物理)、
                        motions(关键帧动作)、controller(状态机)、props(Logo / 键盘 / 爱心 / Z 字)、render_layers(离线分层渲染)
  public/models/        fox.glb、logo.glb、clips.json
  public/live2d/        layers/*.png、layers.json、rig.json、composite.png
  scripts/              snap(截图)、interact(3D 交互测试)、mode_test(3D/2D 切换测试)、live2d_test(2D 测试)、
                        motion_live(网页端逐帧抽搐检测)、render_layers(生成 2D 分层贴图)
```

## 3D 模型与绑定

- **建模方式**:用 numpy 写有符号距离场(SDF)描述各部件,平滑并集得到毛绒玩具般的圆润形体。然后经过 marching cubes、pymeshlab 各向同性重网格,再把顶点投影回 SDF 表面,并用 SDF 梯度计算法线。
  - 尾巴(扫掠管,尾尖圆润收口)、围巾、五官用参数化网格生成。五官沿 SDF 光线投射贴合到脸上。
  - 耳朵是向前的杯状耳廓:外圈厚边,内侧凹陷为橙色,耳根有白色小凸点。
  - 手臂是一体的锥形手臂 + 圆润的连指手套式爪子,带 3 根手指和 1 根拇指。
- **颜色**:
  - 奶油白、白色面罩、腮红,以及爪、脚、内耳、尾尖的橙色渐变,都烘焙在顶点色里。
  - 环境光遮蔽(AO)也由 SDF 烘焙,存在 `_AO` 顶点属性里。
- **材质**:网页端用 Three.js 的 sheen 表现天鹅绒绒面;另有程序生成的细绒颗粒和针织纹理。
- **骨骼**:48 根,包括:
  - 身体、头。
  - 耳朵各 2 节。
  - 每侧手臂:上臂、前臂、爪、手指、拇指。
  - 腿各 3 节。
  - 尾巴 6 节。
  - 围巾垂端 2 节。
  - 呼吸骨骼。
  - 表情骨骼。
- **表情骨骼**:
  - 通过缩放显示或隐藏五官,可切换睁眼、^^ 笑眼、闭眼打盹、担忧眉、张嘴。
  - 任何 glTF 查看器打开时,默认显示睁眼 + 微笑。
- **动作(18 个)**:

  | 片段 | 说明 | 对应参考图 |
  |------|------|------------|
  | `Idle` | 待机(呼吸、尾巴左右摆) | — |
  | `Idle_LookAround` | 左右张望 | — |
  | `Wave` | 挥手(张开手指) | 图 2 |
  | `Happy` | 双爪合于胸前,眯眼笑 | 图 1 |
  | `Heart` | 比心(网页端会弹出爱心) | 图 7 |
  | `Present` | 手心朝上指向 Logo | 图 3 |
  | `Reach` | 踮脚够 Logo | 图 5 |
  | `Shrug` | 摊手 | 图 6 |
  | `SitDown` | 坐下 | — |
  | `Sit_Think` | 托腮思考 | 图 4 |
  | `Sit_Doze` | 打盹 | 图 8 |
  | `StandUp` | 起身 | — |
  | `Jump` | 跳跃(下蹲、腾空、落地挤压) | — |
  | `Pet` | 被抚摸 | — |
  | `LookBack` | 回头看尾巴 | — |
  | `Enter` | 蹦跳着进场并挥手 | — |
  | `Exit` | 挥手告别,蹦跳着离场 | — |
  | `Type` | 在魔法键盘上打字(循环) | — |

- **动作的生成方式**:
  - 动作由关键姿势 + 程序化叠加生成,每帧一个线性关键帧,不会因为贝塞尔插值过冲而抖动。
  - 爪子用**带碰撞的手臂求解器**摆放:在命中目标位置、爪子朝向和掌心朝向的同时,让手臂不穿进身体和头。
  - 挥手、比心等动作会把手指伸开;平时手指收成连指手套的样子。
  - 构建时对整段动作做平滑贴地,保证尾巴不穿地。
  - 手臂横在胸前时,围巾垂端会被塞到前臂后面(或者向前搭在手臂上),不会被手臂穿过。
  - 网页端在动作之上,再叠加视线跟随、眨眼、耳朵抖动,以及尾巴和围巾的弹簧二级运动。

## Live2D 风格 2D 版

- **做法**:
  - 从 3D 模型摆一个正面姿势,把每个部件(头、耳、眼、嘴、眉、身体、手臂、腿、尾巴、围巾……共 22 层)单独用正交相机渲染成 PNG,得到和 3D 版一模一样的画风。
  - 网页里把每层做成网格,按 Live2D Cubism 的参数方式驱动变形:
    - `ParamAngleX/Y/Z` 做头部转向,并带脸部视差。
    - 另有眨眼、笑眼、张嘴、呼吸、身体倾斜等参数。
  - 耳朵、围巾垂端和 5 节尾巴由钟摆物理驱动。
  - 动作(挥手、比心、坐下、打盹、跳跃、进场离场、打字等)是参数的关键帧曲线,行为状态机和 3D 版一致。
- **正式 Live2D 模型**:
  - 这个环境做不出 `.moc3`(需要 Live2D Cubism Editor)。
  - 仓库提供了分层 PSD `models/fox_live2d_layers.psd`,图层顺序和命名都已整理好,可以直接导入 Cubism Editor 做正式绑定。

重新生成 2D 分层:

```bash
.venv/bin/python tools/build.py --no-fox --no-logo --layers   # 导出正面姿势 fox_layers.glb 和 rig.json
node web/scripts/render_layers.mjs                            # 渲染 web/public/live2d/layers/*.png + layers.json
.venv/bin/python tools/export_psd.py                          # 生成 models/fox_live2d_layers.psd
```

## 重新生成 3D 模型(可选)

需要 Python 3.11(bpy 4.5 只支持 3.11)。

```bash
# Linux / macOS
python3.11 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
(cd web && npm install)                 # 提供 gltf-transform,用于压缩模型
.venv/bin/python tools/build.py         # 首次约 5–10 分钟(手臂求解有缓存,之后几分钟)
.venv/bin/python tools/validate_glb.py
.venv/bin/python tools/deform_qa.py
.venv/bin/python tools/motion_qa.py           # 检查未压缩的 build/fox.raw.glb
.venv/bin/python tools/clip_qa.py

# Windows(PowerShell)
py -3.11 -m venv .venv
.venv\Scripts\pip install -r tools\requirements.txt
cd web; npm install; cd ..
.venv\Scripts\python tools\build.py
```

- 比例、颜色、骨骼位置和尾巴曲线都在 `tools/fox_build/config.py` 里调整;形体细节在 `shapes.py`;动作在 `clips.py`。
- 在无图形界面的 Linux 容器上,pymeshlab 还需要:`apt-get install libopengl0 libglu1-mesa`。
- 调试时可以用 `--out-name m1` 把模型输出到 `web/public/models/dev/m1.glb`,然后在网页地址后面加 `?model=dev/m1.glb` 查看。

## 截图与测试

```bash
cd web
node scripts/snap.mjs refs turntable tail face   # 输出到 build/snaps/,可与 reference/ 对比
node scripts/interact.mjs                        # 3D 交互测试:点头、抚摸、Logo、打字、离场回来、拖尾巴、空闲坐下/打盹等
node scripts/mode_test.mjs                       # 3D / 2D 切换:工具栏、气泡、键盘都能驱动 2D 版,切回 3D 后继续运行
node scripts/live2d_test.mjs                     # 2D 版:所有动作、交互、空闲计时、反复启停
node scripts/motion_live.mjs                     # 在真实网页循环里逐帧检测骨骼抖动
```
