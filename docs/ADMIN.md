# Heartbell 维护后台（/admin · v2.5）

依据《Heartbell-v2.1-后台设计交付》搭建的维护工作台：与用户端共用同一业务服务与状态（内存演示仓库），通过受控接口 `/api/v2/ops/*` 操作。本轮实现设计的 **M1 + M2（演示级）**；M3（Postgres 持久化、正式管理员账号体系、后台作业）为后续独立项目，未在本轮实现。

## 启动与登录

```bash
npm run dev
# 打开 http://localhost:3000/admin
```

演示测试账号（仅 `APP_MODE=demo` 有效；live 模式登录被服务端拒绝）：

| 账号 | 密码 | 角色 |
|---|---|---|
| `owner` | `heartbell-owner` | 负责人（全模块） |
| `owner2` | `heartbell-owner2` | 负责人（双人审批第二人） |
| `reviewer` | `heartbell-reviewer` | 审核（核验/复核/例外与库存审批） |

会话：HttpOnly Cookie + 服务端会话（8 小时绝对有效期、30 分钟空闲失效、退出即撤销、登录限速 10 分钟 5 次失败）。写请求校验 Origin 同源。

## 七个模块

| 模块 | 能力 | 关键规则 |
|---|---|---|
| 运行总览 | 四指标（待核验/例外/失败存证/可用玫瑰券）、按时限排序的待办、运行状态条 | 指标口径见设计 3.1；未连接真实链不计为失败 |
| 核验工作台 | 队列筛选、材料历史、规则核对、审核时间线、领取工单、通过/补正/不通过 | 需要原因码+说明；版本保护（expectedRevision）；补正必填缺失项（422）；未领取/非被指派人服务端拒绝 |
| 例外与申诉 | 计划例外（退款/维持失效/返回核验）、履约争议定向裁定 | 退款与维持失效需双人审批（申请人≠批准人）；返回核验必须有在途申请；trust 争议按单一责任人裁定，仅刷新受影响用户摘要 |
| 用户与关系 | 只读排障 | 只返回脱敏标识/成年声明/雷达/关系与计划状态/授权数；性取向、联系方式、日记正文不进入后台 DTO |
| 奖励与账本 | 账面/预留/可用、预留明细、账本、库存校正 | 校正只能追加账项并双人审批；减少不得低于已预留；成功结算预留最终为 consumed |
| 存证任务 | 任务列表、按 jobId+contentVersion 精确重试 | failed/reorged 可重试；queued（暂停排队）恢复后重试；confirmed 禁止；unconfigured 显示配置缺口；不暴露 salt/payload |
| 运行与审计 | 运行状态、功能配置与公告（双人审批发布）、审计日志 | 暂停只影响新的雷达/计划/存证提交（服务端执行 503 MAINTENANCE）；用户端 ≤3 秒看到公告；回滚=发布新版本 |

## 用户端联动

- 审核结论 → 双方站内通知（顶部铃铛）+ 相守页状态与理由。
- `need_more` → 用户在相守页直接补充材料（`POST /api/v2/plans/claims/supplement`，原 claimId、材料只追加、重新计算 7 天审核期限）。
- 维护公告 → 用户端顶部横幅；暂停开关同时禁用对应按钮（服务端拒绝优先）。

## 接口清单（/api/v2/ops）

- 会话：`POST /login`、`POST /logout`、`GET /session`
- 总览：`GET /overview`
- 核验：`GET /claims?status=`、`GET /claims/:id`、`POST /claims/:id/assign`、`POST /claims/:id/decision`
- 例外/争议：`GET /cases`、`POST /exceptions/:planId/resolution-requests`、`POST /trust-disputes/:disputeId/resolve`
- 审批：`GET /approvals`、`POST /approvals/:id/approve`、`POST /approvals/:id/reject`
- 用户/关系：`GET /users`、`GET /relationships`（脱敏只读）
- 奖励：`GET /rewards`、`POST /inventory/adjustment-requests`
- 存证：`GET /anchors`、`POST /anchors/:jobId/retry`
- 系统：`GET /system/health`、`GET /system/config`、`POST /config/drafts`、`GET /audit`

权限矩阵见 `src/lib/domain/admin-types.ts`（角色 × 权限点，服务端逐接口校验）。

## 边界与待接入（诚实声明）

- 数据为内存演示仓库，服务重启清空；未做数据库迁移/事务/后台到期 worker（设计 M3）。
- 管理员为演示测试账号；正式环境必须由服务器工具引导账号体系后才可解除登录限制。
- 存证真实链提交仍为占位（preview = 本地承诺指纹，诚实标注未连接真实链）。
- 核验材料全部为演示材料，不代表接入婚姻登记机构。
- 幂等：账本沿用 businessKey 唯一；Idempotency-Key 请求头机制未在本轮实现。

## 验证

```bash
npm run dev
DEMO_URL=http://localhost:3000 npm run verify:v25   # 68 项 v2.5 专项
DEMO_URL=http://localhost:3000 npm run verify:v2    # 103 项回归 + 26 项合约
```
