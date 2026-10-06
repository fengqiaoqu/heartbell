// 安全与隐私领域类型（v2.6，依据《Heartbell-v2.2-安全与隐私模块交付》计划书第 5/6 节）。
// 五种动作语义独立：撤销授权 / 关闭连接 / 屏蔽 / 举报 / 结束绑定。
// 演示级实现（内存仓库）；M4 正式启用前提见 docs/SAFETY-PRIVACY.md。

// ---------- 举报 ----------

export const safetyReasons = ["harassment", "impersonation", "privacy_leak", "inappropriate_content", "fraud", "other"] as const;
export type SafetyReason = (typeof safetyReasons)[number];
export const safetyReasonLabels: Record<SafetyReason, string> = {
  harassment: "骚扰",
  impersonation: "冒充",
  privacy_leak: "隐私泄露",
  inappropriate_content: "不当内容",
  fraud: "欺诈",
  other: "其他",
};

export type SafetyReportStatus =
  | "submitted"            // 已提交（可撤回）
  | "in_review"            // 处理中（已领取 / 补充后回到审核）
  | "awaiting_supplement"  // 待补充（审核员要求补充材料）
  | "resolved"             // 已处理
  | "rejected"             // 暂无法处理
  | "withdrawn"            // 已撤回
  | "appeal_requested"     // 复核中（用户申请一次复核）
  ;

export const safetyReportStatusLabels: Record<SafetyReportStatus, string> = {
  submitted: "已收到",
  in_review: "处理中",
  awaiting_supplement: "待补充",
  resolved: "已处理",
  rejected: "暂无法处理",
  withdrawn: "已撤回",
  appeal_requested: "复核中",
};

// 服务端签发的临时对象引用：绑定调用者与来源，举报/屏蔽不接受任意填入的 userId。
export interface SafetyTargetRef {
  ref: string;
  actorId: string;
  targetId: string;        // 服务端私有：不进入用户 DTO
  sourceType: "bell" | "connection" | "relationship";
  sourceId: string;
  targetLabel: string;     // 安全展示标签（未揭晓对象为“相遇对象 · XN9”式别名）
  createdAt: number;
  expiresAt: number;       // 引用有效期 7 天
}

export interface SafetyReport {
  id: string;
  reporterId: string;
  targetId: string;        // 服务端私有：被举报对象（不进入用户 DTO）
  targetLabel: string;     // 脱敏标签
  sourceType: SafetyTargetRef["sourceType"];
  sourceId: string;
  reason: SafetyReason;
  description: string;     // 10–1000 字
  status: SafetyReportStatus;
  revision: number;        // 乐观并发
  assignedTo: string | null;   // 管理员 accountId（服务端私有）
  createdAt: number;
  updatedAt: number;
  dueAt: number;           // 首次领取前 7 天处理窗口
  withdrawnAt: number | null;
  supplements: { at: number; text: string }[];                       // 用户补充（只追加）
  events: { at: number; action: string; label: string }[];           // 用户可见时间线
  decisions: {                                                             // 裁定历史（内部意见仅运营可见）
    at: number;
    reviewerId: string;
    reviewerName: string;
    decision: "resolved" | "rejected" | "need_supplement" | "appeal";
    userMessage: string;
    internalReason: string | null;
  }[];
  userResult: { at: number; userMessage: string } | null;             // 用户可见结论（不含内部意见）
  appeal: {
    reason: string;
    requestedAt: number;
    decidedAt: number | null;
    reviewerId: string | null;
    userMessage: string | null;
  } | null;
}

// ---------- 屏蔽 ----------

export interface UserBlock {
  id: string;
  ownerId: string;
  targetId: string;        // 服务端私有
  targetLabel: string;     // 脱敏标签（历史匿名对象不揭晓）
  active: boolean;
  createdAt: number;
  revokedAt: number | null;
  revision: number;
}

// ---------- 限制（新发现/摇铃限时限制；不封锁退出、撤权、举报、申诉等救济操作） ----------

export interface AccountRestriction {
  id: string;
  userId: string;
  scope: "discovery" | "ring";
  startsAt: number;
  expiresAt: number;
  reasonCode: string;      // 如 SAFETY_REPORT_RESOLVED
  approvedBy: string;      // 管理员 accountId
  createdAt: number;
}

// ---------- 脱敏审计（不记录联系方式、日记正文、举报原文、salt、令牌） ----------

export interface PrivacyAuditEntry {
  id: string;
  actorId: string;
  actorRole: "user" | "admin";
  action: string;          // 如 safety.block / privacy.export.read
  targetType: string;
  targetId: string;        // 脱敏 ID（不写正文）
  result: "ok" | "rejected";
  at: number;
}

// ---------- 我的数据 ----------

export const dataExportScopes = ["profile", "contacts", "diaries", "promises", "ledger", "notifications"] as const;
export type DataExportScope = (typeof dataExportScopes)[number];
export const dataExportScopeLabels: Record<DataExportScope, string> = {
  profile: "个人资料",
  contacts: "联系方式",
  diaries: "日记（仅本人可见版本）",
  promises: "承诺与履约记录",
  ledger: "演示账本",
  notifications: "站内通知",
};

export interface DataExportJob {
  id: string;
  ownerId: string;
  scopes: DataExportScope[];
  status: "queued" | "processing" | "ready" | "expired" | "failed";
  createdAt: number;
  readyAt: number | null;
  expiresAt: number | null;    // ready 后 24 小时可下载
  attempts: number;
  packageJson: string | null;  // 生成快照（演示级：即时生成；P1 由 worker 异步生成）
  downloads: number;
}

export type AccountDeletionState = "requested" | "processing" | "completed" | "completed_with_retention";

export interface AccountDeletion {
  id: string;
  ownerId: string;
  state: AccountDeletionState;
  requestedAt: number;
  reauthAt: number;             // 再认证成功时间
  endBindingConsent: boolean;   // 明确同意结束当前绑定
  credentialHash: string;       // 独立受限查询凭据（哈希保存；明文只返回一次）
  checklist: { item: string; result: "cleared" | "archived" | "retained" }[];
  retentionSummary: string[];   // 受限保留类别与原因
  reviewAt: number | null;      // 受限保留复核日
  processedAt: number | null;
}

export const deletionStateLabels: Record<AccountDeletionState, string> = {
  requested: "申请已收到",
  processing: "处理中",
  completed: "已完成",
  completed_with_retention: "已完成（部分材料受限保留）",
};
