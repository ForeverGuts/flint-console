# flint-console

**flint 的第二张脸**：Agent 核心一行不动，在浏览器里跟它对话——流式回复、工具调用时间线、（规划中）安全闸拦截瞬间的可视化。

> 同一个大脑，两张脸：终端是第一张，浏览器是第二张。核心与脸之间只有一条 RPC 协议边界。

## 三句话

1. 新仓库通过 RPC 把 flint 拉起来当子进程，订阅它的事件流推给浏览器——零拷贝，flint 升级自动受益。
2. 同一套纯函数闸判定，终端里是方向键确认，浏览器里是（规划中的）确认按钮——判定不变，交互面变；判定永远在服务端，前端不可信。
3. 全程零依赖：Node 内置 http + SSE 推流 + 原生前端三件套，连工作台都没有一个 dependencies。

## 运行

前置：Node ≥ 22.18（原生直跑 TS，零转译）；flint 仓库放在本仓库隔壁 `../Flint`（或用环境变量 `FLINT_ROOT` 指过去）。

```bash
node server/main.ts        # 或 npm start
# 打开 http://localhost:3210
```

验证（默认套件零成本、不调 LLM）：

```bash
npm run verify             # SSE 7 项 + RPC driver 6 项
node verify/verify-e2e-chat.mjs   # 端到端真对话（显式花一次最小 LLM 调用）
```

## 结构

```
flint-console/
├── server/
│   ├── rpc-driver.ts   # spawn flint RPC 子进程；协议配对、超时判死、优雅关停（合stdin→等3s→强杀）
│   ├── sse-hub.ts      # 事件 → SSE 广播；Last-Event-ID 断线回放（环形缓冲 500 条）
│   ├── static.ts       # web/ 静态服务（路径穿越防护）
│   └── main.ts         # 装配：4 个 API + 静态兜底
├── web/
│   ├── app.js          # EventSource 收流 → 按判别式分发
│   ├── chat.js         # 聊天流（SSE chunk 直接追加——流式本身就是打字机）
│   ├── timeline.js     # 工具时间线 v0（note_search 打 RAG 标）
│   ├── gate.js         # 安全闸 v0（只显示 notice；确认按钮流留白）
│   └── index.html / style.css
├── verify/             # 2 个零成本套件 + 1 个 e2e（显式花钱）+ run-verify 汇总
└── docs/
    ├── 事件映射表.md    # M0 产出：内核事件 → RPC 出口 → 页面反馈 + 缺口清单
    └── 待拷问清单.md    # 下一步的分切点，grill-me 格式，每题带推荐答案
```

## 留白清单（刻意不写深，等你拍板）

| 留白 | 为什么留 | 去处 |
|---|---|---|
| 确认按钮流 | RPC 模式下 flint 权限自动放行，按钮流无源之水 | 待拷问 Q1 |
| 工具耗时/首字延迟 | 数据在 span 层，被刻意挡在契约外 | 待拷问 Q2 |
| 多页签并发 | flint chat 本版单飞 | 待拷问 Q4 |
| RAG 召回明细展示 | 链条长（侧车+flint 两处动） | 待拷问 Q6 |
| 会话回放/历史面板 | v1 单会话起步 | M2 后 |
| 暗色主题动效打磨 | 有数据才有动效 | M4 |

## 零依赖口径

`package.json` 无 dependencies、无 devDependencies。类型检查（tsc）待引入 devDeps 时一并来——当前靠 Node type stripping（仅可擦除语法）+ verify 行为证明兜底。
