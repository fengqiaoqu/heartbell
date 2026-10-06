// v2.5 维护后台会话与 RBAC（设计文档第 4/6 节）。
// 演示环境：两个明确标记的测试管理账号（设计 4 节允许），仅 APP_MODE=demo 可登录；
// live 模式登录直接拒绝，必须由服务器工具引导正式账号后再开放。
import { createHash, randomUUID } from "node:crypto";
import type {
  AdminAccount, AdminPermission, AdminRole, AdminSession, AdminPrincipal, AuditLogEntry,
} from "../../domain/admin-types";
import { rolePermissions } from "../../domain/admin-types";
import { unauthenticated, forbidden } from "../v2/errors";
import { runModes } from "../v2/registry";

const SESSION_HOURS = 8;
const IDLE_MINUTES = 30;

export const OPS_COOKIE = "hb_ops_session";

interface LoginAttempt { at: number; ok: boolean }
interface OpsStore {
  accounts: AdminAccount[];
  sessions: Map<string, AdminSession>;
  audit: AuditLogEntry[];
  loginAttempts: Map<string, LoginAttempt[]>;
  startedAt: number;
}

function hashPassword(password: string): string {
  return createHash("sha256").update(`heartbell-ops:${password}`).digest("hex");
}

const globals = globalThis as typeof globalThis & { heartbellOps?: OpsStore };

// 演示测试管理账号（明确标记；正式环境不可用，见 requireDemoMode）。
// 两位 owner 用于演示“申请人 ≠ 批准人”的双人审批（功能配置发布只有 owner 可批准）。
const demoAccounts: AdminAccount[] = [
  {
    id: "ops-owner-1", username: "owner", displayName: "管理员·铃铛（演示）",
    roles: ["owner"], passwordHash: hashPassword("heartbell-owner"),
    createdAt: 0, disabledAt: null,
  },
  {
    id: "ops-owner-2", username: "owner2", displayName: "管理员·阿响（演示）",
    roles: ["owner"], passwordHash: hashPassword("heartbell-owner2"),
    createdAt: 0, disabledAt: null,
  },
  {
    id: "ops-reviewer-1", username: "reviewer", displayName: "审核员·小铃（演示）",
    roles: ["reviewer"], passwordHash: hashPassword("heartbell-reviewer"),
    createdAt: 0, disabledAt: null,
  },
];

export function opsStore(): OpsStore {
  globals.heartbellOps ??= {
    accounts: demoAccounts.map(a => ({ ...a, createdAt: Date.now() })),
    sessions: new Map(), audit: [], loginAttempts: new Map(), startedAt: Date.now(),
  };
  return globals.heartbellOps;
}

// 登录限速：同一用户名 10 分钟内最多 5 次失败。
function loginRateLimited(username: string): boolean {
  const store = opsStore();
  const windowStart = Date.now() - 10 * 60_000;
  const fails = (store.loginAttempts.get(username) ?? []).filter(a => !a.ok && a.at >= windowStart);
  return fails.length >= 5;
}

export function login(username: unknown, password: unknown): { principal: AdminPrincipal; session: AdminSession } {
  if (runModes().appMode !== "demo") {
    throw forbidden("正式环境未配置管理员账号：请先由服务器工具引导首位 owner（见 docs/ADMIN.md）");
  }
  if (typeof username !== "string" || typeof password !== "string") throw unauthenticated("请输入账号与密码");
  if (loginRateLimited(username)) throw forbidden("登录失败次数过多，请 10 分钟后再试");
  const store = opsStore();
  const account = store.accounts.find(a => a.username === username);
  const ok = !!account && account.disabledAt === null && account.passwordHash === hashPassword(password);
  store.loginAttempts.set(username, [...(store.loginAttempts.get(username) ?? []), { at: Date.now(), ok }].slice(-20));
  if (!ok || !account) throw unauthenticated("账号或密码不正确（演示账号见登录页说明）");
  const now = Date.now();
  const session: AdminSession = {
    id: randomUUID(), accountId: account.id,
    createdAt: now, expiresAt: now + SESSION_HOURS * 3_600_000,
    lastSeenAt: now, revokedAt: null,
  };
  store.sessions.set(session.id, session);
  return { principal: principalOf(account, session.id), session };
}

export function logout(sessionId: string | null): void {
  if (!sessionId) return;
  const session = opsStore().sessions.get(sessionId);
  if (session) session.revokedAt = Date.now();
}

export function principalOf(account: AdminAccount, sessionId: string): AdminPrincipal {
  const roles: AdminRole[] = [...account.roles];
  const permissions = [...new Set(roles.flatMap(r => rolePermissions[r]))] as AdminPermission[];
  return { accountId: account.id, username: account.username, displayName: account.displayName, roles, permissions, sessionId };
}

// 从 Cookie 解析当前管理员；校验有效期、空闲失效与撤销。
export function resolvePrincipal(cookieHeader: string | null): AdminPrincipal | null {
  const cookies = Object.fromEntries((cookieHeader ?? "").split(";").map(part => {
    const idx = part.indexOf("=");
    return idx === -1 ? [part.trim(), ""] : [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
  }));
  const sessionId = cookies[OPS_COOKIE];
  if (!sessionId) return null;
  const store = opsStore();
  const session = store.sessions.get(sessionId);
  if (!session || session.revokedAt !== null) return null;
  const now = Date.now();
  if (now > session.expiresAt || now - session.lastSeenAt > IDLE_MINUTES * 60_000) {
    session.revokedAt = now;
    return null;
  }
  const account = store.accounts.find(a => a.id === session.accountId);
  if (!account || account.disabledAt !== null) return null;
  session.lastSeenAt = now;
  return principalOf(account, session.id);
}

export function requirePermission(principal: AdminPrincipal | null, permission: AdminPermission): AdminPrincipal {
  if (!principal) throw unauthenticated("请先登录维护后台");
  if (!principal.permissions.includes(permission)) {
    throw forbidden(`当前角色（${principal.roles.join("/")}）没有 ${permission} 权限`);
  }
  return principal;
}

// 写请求同源校验（CSRF 基线）：浏览器 POST 总会携带 Origin。
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw forbidden("跨站写请求被拒绝（Origin 校验失败）");
  } catch (e) {
    if (e instanceof Error && e.message.includes("跨站")) throw e;
    throw forbidden("Origin 无效");
  }
}

export function sessionCookieHeader(sessionId: string, maxAgeSeconds: number): string {
  const secure = runModes().appMode === "live" ? "; Secure" : "";
  return `${OPS_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

// ---------- 审计（设计 4 节：所有裁定记录 actor/对象/结果；不写敏感材料） ----------

export function audit(entry: {
  actorId: string; actorName: string; action: string;
  targetType: string; targetId: string; detail: string; result?: "ok" | "rejected";
}): AuditLogEntry {
  const store = opsStore();
  const record: AuditLogEntry = {
    id: `audit-${store.audit.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
    requestId: randomUUID(),
    actorId: entry.actorId, actorName: entry.actorName,
    action: entry.action, targetType: entry.targetType, targetId: entry.targetId,
    detail: entry.detail.slice(0, 500), result: entry.result ?? "ok",
    createdAt: Date.now(),
  };
  store.audit.push(record);
  return record;
}

export function auditLog(limit = 200): AuditLogEntry[] {
  return opsStore().audit.slice(-limit).reverse();
}
