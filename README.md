# 小狐狸 · 3D 模型 + 骨骼绑定 + 网页交互动画

根据 `reference/` 中的参考图,从零制作的 Q 版植绒小狐狸与品牌 Logo(4 个奶白方块 + 橙色四角星)。
内容包括:程序化建模、骨骼绑定、15 个动作片段,以及一个带待机动画和交互动画的 Three.js 网页。

> 原图尾巴的透视不对(像一张贴在画面上的平面)。3D 模型里已改为真实透视:尾根在臀部后方中线,尾巴向后、向上弯,并偏向狐狸左侧,
> 所以从正面 3/4 视角看,尾巴会从身体右后方露出来,且有正确的遮挡和前后缩短。尾巴中线长约 0.69(整只狐狸高 1.0),比原图加长约 15–20%。
> 在网页里拖动旋转视角,就能从侧面和背面看到立体的尾巴。

## 快速开始(只看网页)

```bash
cd web
npm install
npm run dev          # 打开终端里显示的地址,例如 http://localhost:5173
npm run build        # 生成静态站点到 web/dist,可部署到任意静态托管
```

模型文件 `web/public/models/fox.glb`、`logo.glb`、`clips.json` 已经构建好并提交到仓库,只看网页不需要 Python 或 Blender。

### 交互说明

| 操作 | 反应 |
|------|------|
| 移动鼠标 | 头和视线跟随鼠标(可在工具栏关闭「跟随鼠标」) |
| 点头 | 开心(双爪合于胸前,眯眼笑) |
| 点耳朵 | 抖耳朵 |
| 点身体 | 随机打招呼或摊手 |
| 点尾巴 | 回头看尾巴并甩尾 |
| 在头上拖动(抚摸) | 被摸时眯眼蹭手、尾巴快摇;松手后比心 |
| 双击狐狸 | 跳跃 |
| 鼠标悬停 Logo(手机上轻点) | 看向 Logo,手心朝上指向它 |
| 点击 Logo | Logo 激活:星星居中,方块环绕旋转;狐狸踮脚去够 |
| 15 秒无操作 | 坐下托腮思考 |
| 30 秒无操作 | 打盹,飘出 Z 字;再点一下会起身挥手 |
| 拖动空白处 / 滚轮 | 旋转、缩放视角(可以绕到侧面和背面看尾巴) |

底部工具栏的按钮也能直接触发各个动作:打招呼、开心、比心、摊手、指向Logo、够Logo、跳跃、坐下、打盹。另外还有「跟随鼠标」开关和「重置视角」。
页面入场时,狐狸会弹出并挥手。平时的待机动画包括:呼吸、重心轻摆、尾巴摆动、随机眨眼、抖耳朵,偶尔左右张望。

URL 参数:
- `?quality=low`:低画质,适合低端手机。
- `?noui=1`:隐藏界面。
- `?logo=procedural`:使用代码生成的 Logo。
- `?debug=1`:冻结自动行为,截图时使用。

## 目录结构

```
reference/              参考图 1–5 与造型说明(图 6–8 的文字描述见 reference/README.md)
spec.json               模型与网页共用的约定:骨骼、表情、动作、材质、相机、Logo、碰撞体
tools/                  建模 / 绑定 / 动画 / 导出流水线(Python + Blender bpy)
  build.py              一键构建入口
  fox_build/            config(比例、颜色、骨骼)、shapes(SDF 形体)、parts(颜色与权重)、
                        parametric(尾巴、围巾)、face(五官)、ao(环境光遮蔽)、rig、poses(FK/IK)、
                        clips(15 个动作)、logo、export
  validate_glb.py       模型校验(46 项)
  deform_qa.py          蒙皮形变检查(所有动作的三角形拉伸 / 塌陷 / 穿地)
models/fox.blend        Blender 工程(模型、骨架、权重、全部动作),可直接打开编辑
web/                    Vite + Three.js 网页
  src/                  scene、fox、materials、animator(状态机)、procedural(视线/眨眼/弹簧)、
                        interaction、logo、ui、debug
  scripts/snap.mjs      无头浏览器批量截图(与参考图对比)
  scripts/interact.mjs  交互自动化测试(24 项)
  public/models/        fox.glb、logo.glb(meshopt 压缩)、clips.json
```

## 模型与绑定

- **建模方式**:用 numpy 写有符号距离场(SDF)描述各部件,平滑并集得到毛绒玩具般的圆润形体。然后经过 marching cubes、pymeshlab 各向同性重网格,再把顶点投影回 SDF 表面,并用 SDF 梯度计算法线。
  - 尾巴、围巾、五官用参数化网格生成。
  - 五官是沿 SDF 光线投射贴合到脸上的。
- **颜色**:奶油白、白色面罩、腮红,以及爪/脚/内耳/尾尖的橙色渐变,都烘焙在顶点色里。环境光遮蔽(AO)也由 SDF 烘焙进 `_AO` 顶点属性。
- **材质**:网页端用 Three.js 的 sheen 表现天鹅绒绒面;另有程序生成的细绒颗粒和针织纹理。
- **骨骼**:44 根。包括身体、头、耳朵各 2 节、手臂 4 节、腿 3 节、尾巴 6 节、围巾垂端 2 节,另有一根呼吸骨骼。
- **表情骨骼**:通过缩放显示或隐藏五官,可切换睁眼、^^ 笑眼、闭眼打盹、担忧眉、张嘴。任何 glTF 查看器打开时,默认都显示睁眼 + 微笑。
- **动作(15 个)**:

  | 片段 | 说明 | 对应参考图 |
  |------|------|------------|
  | `Idle` | 待机 | — |
  | `Idle_LookAround` | 左右张望 | — |
  | `Wave` | 挥手 | 图 2 |
  | `Happy` | 开心 | 图 1 |
  | `Heart` | 比心 | 图 7 |
  | `Present` | 指向 Logo | 图 3 |
  | `Reach` | 踮脚够 Logo | 图 5 |
  | `Shrug` | 摊手 | 图 6 |
  | `SitDown` | 坐下 | — |
  | `Sit_Think` | 托腮思考 | 图 4 |
  | `Sit_Doze` | 打盹 | 图 8 |
  | `StandUp` | 起身 | — |
  | `Jump` | 跳跃 | — |
  | `Pet` | 被抚摸 | — |
  | `LookBack` | 回头看尾巴 | — |

  - 动作由关键姿势加程序化叠加生成,用解析双骨 IK 摆放爪子。
  - 构建时会自动贴地,并保证尾巴不穿地。
  - 网页端在动作之上,再叠加视线跟随、眨眼、耳朵抖动,以及尾巴和围巾的弹簧二级运动。

## 重新生成模型(可选)

需要 Python 3.11(bpy 4.5 只支持 3.11)。

```bash
# Linux / macOS
python3.11 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
(cd web && npm install)                 # 提供 gltf-transform,用于压缩模型
.venv/bin/python tools/build.py         # 约 1–2 分钟;SDF 网格有缓存,只改颜色/权重/动作时只需几秒
.venv/bin/python tools/validate_glb.py
.venv/bin/python tools/deform_qa.py

# Windows(PowerShell)
py -3.11 -m venv .venv
.venv\Scripts\pip install -r tools\requirements.txt
cd web; npm install; cd ..
.venv\Scripts\python tools\build.py
```

- 所有比例、颜色和尾巴曲线都在 `tools/fox_build/config.py` 里调整;形体细节在 `shapes.py`;动作在 `clips.py`。
- 在无图形界面的 Linux 容器上,pymeshlab 还需要:`apt-get install libopengl0 libglu1-mesa`。

## 截图与测试

```bash
cd web
node scripts/snap.mjs refs turntable tail face   # 输出到 build/snaps/,可与 reference/ 对比
node scripts/interact.mjs                        # 交互测试:点头、抚摸、Logo、空闲坐下/打盹等
```
