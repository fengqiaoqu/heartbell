// 后台领域类型（v2.5，依据《Heartbell v2.1 后台需求与设计方案》第 4/6 节）。
// 权限绑定 AdminPrincipal；没有账号的普通用户不具备任何 ops 权限。
// 演示环境使用两个明确标记的测试管理账号；正式环境必须由服务器工具引导首位 owner。

export type AdminRole = "owner" | "reviewer" | "support" | "maintainer" | "auditor";

export const adminRoleLabels: Record<AdminRole, string> = {
  owner: "负责人",
  reviewer: "审核",
  support: "客服",
  maintainer: "运维",
  auditor: "审计",
};

// 权限点（设计文档第 6 节接口表的权限列收敛 + v2.6 安全工单 safety.*）。
export type AdminPermission =
  | "overview.read" | "claims.read" | "claims.assign" | "claims.decide"
  | "cases.read" | "cases.resolve" | "approvals.request" | "approvals.approve"
  | "users.read" | "rewards.read" | "inventory.propose"
  | "anchors.read" | "anchors.retry"
  | "system.read" | "config.propose" | "audit.read"
  // v2.6 安全与隐私（safety_reviewer / safety_supervisor 为能力要求，复用现有账号体系）：
  | "safety.read"      // 查看脱敏举报队列
  | "safety.assign"    // 领取/改派工单（领取后才能裁定）
  | "safety.decide"    // 补正/结案（仅被指派审核员；不能复核自己的裁定）
  | "safety.appeal"    // 复核裁定（原审核员回避）
  | "safety.restrict"  // 批准限时发现/摇铃限制（主管能力）
  // v2.8（M03 MD-14）：活动管理
  | "events.read"      // 查看活动列表与状态（不含明文活动码）
  | "events.manage";   // 创建/暂停/恢复/关闭/换码

// 角色权限矩阵（owner 不自动获得全部私密材料权限，矩阵按设计文档第 4 节收敛）。
export const rolePermissions: Record<AdminRole, AdminPermission[]> = {
  owner: [
    "overview.read", "claims.read", "claims.assign", "claims.decide",
    "cases.read", "cases.resolve", "approvals.request", "approvals.approve",
    "users.read", "rewards.read", "inventory.propose",
    "anchors.read", "anchors.retry", "system.read", "config.propose", "audit.read",
    "safety.read", "safety.assign", "safety.decide", "safety.appeal", "safety.restrict",
    "events.read", "events.manage",
  ],
  reviewer: [
    "overview.read", "claims.read", "claims.assign", "claims.decide",
    "cases.read", "cases.resolve", "approvals.request", "approvals.approve",
    "rewards.read",
    "safety.read", "safety.assign", "safety.decide", "safety.appeal",
  ],
  support: ["overview.read", "users.read", "safety.read"],
  maintainer: ["overview.read", "anchors.read", "anchors.retry", "system.read", "config.propose", "rewards.read", "events.read", "events.manage"],
  auditor: ["overview.read", "audit.read", "events.read"],
};

export interface AdminAccount {
  id: string;
  username: string;        // 登录名
  displayName: string;
  roles: AdminRole[];
  passwordHash: string;    // 演示账号为固定摘要；正式环境换成熟实现
  createdAt: number;
  disabledAt: number | null;
}

export interface AdminSession {
  id: string;              // 随机会话 ID，Cookie 只携带此值，服务端存哈希
  accountId: string;
  createdAt: number;
  expiresAt: number;       // 8h 绝对有效期
  lastSeenAt: number;      // 30min 空闲失效
  revokedAt: number | null;
}

export interface AdminPrincipal {
  accountId: string;
  username: string;
  displayName: string;
  roles: AdminRole[];
  permissions: AdminPermission[];
  sessionId: string;
}

export interface AuditLogEntry {
  id: string;
  requestId: string;
  actorId: string;
  actorName: string;
  action: string;          // 如 claims.decide / exceptions.refund / anchors.retry
  targetType: string;
  targetId: string;
  detail: string;          // 脱敏摘要（不含联系方式/性取向/日记正文/salt）
  result: "ok" | "rejected";
  createdAt: number;
}
