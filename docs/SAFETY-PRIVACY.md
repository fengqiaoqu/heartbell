# 安全与隐私模块（v2.6）

依据《Heartbell-v2.2-安全与隐私模块交付》（Safety Spec 1.0）实施，完成 M0–M3 的完整本地集成。
本文面向协作者：说明语义、接口、权限矩阵与 M4 正式启用前提。设计原文以交付包为准。

## 1. 五种动作的语义（相互独立）

| 动作 | 立即发生 | 不发生的事 |
|---|---|---|
| 撤销授权 | 停止指定资料的后续读取（含已打开页面刷新后） | 不影响其他 scope、关系与本人历史 |
| 关闭连接 | 关闭连接 + **双向撤权** | 不自动结束已有关系 |
| 屏蔽此人 | 双方候选不可见；拒绝新铃声/邀请/授权/共享；关闭现有连接；撤双向授权；取消待响应铃声与邀请 | **不自动结束关系、不扣履约分、不没收计划**；不向对方发送“被屏蔽”通知 |
| 举报 | 创建私密工单，给进度与结果 | 不影响业务状态与分数；可选“同时屏蔽”默认不勾选 |
| 结束绑定 | 立即结束 + **撤双向授权** + 冻结共享写入 | 不等待对方/审核/链上确认；屏蔽状态独立保留 |

解除屏蔽只移除本人屏蔽记录，**不恢复**旧连接、旧授权或已撤回内容；另一方向仍屏蔽时互动保持不可用（且不泄露对方是否屏蔽）。

## 2. 读取矩阵（privacy-policy.ts 集中执行）

| 资料 | 本人 | 当前对方 | 屏蔽或结束之后 | 运营 |
|---|---|---|---|---|
| 联系方式 | 可读 | 有效 profile_contact 授权 + 未关闭连接 + 未被屏蔽 | 不可读 | 默认不可读 |
| 履约摘要 | 可读 | 有效 trust_summary 授权（直接接口与 state 同规则） | 不可读 | 仅争议最小字段 |
| 从未分享的草稿/撤回版本 | 作者可读 | 不可读（日记详情 DTO 按版本裁剪） | 作者可读 | 不可调取 |
| 已分享未共同确认 | 作者可读 | 可读 | 仅作者可读 | 案内必要材料 |
| 双方已确认历史 | 可读 | 可读 | 只读归档保留 | 不得全量调取 |
| 存证证据包 | 参与者可导出 | 按记录权限 | 归档可读 | 无通用下载权限 |
| 举报材料/内部意见 | 本人仅自己的材料与 userMessage | 不可读 | 不变 | 被指派审核员最小可读（留痕审计） |

## 3. 用户端接口（`/api/v2`，均需 Demo 会话）

| 接口 | 说明 |
|---|---|
| `GET /privacy/overview` | 授权/屏蔽/举报计数、导出与注销状态 |
| `GET /privacy/grants` | 本人发出的授权（scope/对象/状态） |
| `POST /privacy/grants/revoke-all` | `connectionId + expectedActive`：撤销发给某人的全部授权 |
| `POST /privacy/exports` `GET /privacy/exports/{id}` `GET /privacy/exports/{id}/download` | 本人数据包（范围可选；不含 salt/他人草稿/后台意见；24h 有效，下载时再鉴权） |
| `POST /privacy/deletions` | 注销：`password`（再认证）+ `confirmation="注销"` + `endBindingConsent=true`；返回一次性受限查询凭据 |
| `GET /privacy/deletions/{id}/credential?credential=` | 独立受限凭据查询注销状态（原会话已全部撤销） |
| `GET /safety/target-context` | `sourceType/sourceId` → 脱敏标签 + 短期 targetRef（服务器签发并绑定调用者，7 天有效） |
| `GET/POST /safety/blocks`、`POST /safety/blocks/{id}/revoke` | 屏蔽列表 / 屏蔽级联 / 解除（expectedRevision） |
| `GET/POST /safety/reports`、`GET /safety/reports/{id}` | 举报列表 / 提交（10–1000 字、5 次/24h、同源同因复用工单）/ 详情（无内部意见与目标身份） |
| `POST /safety/reports/{id}/supplements|withdraw|appeals` | 补充（5–1000 字）/ 撤回（仅 submitted）/ 一次复核（结案后 7 天） |

## 4. 运营接口（`/api/v2/ops`，管理员会话 + RBAC + 审计）

| 接口 | 权限 | 说明 |
|---|---|---|
| `GET /safety/reports` | safety.read | 脱敏队列（不含举报人/被举报者身份） |
| `GET /safety/reports/{id}` | safety.read | 仅被指派审核员或主管（safety.restrict）；敏感读取写入脱敏审计 |
| `POST /safety/reports/{id}/assign` | safety.assign | 领取（他人已领取 → 409） |
| `POST /safety/reports/{id}/decisions` | safety.decide | resolved/rejected/need_supplement；userMessage（用户可见）与 internalReason（仅运营）分离；expectedRevision 版本保护 |
| `POST /safety/reports/{id}/appeal-decision` | safety.appeal | 复核：原审核员回避（409 REVIEWER_CONFLICT） |
| `POST /safety/restrictions` | safety.restrict | 限时发现/摇铃限制（1–30 天；不封锁退出/撤权/举报/申诉） |

角色映射（能力要求，非独立账号体系）：`safety_reviewer` = reviewer/owner 的 safety.read/assign/decide；`safety_supervisor` = owner（另含 appeal/restrict）。owner 也不能绕过回避规则读取非指派案件材料。

## 5. 状态机与产品参数

- 举报：`submitted → in_review →（awaiting_supplement → in_review）→ resolved/rejected`；`withdrawn`（仅 submitted）；复核 `appeal_requested → resolved/rejected`（结论保留历史）。
- 引用有效期 7 天；处理窗口 7 天；补充窗口 7 天；复核窗口 7 天；新举报 5 次/24h；限制 1–30 天。（产品参数，不是法定期限）
- 注销：`requested → processing → completed / completed_with_retention`。存在在途争议、未结案举报或已广播存证时必须显示受限保留，不得显示“所有数据已彻底删除”。

## 6. 演示边界与 M4 正式启用前提（未具备项，如实记录）

当前为**演示级集成**（与全项目一致的内存单进程仓库）：

1. 会话/仓库在内存中：重启即清空；多进程/serverless 部署不共享。M4 需接共享持久层与事务。
2. 导出任务为同步生成（状态机保留 queued→ready）；M4 需可恢复的异步 worker（OutboxJob 契约已在设计中）。
3. 注销的清理清单在演示环境真实执行（清资料/草稿/撤会话/撤权），但“备份恢复先重放删除清单”“链任务先对账再决定保留/取消”依赖持久层任务框架，未实现（T49–T51 未覆盖）。
4. `APP_MODE=live` 下所有 Demo 登录、演示台入口拒绝（未配置正式账号/会话体系前不可用）。
5. 附件 `dataUrl`、通知、文件引用已按对象与版本纳入权限裁剪；文件级独立存储权限（fileId 归属校验服务）待 P1。

验证：`npm run verify:safety`（76 项，覆盖 T01–T48 本地可演示部分；T49–T52 属 M4 依赖，明确未覆盖）。
