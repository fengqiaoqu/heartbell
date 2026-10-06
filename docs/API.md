# 数据与接口约定

共享类型：旧演示 `src/lib/types.ts`（V1）；V2 领域类型 `src/lib/domain/v2-types.ts`、视图 DTO `src/lib/domain/view-dtos.ts`。修改字段前与前后端负责人协调。

## V2 接口（`/api/v2`，本轮主要入口）

统一响应 `{ data, requestId, mode }`；错误 `{ error: { code, message, retryable }, requestId }`。
错误码包括 `BAD_REQUEST`、`UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`CONSENT_REQUIRED`、`ALREADY_BOUND`、`INSUFFICIENT_BALANCE`、`REWARD_UNAVAILABLE`、`CLAIM_PENDING`、`PLAN_STATE`、`RADAR_REQUIRED` 等。

**会话**：P0 使用 `viewer=a|b` 本地演示身份（请求体或 query 参数）。所有成员资格、授权、状态与并发校验仍在服务端执行；live 模式必须替换为服务端可信会话，不能信任请求中的身份参数（实现集中在 `src/lib/server/v2/session.ts` 以便替换）。

### 视图（GET）

| 接口 | 说明 |
|---|---|
| `GET /api/v2/state?viewer=a` | 轮询端点（1.2s）：按权限裁剪的全部视图。回响前不含对方档案；联系方式仅在有效授权时返回；私人草稿仅作者可见 |
| `GET /api/v2/me?viewer=a` | 本人档案、余额、授权列表、账本 |
| `GET /api/v2/diaries/detail?id=&viewer=` | 日记版本明细（仅关系成员） |
| `GET /api/v2/trust/summary?subjectId=b&viewer=a` | 受众读取履约摘要：需 subject→audience 有效授权，否则 403；每次读取校验版本与撤销状态 |
| `GET /api/v2/export?recordId=&viewer=` | 证据包导出（payload + salt + anchor 信息），仅记录参与者 |

### 相遇（POST）

| 接口 | 要点 |
|---|---|
| `POST /declare-adult` | 成年演示声明（非真人核验） |
| `POST /radar` `{active, traits[2-3]}` | 已有有效关系时服务端 403 拦截（MEET-06）；特征 1–20 字 |
| `POST /ring` `{message}` | 三句预设；同轮次同对象一次（服务端计算轮次）；需双方雷达开启 |
| `POST /respond` `{bellId, status}` | accepted 建立连接；dismissed 消散；10 分钟过期 |
| `POST /connection-close` `{connectionId}` | 关闭连接：停止新铃声与互访，保留本人记录 |

### 授权与关系（POST）

| 接口 | 要点 |
|---|---|
| `POST /share-grants` `{scope}` | scope: `profile_contact` / `trust_summary`；受众=已回响连接对方；72h；幂等刷新 |
| `POST /share-grants/revoke` `{grantId}` | 立即撤销后续读取 |
| `POST /relationships/propose` | 需已回响连接；双方均无有效绑定与待处理邀请；72h 过期 |
| `POST /relationships/accept` `{relationshipId}` | 服务端原子绑定（同时接受两份只能成功一份）；生成开始事件存证任务与系统纪念节点 |
| `POST /relationships/decline` / `cancel` | 提案期拒绝/取消 |
| `POST /relationships/end` `{relationshipId, reason}` | 本人单方退出，立即生效；不等待对方/链上/计划结算；在途计划转例外复核或失效等待 |
| `POST /space-settings` `{relationshipId, name?, theme?, showDays?}` | v2.2 空间自定义：名称 ≤16 字（空回退默认）、theme ∈ peach/sakura/mint/amber/moon、天数显示开关；任一成员可改，双方同步生效 |

### 我们：日记与承诺（POST）

| 接口 | 要点 |
|---|---|
| `POST /diaries` | 标题 1–40 字、正文 1–3000 字、≤6 张演示图、日期不晚于今天；visibility draft/shared |
| `POST /diaries/version` `{diaryId, expectedVersion, ...}` | 修改生成新版本；旧确认不复用；expectedVersion 不一致返回 VERSION_CONFLICT |
| `POST /diaries/share` / `confirm` / `return` / `withdraw` | 草稿发送；确认绑定具体版本；退回需新版本；作者可撤回 |
| `POST /diaries/anchor` `{diaryId}` | 需双方确认当前版本；commitment 服务端生成（不接受客户端指定）；preview 下状态=unconfigured（本地指纹，无假交易） |
| `POST /promises` | 内容 4–80 字；禁止限制人身自由类承诺；计分项：≥24h 提前、每关系 ≤10 项、每自然日 ≤1 项 |
| `POST /promises/confirm` / `return` | 双方确认生效；v2.2 起生效（立下）即生成 `promise` 存证任务（版本 1，条款内容） |
| `POST /promises/resolutions` `{result, note}` | 责任人提交履约证据（fulfilled 需对方确认；unfulfilled 本人确认即成立） |
| `POST /promises/resolutions/confirm` `{subjectUserId, outcome}` | 对方确认证据（fulfilled）或共同豁免（waived）；v2.2 起全部结算后生成存证任务（版本 2，结果内容；争议复核后版本 3） |
| `POST /promises/resolutions/dispute` | 申诉：结果转 disputed，摘要冻结为"申诉中"，等待人工复核 |

### 相守（POST）

| 接口 | 要点 |
|---|---|
| `POST /plans` `{targetType, rewardChoice, beneficiary}` | 每关系至多 1 个有效计划；条款服务端固定（客户端伪造奖励选项被规范化） |
| `POST /plans/accept` `{planId, expectedRevision, termsConfirmed}` | 全部检查（双方成年声明、双方余额 ≥100、奖励预留）通过后一次性扣点激活，无半激活状态 |
| `POST /plans/cancel` `{reasonType: normal/exception}` | 冷静期内取消退款；冷静期后普通结束进入 7 天异议窗口（有在途申请则 409）；例外转复核 |
| `POST /plans/claims` `{targetOccurredAt, evidenceNote}` | 目标须在 [冷静期结束, 到期]；去重（每计划一个在途申请）；宽限期内仍可提交到期前目标 |
| `POST /benefits/redeem` `{benefitId, idempotencyKey}` | 仅受益人；幂等（重复点击/并发只结算一次）：返还双方本金 + 独立奖励预算发放 |
| `POST /disputes` `{targetType, targetId, note}` | 申诉冻结结算（例外复核），不冻结退出权 |

### 存证与演示台

| 接口 | 要点 |
|---|---|
| `POST /anchors/retry` `{recordId}` | 失败任务恢复（同一任务，不换承诺）；仅记录参与者 |
| `GET /api/v2/admin/snapshot` | 演示台视图（仅 APP_MODE=demo） |
| `POST /admin/reset` · `POST /admin/advance-time {ms}` · `POST /admin/chain-fault {active}` | 场景重置 / 虚拟业务时间（不修改系统或链上时间）/ 链故障模拟 |
| `POST /admin/claims/decision` `{claimId, decision: approve/need_more/reject}` | 演示审核；approve 后 7 天争议期；婚姻目标仅 active 关系转 married |
| `POST /admin/exception/resolve` `{planId, decision: refund/forfeit/back_to_review}` | 例外复核结论 |
| `POST /admin/trust-dispute/resolve` `{promiseId, finalResult}` | 履约争议人工复核（刷新摘要版本） |

### 履约分（服务端计算，计划书 4.3）

```text
n = s + f；eligible = s + f + pending（waived 排除）
若 n < 3，或 coverage = n/eligible < 0.8，或存在未决申诉：score = null
否则 score = round(100 × (s + 1) / (n + 2))
```

数据源锁定"最近一段已结束的正式关系"（endedAt 降序），不回退旧高分。结算/申诉变化生成新摘要版本并撤销旧版本；接收方每次打开都向服务端校验。

## 旧演示接口（LEGACY）

`GET/POST /api/demo?viewer=a|b` 为 V1 迁移期接口，仅供 `verify:demo` 回归使用；live 模式下写操作返回 403。字段说明见 git 历史版本本文档；`diary-onchain` 仅做哈希格式校验的旧限制不变，V2 已用服务端承诺协议取代。

`POST /api/eligibility` 仍为真实 ZK 证明预留入口（未配置返回 501，zkVerified=false）。

## 使用边界

- viewer 是本地演示身份切换，不是登录认证；内存状态单进程、重启清空。
- 演示台、时间推进、审核模拟仅 APP_MODE=demo 开放，正式环境服务端拒绝。
- 真实链模式（CHAIN_MODE≠preview）需要 CHAIN_RPC_URL 与合约地址，缺失时报配置错误而非假成功。
