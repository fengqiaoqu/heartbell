// v2.6 Demo 登录会话（依据《Heartbell-v2.5-Demo登录交付》计划书 2/4/5 节）。
// v2.8（M03 MD-01）：统一 Demo 注册表扩展为 A–F 六个独立账号，支持两个活动并行演示；
// 双 Cookie 槽位（hb_demo_a … hb_demo_f）支持同浏览器多窗口，各槽位会话彼此独立。
// 会话表为单进程内存实现，重启后需重新登录（本地演示边界，P1 接持久会话）。
// 真实时间 8 小时有效，不使用虚拟业务时钟；仅 APP_MODE=demo 可用。
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { forbidden, unauthenticated } from "./v2/errors";
import { runModes } from "./v2/registry";
import { demoUserIds, isDemoUserId, type DemoUserId } from "../domain/demo-users";

export const DEMO_SESSION_HOURS = 8;
export type DemoViewer = DemoUserId;
export const demoViewers: DemoViewer[] = [...demoUserIds];

export function slotCookie(viewer: DemoViewer): string {
  return `hb_demo_${viewer}`;
}

// 固定凭据（公开演示凭据，README 同步列出；密码校验只在服务端执行）。
// c 为 v2.6 安全验证第三人；d/e/f 为 v2.8 多人相遇演示账号（活动甲/乙）。
const presetAccounts: Record<DemoViewer, { username: string; salt: string; hash: Buffer }> = {
  a: { username: "a", salt: "heartbell-demo-a", hash: scryptSync("HeartbellA2026!", "heartbell-demo-a", 32) },
  b: { username: "b", salt: "heartbell-demo-b", hash: scryptSync("HeartbellB2026!", "heartbell-demo-b", 32) },
  c: { username: "c", salt: "heartbell-demo-c", hash: scryptSync("HeartbellC2026!", "heartbell-demo-c", 32) },
  d: { username: "d", salt: "heartbell-demo-d", hash: scryptSync("HeartbellD2026!", "heartbell-demo-d", 32) },
  e: { username: "e", salt: "heartbell-demo-e", hash: scryptSync("HeartbellE2026!", "heartbell-demo-e", 32) },
  f: { username: "f", salt: "heartbell-demo-f", hash: scryptSync("HeartbellF2026!", "heartbell-demo-f", 32) },
};

export function isDemoViewer(value: unknown): value is DemoViewer {
  return isDemoUserId(value);
}

function passwordMatches(account: { salt: string; hash: Buffer }, password: string): boolean {
  const candidate = scryptSync(password, account.salt, 32);
  return candidate.length === account.hash.length && timingSafeEqual(candidate, account.hash);
}

interface DemoSession {
  sessionId: string;
  userId: DemoViewer;
  createdAt: number;
  expiresAt: number; // 真实时间，不受虚拟业务时钟影响
  revokedAt: number | null;
}

interface DemoAuthStore {
  sessions: Map<string, DemoSession>;
}

const globals = globalThis as typeof globalThis & { heartbellDemoSessions?: DemoAuthStore };

function store(): DemoAuthStore {
  globals.heartbellDemoSessions ??= { sessions: new Map() };
  return globals.heartbellDemoSessions;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of store().sessions) {
    if (session.revokedAt !== null || session.expiresAt <= now) store().sessions.delete(key);
  }
}

// 登录：账号 trim 后转小写匹配 a–f；密码区分大小写、原样比较（不 trim）。
// 长度与类型校验先行；错误凭据统一 401，非 demo 模式 403。
export function loginDemoUser(rawUsername: unknown, rawPassword: unknown): {
  viewer: DemoViewer; sessionId: string; expiresAt: number;
} {
  if (runModes().appMode !== "demo") {
    throw forbidden("演示登录仅在 APP_MODE=demo 的本地演示环境开放");
  }
  if (typeof rawUsername !== "string" || typeof rawPassword !== "string") {
    throw unauthenticated("请输入账号与密码");
  }
  if (rawUsername.length > 32 || rawPassword.length > 128) {
    throw unauthenticated("账号或密码不正确");
  }
  const username = rawUsername.trim().toLowerCase();
  const viewer: DemoViewer | null = isDemoUserId(username) ? username : null;
  if (!viewer || !passwordMatches(presetAccounts[viewer], rawPassword)) {
    throw unauthenticated("账号或密码不正确");
  }
  cleanupExpiredSessions();
  const now = Date.now();
  const session: DemoSession = {
    sessionId: randomBytes(32).toString("hex"),
    userId: viewer,
    createdAt: now,
    expiresAt: now + DEMO_SESSION_HOURS * 3_600_000,
    revokedAt: null,
  };
  store().sessions.set(session.sessionId, session);
  return { viewer, sessionId: session.sessionId, expiresAt: session.expiresAt };
}

// 再认证（注销账号等敏感操作前验证当前账号密码）。
export function verifyDemoPassword(userId: string, rawPassword: unknown): boolean {
  if (!isDemoViewer(userId) || typeof rawPassword !== "string") return false;
  return passwordMatches(presetAccounts[userId], rawPassword);
}

function sessionValid(session: DemoSession | undefined): session is DemoSession {
  return !!session && session.revokedAt === null && session.expiresAt > Date.now();
}

// 从 Cookie 头解析指定槽位的有效会话；槽位与会话身份必须一致（a 的 token 放进 hb_demo_b 无效）。
export function resolveSlotFromCookieHeader(cookieHeader: string | null, viewer: DemoViewer): DemoSession | null {
  if (!cookieHeader) return null;
  const cookies = Object.fromEntries(cookieHeader.split(";").map(part => {
    const idx = part.indexOf("=");
    return idx === -1 ? [part.trim(), ""] : [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
  }));
  const sessionId = cookies[slotCookie(viewer)];
  if (!sessionId) return null;
  const session = store().sessions.get(sessionId);
  return sessionValid(session) && session.userId === viewer ? session : null;
}

// API 门禁入口：校验请求槽位对应会话，返回服务器确认的 viewer；失败抛 401。
export function requireDemoSession(cookieHeader: string | null, requestedViewer: unknown): DemoViewer {
  if (!isDemoViewer(requestedViewer)) throw unauthenticated("请先登录演示账号");
  const session = resolveSlotFromCookieHeader(cookieHeader, requestedViewer);
  if (!session) throw unauthenticated("登录已失效，请重新登录");
  return session.userId;
}

export function logoutDemoViewer(cookieHeader: string | null, viewer: unknown): DemoViewer {
  if (!isDemoViewer(viewer)) throw unauthenticated("无效的演示账号槽位");
  const session = resolveSlotFromCookieHeader(cookieHeader, viewer);
  if (session) session.revokedAt = Date.now();
  return viewer;
}

// 注销账号：撤销该用户的全部演示会话（仍返回受影响数供记录）。
export function revokeAllSessionsForUser(userId: string): number {
  let revoked = 0;
  for (const session of store().sessions.values()) {
    if (session.userId === userId && session.revokedAt === null) {
      session.revokedAt = Date.now();
      revoked += 1;
    }
  }
  return revoked;
}

export function sessionSummary(session: DemoSession, nickname: string) {
  return {
    viewer: session.userId,
    username: session.userId,
    nickname,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

export function sessionCookieHeader(viewer: DemoViewer, sessionId: string): string {
  // HTTPS 才加 Secure；本机 HTTP 演示不受影响。
  const secure = process.env.DEMO_SECURE_COOKIES === "1" ? "; Secure" : "";
  return `${slotCookie(viewer)}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEMO_SESSION_HOURS * 3600}${secure}`;
}

export function clearedCookieHeader(viewer: DemoViewer): string {
  return `${slotCookie(viewer)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 写请求同源校验（与 ops 后台一致：仅在浏览器携带 Origin 时校验）。
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

// 注销受限查询凭据：创建时返回一次明文，服务端只存哈希。
export function newRestrictedCredential(): { token: string; hash: string } {
  const token = randomBytes(24).toString("hex");
  return { token, hash: hashCredential(token) };
}
export function hashCredential(token: string): string {
  return createHash("sha256").update(`heartbell-cred:${token}`).digest("hex");
}
