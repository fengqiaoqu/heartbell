# 更新日志（Changelog）

本文件面向协作者，记录每个版本的修改内容、根因与验证情况。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与 Git 标签对应。

## [v2.6] - 2026-10-07

依据《v2.6修改.md》：①依据《Heartbell-v2.5-Demo登录交付》搭建登录系统；②依据《Heartbell-v2.2-安全与隐私模块交付》搭建安全与隐私模块（M0–M3 完整本地集成）。
分支 `feature/v2.6-login-safety`（自 v2.5 基线 `bf715e5` 创建，保留全部 v2.5/v2.2 成果），标签 `v2.6`。模块边界与 M4 前提见 `docs/SAFETY-PRIVACY.md`。

### 新增

- **Demo 登录系统（v2.5 交付）**：
  - 新增 `/login` 登录页（品牌视觉、420px 居中卡片、360px 无横向溢出；账号/密码/显示切换/Enter 提交/错误统一文案“账号或密码不正确”）；
  - 预置演示账号（公开凭据，README 列出）：`a / HeartbellA2026!`、`b / HeartbellB2026!`，v2.6 另增安全验证第三人 `c / HeartbellC2026!`；账号 trim + 转小写、密码区分大小写（scrypt + timingSafeEqual，服务端专用）；
  - **双 Cookie 槽位会话**：`hb_demo_a` / `hb_demo_b` / `hb_demo_c` 各存高熵 sessionId（randomBytes(32)），服务端内存会话表（globalThis 独立键，不与业务 state/opsStore 混用），真实时间 8 小时有效（虚拟业务时钟不影响），HttpOnly/SameSite=Lax/Path=/、Max-Age=28800；同浏览器 A/B 可同时登录互不覆盖；
  - **服务器会话门禁**：`/api/v2` 全部普通用户路由在读取/修改业务及 sweep 之前校验会话（未登录 401 且不触发业务写入）；body.viewer 与 query.viewer 冲突返回 400；a 的 token 放入 b 槽位、仅登录 a 却请求 viewer=b 均被拒；旧 `/api/demo` 同一口径（无免登录兼容通道）；`/demo/a|b|c` 页面服务端校验会话，未登录 302 到对应登录页（携带原栏目）；
  - 三个接口：`POST /api/demo-auth/login`（返回 viewer/nickname/expiresAt/redirectTo，不返回 token）、`GET /api/demo-auth/session`、`POST /api/demo-auth/logout`（只撤销对应槽位，不影响另一账号或 `hb_ops_session`；重复退出成功）；登录/登出/用户写请求做同源 Origin 检查；
  - 客户端：首页 A/B 入口改为 `/login?account=a/b&tab=meet`；应用壳遇 401 停止轮询、清空业务视图并回对应登录页；「我的」显示登录账号 + 退出登录；
  - 边界保持：`/admin` 与 `/api/v2/ops/*` 沿用管理员会话（用户 Cookie 不能通过 ops 校验）；`/demo/admin` 与 `/api/v2/admin/*` 保持 APP_MODE=demo 演示工具边界；`APP_MODE=live` 拒绝 Demo 登录与会话（NODE_ENV=production + APP_MODE=demo 仍可演示）。
- **安全与隐私模块（v2.2 交付，M0–M3）**：
  - **集中隐私策略** `src/lib/server/v2/privacy-policy.ts`：按对象/连接/版本/屏蔽状态判断读取；联系方式与履约摘要读取 = 有效授权 + 未关闭连接 + 未被屏蔽；`view.ts`（连接档案/联系方式/摘要/通知/雷达候选）、`diary.ts` 详情、`trust.ts` 直接接口逐入口接入；
  - **撤权级联修复**：关闭连接、结束绑定、屏蔽、注销统一撤销双向全部授权（此前旧授权在连接关闭/关系结束后仍可通过独立接口读取）；
  - **日记版本裁剪**：`GET /diaries/detail` 不再返回原始 doc——私人草稿与已撤回版本仅作者可见；屏蔽后仅双方已确认版本保留为只读归档（T10–T13）；
  - **屏蔽/解除**：`targetRef` 由服务器按铃声/连接/关系来源签发（绑定调用者、7 天有效；未揭晓对象仅显示“相遇对象 · XN9”式临时标签）；屏蔽级联 = 复用 active block → 关闭连接 → 撤双向授权 → 取消待响应铃声/邀请（同一逻辑事务）；**关系不自动结束、计划不自动扣分/没收、退出与申诉保持可用**；解除屏蔽带 expectedRevision 且不恢复任何旧状态；受限操作返回中性“当前无法继续此操作”；
  - **举报闭环**：六种原因、10–1000 字说明、可选“同时屏蔽”（默认不勾选，同事务提交）；频率限制 5 次/24h（429）、同源同因未结案复用工单；补充/撤回（仅 submitted）/一次复核（7 天窗口）；状态与用户可见结论（userMessage）与内部意见（internalReason）严格分离；
  - **运营举报工作台**：`/admin` 新增「安全工单」模块（脱敏队列、领取、补正、结案、复核、限时限制）；`/api/v2/ops/safety/*` 受控接口 + 新权限点 `safety.read/assign/decide/appeal/restrict`（owner 全部、reviewer 含 appeal、support 只读队列）；未领取不可读案内材料、非受理人不能裁定、旧 revision 409、原审核员复核自己案件 409（回避）；敏感材料读取写入脱敏审计（`privacyAudits`，不记原文/联系方式/salt/令牌）；限时发现/摇铃限制不封锁救济操作；
  - **我的数据**：`GET /privacy/overview`、`/privacy/grants`（含 revoke-all）；数据导出（范围可选 profile/contacts/diaries/promises/ledger/notifications，24h 有效，下载时再鉴权；**不含**存证 salt、他人草稿、后台内部意见）；注销账号（密码再认证 + 输入“注销” + 明确同意结束绑定；立即撤会话/撤权/停止发现/结束绑定；演示环境真实清理个人资料与未共同确认草稿；在途争议/举报/已广播存证按受限保留诚实标注，独立受限凭据只查注销结果）；
  - 用户端 UI：「我的 → 安全与隐私」中心（总览/授权/屏蔽/举报/我的数据五栏）；了解页连接卡片、关系设置、收到铃声弹层新增举报/屏蔽入口；屏蔽确认固定文案“屏蔽不会自动结束当前绑定”，解除提示“不会恢复此前的连接和授权”；
  - 新增演示第三人 **c**（小柯，`def:star` 头像）用于负面权限验证（始终无权读取 A/B 授权内容）。

### 修复

- 关闭连接后 `trust/summary` 独立接口仍可用旧授权读取（T08）——closeConnection 现在级联撤权。
- 结束绑定后旧授权仍可读取联系方式与摘要（T09）——endRelationship 现在级联撤权。
- 日记详情接口返回完整 doc（含对方从未分享的草稿，T10/T11）——改为按版本裁剪的 DTO。
- 屏蔽后旧站内提醒仍透出待确认日记标题（T58）——通知按策略过滤。

### 变更

- `package.json` 版本升至 `2.6.0`；新增 `npm run verify:login`、`npm run verify:safety`。
- `V2User` 新增 `disabledAt` 字段、`V2State` 新增 `blocks/safetyReports/safetyTargetRefs/restrictions/privacyAudits/dataExports/deletions` 集合：P1 持久化适配器需同步建列。
- `AdminPermission` 新增 `safety.*` 五个权限点（角色矩阵见 `docs/SAFETY-PRIVACY.md` 第 4 节）。
- 既有验证脚本（verify:v2 / verify:demo / verify-v22 / verify-v25）全部改为先登录并携带双槽位 Cookie，原有断言保留。

### 涉及文件（主要）

| 层 | 文件 |
|---|---|
| 登录服务端 | `src/lib/server/demo-auth.ts`（新增）、`src/app/api/demo-auth/{login,session,logout}/route.ts`（新增）、`src/app/login/`（新增） |
| 登录接入 | `src/app/api/v2/[...path]/route.ts`（会话门禁+参数化路由）、`src/app/api/demo/route.ts`、`src/app/demo/[user]/page.tsx`、`src/app/page.tsx`、`src/components/journey/app-shell.tsx`、`me-drawer.tsx`、`src/lib/server/v2/session.ts` |
| 安全领域 | `src/lib/domain/safety-types.ts`（新增）、`v2-types.ts`（disabledAt）、`admin-types.ts`（safety.* 权限） |
| 策略与服务 | `src/lib/server/v2/privacy-policy.ts`（新增）、`services/safety.ts`（新增）、`services/privacy.ts`（新增）、`meet.ts`/`relationship.ts`/`trust.ts`/`diary.ts`/`view.ts`（策略接入与级联） |
| 运营 | `src/app/api/v2/ops/[...path]/route.ts`（安全工单接口）、`src/app/admin/page.tsx`（安全工单模块） |
| 用户端 UI | `src/components/privacy/safety-center.tsx`（新增）、`know-tab.tsx`/`us-tab.tsx`/`app-shell.tsx`（对象菜单）、`modules.css` |
| 数据 | `demo-repo.ts`（安全集合、用户 C、pushPrivacyAudit） |
| 文档/验证 | `docs/SAFETY-PRIVACY.md`（新增）、`scripts/verify-demo-login.mjs`（新增）、`_qa/verify-safety.mjs`（新增）、4 个既有脚本适配 |

### 验证

- 专项：`npm run verify:login` —— **39 项**（登录/凭据/槽位保护/未登录拒绝/页面门禁/双窗口/退出/时钟/Origin）全部通过；`npm run verify:safety` —— **76 项**（授权闭环 T01–T09、日记裁剪 T10–T14、屏蔽级联 T15–T21、举报与运营闭环、导出与注销）全部通过。
- 回归：`npm run verify:v2` 103 项 + 合约 26 项、`_qa/verify-v22.mjs` 38 项、`npm run verify:v25` 68 项、`npm run verify:demo`（V1 旧接口，先登录再调用）全部通过。
- 工程：`npm run typecheck`、干净 `npm run build` 通过。
- 未覆盖（M4 依赖，非演示范围）：T49 删除与链任务对账、T50 worker 重试恢复、T51 备份恢复重放删除清单、T52 真实模式 viewer 拒绝——已记录于 `docs/SAFETY-PRIVACY.md` 第 6 节。

### 协作者注意

- **验证脚本现在必须先登录**：用户接口不再接受裸 viewer 调用；脚本助手已内置登录（`DEMO_URL` 指向运行中的服务）。本地浏览器操作请从 `/login` 进入。
- 会话表/安全数据均在内存（重启清空）：P1 持久化需为 `hb_demo_*` 会话与 7 个新集合建表；注销的“备份恢复重放删除清单”依赖持久层任务框架。
- c 账号是公开演示凭据（用于验证“未授权者始终读不到”），勿用于双人主流程演示。
- 后台演示账号不变（owner/owner2/reviewer）；reviewer 新增 `safety.appeal`（复核回避由服务端按案件校验，不依赖角色自觉）。
- 本期用户登录为**单进程本地演示**（注册未实现；`/demo/admin` 与 `/api/v2/admin/*` 仍为独立演示工具，不宣称全服务已满足正式上线安全要求）。

## [v2.5] - 2026-10-07

依据《v2.5修改.md》6 条建议 + GitHub 提交要求逐条落地。分支 `feature/v2.5-admin-workbench`，标签 `v2.5`。
《v2.5修改.md》中的“疑问”部分（默认头像、已确认文案、上链信息保留、阶段自动隐藏）按要求**仅记录、未修改**。

### 新增

- **维护后台系统（反馈 1，依据《Heartbell-v2.1-后台设计交付》M1+M2 演示级）**：
  - 新增 `/admin` 七模块工作台：运行总览、核验工作台、例外与申诉、用户与关系、奖励与账本、存证任务、运行与审计；奶油/玫瑰/深梅侧栏视觉按设计交付 03-UI 规格；
  - 新增受控接口 `/api/v2/ops/*`（`src/app/api/v2/ops/[...path]/route.ts` + `src/lib/server/ops/`）：管理员会话（HttpOnly Cookie、8h/30min 失效、登录限速、Origin 同源校验）、五角色 RBAC（服务端逐接口校验，隐藏按钮不算数）、全操作审计日志；
  - **核验闭环**：用户提交申请 → 后台队列真实出现 → 领取工单 → 通过/补正/不通过（原因码+说明+expectedRevision 版本保护）→ 用户端约 3 秒内看到结论与理由，双方收到站内通知；
  - **补正闭环（衔接缺口 1）**：新增 `POST /api/v2/plans/claims/supplement` 与相守页补正表单——`need_more` 状态下用户补充材料回到 `submitted`，保留原 claimId，材料只追加（`materials[]`），重新计算 7 天审核期限；
  - **双人审批**：例外退款/维持失效、库存校正、功能配置发布均需第二位管理员批准（申请人≠批准人，409 SECOND_APPROVER_REQUIRED；功能配置仅 owner 可批准）；配置发布为追加新版本（回滚=再发布），历史保留；
  - **功能暂停与公告（ADM-07）**：`FeatureConfig`（雷达/新计划/存证提交开关 + ≤120 字公告）；服务端同步执行限制（503 MAINTENANCE），用户端 `publicMaintenance` 轮询读取并显示顶部横幅、停用对应按钮；存证暂停期间任务排队不丢内容，恢复后由运维按 jobId 重试；
  - 例外复核起点 `exceptionOpenedAt`（衔接缺口 4）：所有进入例外状态的路径（用户例外申请/申诉/关系结束/审核超时清扫）统一设置，30 天时限从该点起算；
  - 履约争议**定向裁定**（衔接缺口 2）：`DisputeV2.subjectUserId` 指向单一责任人，后台按 `disputeId + subjectUserId` 裁定，只改写被复核责任人、只刷新受影响用户的摘要版本（旧批量路径保留为演示台兼容，可选传 subjectUserId）；
  - **结算预留修正（衔接缺口 3）**：`redeemBenefit` 不再先释放再消费预留，成功结算的预留最终状态为 `consumed`（取消/失效才是 `released`）；
  - **存证按 jobId 精确重试（衔接缺口 6）**：后台重试按 `jobId + contentVersion` 定位（不沿用 recordId 取第一个任务），保留同一 commitment/salt/版本，attempts 递增；confirmed 禁止重发，unconfigured 显示配置缺口；
  - 审核决定/补正/复核结论均递增 claim 与 plan 的 revision（衔接缺口 5）。
- **站内通知（反馈 4）**：`NotificationV2` 与业务变化同事务写入；核验结论、日记/承诺/履约证据待确认均产生提醒；用户端顶部新增铃铛（未读数角标）与通知列表，支持全部已读。
- **附件上传（反馈 6）**：日记/纪念节点/承诺支持上传 **png / jpg / pdf / md / word（doc·docx）**：每条记录最多 6 个（与演示图合计）、单个 ≤600KB；服务端 `resolveAttachments` 校验扩展名/MIME 一致性/大小/数量并计算内容指纹（进入版本比较与存证 `attachmentHashes`）；查看侧图片出缩略图、文件可下载；仅存本地演示内存仓库。
- **头像点开放大（反馈 2）**：新增 `AvatarZoom` 组件，「我的」与「了解」页的主要头像位点击后放大查看（230px 舞台 + 放大角标）。

### 修复

- **生成凭证后需关闭界面才显示（反馈 5）**：日记「为这一版生成存证」成功后立即重新拉取详情，弹层内按钮自动变为「查看证据」、状态行出现存证徽标，无需关闭重开。
- **秒数计时不稳定（反馈 3）**：雷达倒计时取消秒数，只显示分钟（向上取整，不出现“0 分钟”）；底层到期时间计算仍以服务端虚拟时钟为准（v2.2 的防重置修复不受影响）。

### 变更

- 「我们」页新增**待确认栏（反馈 4）**：置顶红色描边卡片汇总所有需要我处理的项目（日记版本确认/承诺确认/履约证据确认/关系邀请），点击直达对应弹层；底部导航「我们」图标右上角改为**红色数字角标**（其余栏保持小圆点）；有待确认事项且不在“我们”页时顶部显示提醒横幅。
- 用户端「演示说明」折叠区与落地页新增 `/admin` 维护后台入口；旧 `/demo/admin` 演示台保留不动（正式环境服务端同样拒绝）。
- `package.json` 版本升至 `2.5.0`；新增 `npm run verify:v25`。

### 涉及文件（主要）

| 层 | 文件 |
|---|---|
| 领域类型 | `v2-types.ts`（ClaimMaterial/GoalClaim 扩展/NotificationV2/FeatureConfigV2/ApprovalRequest/exceptionOpenedAt/DisputeV2.subjectUserId/AttachmentRef 扩展/上传常量）、`admin-types.ts`（新增）、`view-dtos.ts`（publicMaintenance/notifications/承诺附件） |
| 服务层 | `plan.ts`（受控审核/补正/预留 consumed/exceptionOpenedAt）、`diary.ts`（附件/通知/定向复核）、`anchor.ts`（暂停排队/jobId 重试）、`meet.ts`+`relationship.ts`（功能开关/例外起点）、`admin.ts`（兼容定向裁定）、`view.ts`（公告/通知/附件透出）、`attachments.ts`（新增） |
| ops 后台 | `src/lib/server/ops/auth.ts`、`ops-service.ts`（新增）、`src/app/api/v2/ops/[...path]/route.ts`（新增）、`src/app/admin/`（page + admin.css，新增） |
| 用户端 | `app-shell.tsx`（铃铛/数字角标/公告/提醒）、`us-tab.tsx`（待确认栏/附件/凭证即时刷新）、`future-tab.tsx`（补正表单/维护开关）、`meet-tab.tsx`（分钟倒计时/维护开关）、`me-drawer.tsx`+`know-tab.tsx`（头像放大）、`avatar-zoom.tsx`、`attachment-upload.tsx`（新增）、`modules.css` |
| 仓库 | `demo-repo.ts`（notifications/featureConfig/approvals/lastSweepAt/pushNotification） |
| 文档/验证 | `docs/ADMIN.md`（新增）、`_qa/verify-v25.mjs`（新增，68 项） |

### 验证

- 专项：`npm run verify:v25` —— **68 项**对应 6 条反馈与后台闭环逐一通过（含 401/403/409/422/503、版本冲突、双人审批、自批拒绝、补正、定向裁定、预留 consumed、jobId 重试、公告发布与回滚、脱敏与审计）。
- 回归：`npm run verify:v2` —— 103 项 + 合约 26 项全部通过；`_qa/verify-v22.mjs` 38 项全部通过（其中“倒计时精确到秒”的展示要求已按 v2.5 反馈 3 改为仅分钟，服务端行为不变）。
- 工程：`npm run typecheck`、干净 `.next` 下 `npm run build` 通过。

### 协作者注意

- **后台为演示级（M1+M2）**：数据仍在内存仓库（重启清空）；`APP_MODE=live` 时登录被拒绝——正式使用前需完成设计 M3（Postgres 持久化、正式管理员账号、事务与后台作业），见 `docs/ADMIN.md` 边界清单。
- `GoalClaim` 新增 `revision/assignedTo/reasonCode/materials/reviewEvents/lastSupplementAt`，`CommitmentPlan` 新增 `exceptionOpenedAt`，`V2State` 新增 `notifications/featureConfig/approvals/lastSweepAt`：P1 持久化适配器需同步建列。
- 后台演示账号（owner/owner2/reviewer）仅 demo 模式可用；新增依赖无。
- 站内通知读取走 `GET /state`（`notifications` 字段）+ `POST /notifications/read`；角标数字由 `us.timeline.needsMyAction` 计数得出。

## [v2.2] - 2026-10-07

依据《v2.2修改.md》10 条反馈逐条落地。分支 `feature/v2.2-feedback-fixes`，标签 `v2.2`。

### 新增

- **性取向自由填写**（反馈 1）：性取向下拉在原有 4 个选项基础上新增「其他（自由填写）」，选中后出现 ≤12 字说明输入框；「我的」「了解」页按「其他：xxx」展示。非「其他」时服务端拒绝提交自由填写并自动清空。
- **头像自定义**（反馈 3）：
  - 新增 `src/lib/domain/avatars.ts`：6 个官方默认头像（心动铃铛、晚樱、咖啡、奶猫、星月、音符），品牌色手绘风格 SVG 插画；
  - 新增统一 `Avatar` 组件（`src/components/ui.tsx`），支持三种形态：`def:` 官方头像 / `data:image` 自由上传 / 历史表情符号（兼容 v2.1 旧档案）；
  - 编辑资料弹层提供头像选择宫格 + 上传入口：前端 canvas 压缩到 256×256 JPEG，服务端校验 MIME（PNG/JPEG/WebP）与大小（≤300k 字符 base64）。上传图片仅存本地演示环境。
- **出生年代选项**（反馈 4）：年龄窗口从手填区间（如「24–32」）改为下拉选择出生年代（70后 / 75后 / 80后 / 85后 / 90后 / 95后 / 00后 / 05后）；旧格式区间服务端直接拒绝。展示标签改为「出生年代」。
- **承诺全流程存证（上链）**（反馈 8）：
  - 承诺**立下**（双方确认生效）即生成 `promise` 存证任务（版本 1：内容 / 验收方式 / 截止 / 责任人 / 计分 / 双方确认时间）；
  - **履约结算**（完成 / 未完成 / 豁免，全部责任人结算后）生成版本 2（结果 + 证据说明 + 确认人）；争议经演示台人工复核后生成版本 3，并以 `previousVersionCommitment` 链式引用上一版本；
  - 时间线与承诺详情弹层展示存证状态（预览 · 本地指纹 / 链上已核验 / 写入失败），可导出证据包核对；
  - preview 模式为本地承诺指纹（诚实标注未连真实链），配置真实链（`CHAIN_MODE=bot_testnet|bot_mainnet`）后走同一提交管线，无需改业务代码。
- **空间设置自定义**（反馈 10，含需求确认）：
  - 可自定义：**空间名称**（≤16 字，空则回退默认）、**空间主题**（蜜桃粉 / 晚樱紫 / 薄荷绿 / 琥珀橙 / 月夜蓝共 5 款官方主题色）、**天数与纪念日显示开关**；任一成员可修改，改动立即对双方生效；
  - 不可自定义（公平性与证据可信边界，弹层内有明示）：履约计分规则、存证条款版本、对方资料与授权、双方已确认的日记与承诺历史；
  - 后续候选（已记录待排期）：空间封面图、纪念日清单、情侣问答；
  - 新接口 `POST /space-settings {relationshipId, name?, theme?, showDays?}`。

### 修复

- **心动雷达倒计时被重置**（反馈 6）：
  - 根因：前端倒计时公式 `剩余 = 到期时间 − 服务端虚拟时钟 − 本地累计秒数`，而应用壳每 1.2 秒轮询已刷新虚拟时钟——同一时间段被计了两次，10 分钟约 5 分钟走完；切换页面后本地计数归零，剩余时间还会「跳回」变长，看起来像每次打开雷达都重置了 10 分钟。
  - 修复：改为「到期时间 −（虚拟时钟 + 距上次同步的真实毫秒）」平滑递减，每秒仅触发重绘；倒计时显示精确到秒（「剩余 9 分 32 秒」）。
  - 服务端同步加固：雷达处于开启状态时重复调用开启接口只更新临时特征，**不再重置 10 分钟到期时间**；关闭或到期后重新开启才是新一轮。
- **日记内容无法正常写入**（反馈 7）：
  - 根因：日记编辑弹层的表单重置逻辑把「轮询刷新的虚拟时钟」当依赖项，约每 1.2 秒执行一次重置——标题、正文、图片选择、草稿勾选在输入约 1 秒后即被清空；「我的 → 编辑个人资料」抽屉因依赖轮询的 `view` 同样中招。
  - 修复：虚拟时钟改经 ref 读取，两处表单均只在弹层打开瞬间初始化一次，轮询刷新不再触碰草稿。
- **确认履约后承诺右上角提示错误**（反馈 9）：
  - 根因：状态文案逻辑只要「任一责任人提交过证据」就显示「待确认履约证据」，证据被对方确认后提示仍然残留。
  - 修复：仅当仍存在「已提交证据但未经对方确认」的责任项时才提示「待确认履约证据」；部分结算显示「部分已完成」，全部完成「已完成」，含未完成项的结算「已结算（含未完成）」；承诺弹层右上角印章同步跟随履约进度（已完成 / 已结算 / 承诺生效 / 待确认）。

### 变更

- 「+ 添加一栏联系方式」文案改为「+ 添加联系方式」（反馈 2）。
- 平台已验证事项移除「邮箱已验证」（反馈 5），保留钱包控制权、真人/身份核验。
- 演示档案默认值更新：小铃 = 官方咖啡头像 + 00后；阿响 = 官方奶猫头像 + 95后。

### 涉及文件（主要）

| 层 | 文件 |
|---|---|
| 领域类型 | `src/lib/domain/v2-types.ts`（Orientation/ageCohorts/SpaceSettings）、`src/lib/domain/avatars.ts`（新增） |
| 服务层 | `relationship.ts`（档案校验 + 空间设置）、`diary.ts`（承诺存证 v1/v2/v3）、`meet.ts`（雷达防重置）、`view.ts`（履约文案 + 存证/空间透出）、`admin.ts`（复核后上链） |
| 接口 | `src/app/api/v2/[...path]/route.ts`（新增 `POST /space-settings`） |
| 前端 | `me-drawer.tsx`、`us-tab.tsx`、`meet-tab.tsx`、`know-tab.tsx`、`app-shell.tsx`、`ui.tsx`（Avatar）、`modules.css` |
| 数据 | `demo-repo.ts`（fixtures：去邮箱验证、年代、官方头像、spaceSettings 默认值） |

### 验证

- 专项：`node _qa/verify-v22.mjs` —— 38 项断言对应 10 条反馈逐一通过（需先 `npm run dev`，可用 `DEMO_URL` 指定地址）。
- 回归：`npm run verify:v2` —— 103 项全部通过，未破坏既有行为。
- 工程：`npm run typecheck`、干净 `npm run build` 通过；`package.json` 版本升至 `2.2.0`。
- 浏览器实测：资料草稿 3.6 秒（3 轮轮询）不清空并保存（含「其他：待探索中」与星月头像）；日记正文 3.6 秒不清空并成功写入时间线；空间设置改名 + 换主题即时生效（hero 应用 `theme-sakura` 类）；雷达倒计时 3.2 秒实际时间恰好递减 3 秒；重复开启雷达剩余 492 秒而非重置 600 秒。

### 协作者注意

- `V2Profile` 新增 `orientationCustom` 字段、`V2Relationship` 新增 `spaceSettings` 字段：内存仓库由 `createDemoState` 初始化默认值，P1 持久化适配器需同步建列/迁移。
- 头像值出现 `def:` / `data:image` 前缀两类新形态，展示请统一走 `Avatar` 组件，勿再直接渲染字符串。
- 承诺存证任务（`recordType: "promise"`）有 v1/v2/v3 多版本，读取最新请按 `recordId` 过滤后取末位（参考 `view.ts` 的 `promiseAnchorOf`）。

## [v2.1] - 2026-10-07

完整资料编辑（称呼/性取向/年龄窗口/介绍/爱好标签/MBTI）、成年声明一次勾选、响铃阶段最小资料、联系方式多栏、关系设置菜单、玫瑰券共同持有、日期预填等 9 条反馈。详见 `docs/V2-IMPLEMENTATION.md` 的 v2.1 修改记录。

## [v2.0] - 2026-10-06

V2 全链条产品：相遇 → 了解 → 我们 → 相守四栏、关系状态机、履约分、日记版本确认、相守计划账本、V2 承诺登记合约（`HeartbellCommitmentRegistry.sol`）与 `/api/v2` 统一入口。
