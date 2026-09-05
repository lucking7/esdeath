# MirrRule 收口与清理计划

> 状态：执行中（A/B 已完成，C2 分批推进中）
> 背景：本项目核心代码与逻辑源自 [SukkaW/Surge](https://github.com/SukkaW/Surge)（AGPL-3.0），
> 之后从"自行解析 adblock 过滤表生成规则"发散为"聚合上游成品规则文件、按平台转发输出"。
> 规模：74 个 TS 文件，约 14.4k 行。

## 当前实际构建链

```
Build/index.ts
  └─ RuleSourceProcessor (lib/rule-source-processor.ts)
       └─ EnhancedFileOutput (lib/enhanced-file-output.ts)
            └─ createStrategiesForTargets (lib/platform-config.ts)
                 └─ core/output/writing-strategy/{surge,clash,singbox,loon}
```

发散后，Sukka 原有的 adblock 解析子系统（`lib/parse-filter/*`）与部分"富规则生成"
输出变体已不在该链路上，成为孤儿。

---

## 工作流 A：收口（发散遗留）

- [x] **A1. 移除孤立的 `parse-filter/` 子系统**（最大发散残留）
  - 删除 `lib/parse-filter/`（`filters.ts` 641 行、`domainlists.ts`、`hosts.ts`、`line-helpers.ts`、`shared.ts`）
  - 连带移除依赖 `@ghostery/adblocker`
- [x] **A2. 收敛三层输出抽象**
  - 现状：`lib/enhanced-file-output.ts` 独立持有规则状态、完成处理与汇总；`core/output/writing-strategy/*` 保留四个平台 adapter，已移除 `FileOutput` inheritance seam。
  - 砍掉聚合流程未用的变体：`SurgeDomainSet` / `ClashDomainSet` / `ClashIPSet` / `SurgeMitmSgmodule` / `SurgeRuleSetPayload`
  - 目标：只保留聚合器真正用到的 RuleSet 输出路径
- [x] **A3. 统一许可证与元数据**
  - `package.json` 的 `"license": "ISC"` → 改为 `AGPL-3.0`（与 `LICENSE`、README 一致）
  - 补全 `author` / `description`
  - 增加对 SukkaW/Surge 的署名（README credit 或 `NOTICE`），满足 AGPL 衍生合规
- [x] **A4. 统一/说明命名**
  - 三套名称：`MirrRule`(源码仓) / `NRRule`(部署输出仓，见 `main.yml:318`) / `nrrule.pages.dev`(包名+CDN)
  - 在 README 说明三者关系，或统一命名
- [x] **A5. 去除动态 require**
  - `index.ts` 中 4 处 `require('./xxx.ts')` 及其他懒加载 → 改为静态 `import`
  - 收益：恢复静态类型检查 / 可打包 / 可被 knip 正确分析

---

## 工作流 B：死代码 / 未用清理

- [x] **B1. 删除整文件死代码（零引用，约 1000+ 行）**

  | 文件 | 行数 | 说明 |
  |---|---|---|
  | `lib/parse-filter/`（5 文件） | ~750 | 见 A1 |
  | `utils/network/http-cache.ts` | 139 | 旧缓存实现（现用 undici cache store） |
  | `lib/cache-apply.ts` | 33 | 无引用 |
  | `constants/description.ts` | 14 | 无引用 |
  | `constants/reject-data-source.ts` | — | 无引用 |
  | `lib/rules/ip.ts` | 20 | 无引用（连带 `ClashIPSet` 死） |

- [x] **B2. 移除未用依赖（13 个零引用）**
  - `@henrygd/queue`、`@mitata/counters`、`cli-progress`、`csv-parse`、`dns2`(git 锁定依赖)、
    `fast-fifo`、`fast-uri`、`fdir`、`hash-wasm`、`null-prototype-object`、`worktank`、`xbits`、`yauzl-promise`
  - `@ghostery/adblocker`：随 A1 删除
  - ⚠️ **保留 `better-sqlite3`**：它是活依赖 `undici-cache-store-better-sqlite3` 的运行时 peer
  - devDep：删 `@types/cli-progress`、`tinyexec`(零引用)；`@types/punycode` / `@eslint-sukka/node` 谨慎评估
- [x] **B3. 修复破损脚本（引用未安装的二进制）**
  - `format` / `format:check` → `prettier`（未安装）
  - `build-profile` / `dexnode` → `dexnode`（未安装）
  - 处理：补依赖 或 删脚本
- [x] **B4. 清理未用导出（71 处）**
  - 集中在 `plugin-converter/*` 与 `mirror-sync/sync-engine.ts`（deslop/simplify 内联后遗留的 `export`）
  - 改为内部函数（去掉 `export`）
- [x] **B5. 接入 knip 防回潮**
  - 加 `knip` 配置与 CI 检查，防止死代码/未用依赖再次堆积

---

## 工作流 C：质量提升

- [x] **C1. 补测试覆盖**：当前 1.44 万行仅 1 个测试文件。优先覆盖核心管线
  （`rule-source-processor`、`enhanced-file-output`、`policy-cleaner`、各 writing-strategy）
- [ ] **C2. 收紧类型**：清理 150 条 lint warning（`any`、`await-in-loop`、`no-unnecessary-condition` 等），逐步收紧 `tsconfig`
  - 已推进：移除 Script-Hub 插件转换中不再使用的 deprecated 兼容路径，统一到远程 URL 转换路径。
- [ ] **C3. 优化 CI**：4 个 cron + 频繁全量构建 + 双部署；合并/降频；升级 `cloudflare/wrangler-action@v3`（仍跑 Node 20，将弃用）
- [ ] **C4. 依赖瘦身收益**：B2 后 `pnpm install` 更快、锁文件更小、供应链攻击面更小
- [x] **C5. 补架构文档**：`ARCHITECTURE.md` 说明"源自 Sukka、已发散为聚合器"，标注死代码区，避免再次踩坑
  （deslop 误删 `node:buffer`/`node:process` import 导致 CI 红一天，即是缺文档的代价）
- [ ] **C6. 统一错误处理 / 可观测性**：减少 `try/catch` 吞错，统一上报

---

## 建议执行顺序（每步独立、低风险，单独 PR）

1. **阶段一（B）死代码/死依赖清理 + knip 接入** — 收益快、风险低
   - B1 + B2 + B3 + B5，`pnpm install` 重生成 lockfile，`pnpm run validate` 跑绿
2. **阶段二（A2）收口输出抽象** — 砍未用变体，简化三层结构
3. **阶段三（A3/A4）许可证/命名/署名统一** — 纯文档与元数据
4. **阶段四（C1）补核心测试**
5. **阶段五（A5 + C2/C3）静态 import 化 + 收紧类型 + CI 优化**

## 验证清单（每个 PR 必过）

- [ ] `pnpm run validate`（ESLint 0 error + `tsc --noEmit` 通过）
- [ ] `pnpm test` 通过
- [ ] `pnpm run build` 端到端跑绿（CI 的 Build job）
- [ ] knip 无新增 unused（阶段一后）

## 风险与回滚

- 删依赖前先确认非 peer/非动态加载（已逐一核实；`better-sqlite3` 例外，保留）
- 每阶段独立分支 + PR，CI 必需检查 `Build` 通过方可合并
- 大改动前打 `backup/*` 标签便于回滚
