// /api/v2/ops 维护后台受控接口（v2.5，设计文档第 6 节）。
// 与 /api/v2 用户接口共用同一业务服务与状态；每个接口执行管理员会话、RBAC 与审计。
// 演示环境两个测试管理账号登录；live 模式拒绝登录（未配置正式账号体系前不可用）。
import { NextResponse } from "next/server";
import { getV2State, runModes, sweepAndNow } from "../../../../../lib/server/v2/registry";
import { ApiError } from "../../../../../lib/server/v2/errors";
import {
  OPS_COOKIE, assertSameOrigin, audit, auditLog, login, logout, resolvePrincipal, requirePermission, sessionCookieHeader,
} from "../../../../../lib/server/ops/auth";
import {
  opsAnchors, opsAnchorRetry, opsApprove, opsApprovals, opsAssignClaim, opsCases,
  opsClaimDetail, opsClaimsList, opsDecideClaim, opsOverview, opsProposeConfig,
  opsRejectApproval, opsRequestExceptionResolution, opsRequestInventoryAdjustment,
  opsResolveTrustDispute, opsRewards, opsRelationships, opsSystemHealth, opsUsers,
} from "../../../../../lib/server/ops/ops-service";
import type { AdminPermission, AdminPrincipal } from "../../../../../lib/domain/admin-types";

export const dynamic = "force-dynamic";

function ok(data: unknown, init?: { setCookie?: string; clearCookie?: boolean; status?: number }) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (init?.setCookie) headers["Set-Cookie"] = init.setCookie;
  if (init?.clearCookie) headers["Set-Cookie"] = `${OPS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return NextResponse.json({ data, requestId: crypto.randomUUID(), mode: runModes() }, { status: init?.status ?? 200, headers });
}
function fail(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.retryable }, requestId: crypto.randomUUID() },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { error: { code: "INTERNAL", message: error instanceof Error ? error.message : "服务器内部错误", retryable: false }, requestId: crypto.randomUUID() },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

function parseCookieId(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = new RegExp(`${OPS_COOKIE}=([^;]+)`).exec(header);
  return match ? match[1] : null;
}

type Ctx = { principal: AdminPrincipal | null; body: Record<string, unknown>; params: string[]; url: URL; request: Request };
type Guarded = (ctx: Ctx & { me: AdminPrincipal }) => unknown;

function guarded(permission: AdminPermission, handler: Guarded) {
  return (ctx: Ctx) => handler({ ...ctx, me: requirePermission(ctx.principal, permission) });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const url = new URL(request.url);
    const principal = resolvePrincipal(request.headers.get("cookie"));
    const ctx: Ctx = { principal, body: {}, params: path ?? [], url, request };
    const key = `GET /${(path ?? []).join("/")}`;
    const routes: Record<string, (c: Ctx) => unknown> = {
      "GET /session": ({ principal: p }) => {
        if (!p) throw new ApiError(401, "UNAUTHENTICATED", "未登录或会话已过期");
        return { actor: p.displayName, username: p.username, roles: p.roles, permissions: p.permissions };
      },
      "GET /overview": guarded("overview.read", ({ me }) => { auditRead(me, "overview"); return opsOverview(sweepAndNow().state); }),
      "GET /claims": guarded("claims.read", ({ url: u }) => opsClaimsList(getV2State(), { status: u.searchParams.get("status"), mine: u.searchParams.get("mine") })),
      "GET /claims/:id": guarded("claims.read", ({ me, params }) => opsClaimDetail(getV2State(), me, params[1])),
      "GET /cases": guarded("cases.read", () => opsCases(sweepAndNow().state)),
      "GET /users": guarded("users.read", () => opsUsers(getV2State())),
      "GET /relationships": guarded("users.read", () => opsRelationships(getV2State())),
      "GET /rewards": guarded("rewards.read", () => opsRewards(getV2State())),
      "GET /approvals": guarded("overview.read", () => opsApprovals(getV2State())),
      "GET /anchors": guarded("anchors.read", () => opsAnchors(getV2State())),
      "GET /system/health": guarded("overview.read", () => opsSystemHealth(getV2State())),
      "GET /system/config": guarded("system.read", () => opsSystemHealth(getV2State())),
      "GET /audit": guarded("audit.read", ({ url: u }) => {
        const action = u.searchParams.get("action");
        let items = auditLog(300);
        if (action) items = items.filter(e => e.action.includes(action));
        return { items };
      }),
    };
    // 路径参数匹配：claims/:id
    if (!routes[key] && path?.length === 2 && path[0] === "claims") {
      return ok((routes["GET /claims/:id"] as (c: Ctx) => unknown)(ctx));
    }
    const handler = routes[key];
    if (!handler) throw new ApiError(404, "NOT_FOUND", `未知接口：${key}`);
    return ok(handler(ctx));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    assertSameOrigin(request);
    const { path } = await context.params;
    const url = new URL(request.url);
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { body = {}; }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "BAD_REQUEST", "请求必须为对象");
    const principal = resolvePrincipal(request.headers.get("cookie"));
    const ctx: Ctx = { principal, body, params: path ?? [], url, request };

    // 登录/登出不需要会话。
    const key = `POST /${(path ?? []).join("/")}`;
    if (key === "POST /login") {
      const { principal: p, session } = login(body.username, body.password);
      audit({ actorId: p.accountId, actorName: p.displayName, action: "auth.login", targetType: "session", targetId: session.id, detail: "登录维护后台（演示测试账号）" });
      return ok({ actor: p.displayName, roles: p.roles, permissions: p.permissions }, { setCookie: sessionCookieHeader(session.id, 8 * 3600) });
    }
    if (key === "POST /logout") {
      const p = principal;
      logout(parseCookieId(request));
      if (p) audit({ actorId: p.accountId, actorName: p.displayName, action: "auth.logout", targetType: "session", targetId: p.sessionId, detail: "退出维护后台" });
      return ok({ ok: true }, { clearCookie: true });
    }

    const routes: Record<string, (c: Ctx) => unknown> = {
      "POST /claims/:id/assign": guarded("claims.assign", ({ me, params, body: b }) => {
        opsAssignClaim(getV2State(), me, params[1], String(b.assigneeId ?? "me"));
        return { ok: true };
      }),
      "POST /claims/:id/decision": guarded("claims.decide", ({ me, params, body: b }) => opsDecideClaim(getV2State(), me, params[1], b)),
      "POST /exceptions/:planId/resolution-requests": guarded("cases.resolve", ({ me, params, body: b }) =>
        opsRequestExceptionResolution(getV2State(), me, params[1], {
          decision: String(b.decision ?? ""),
          reason: String(b.reason ?? ""),
          expectedPlanRevision: b.expectedPlanRevision as number | undefined,
        })),
      "POST /trust-disputes/:disputeId/resolve": guarded("cases.resolve", ({ me, params, body: b }) =>
        opsResolveTrustDispute(getV2State(), me, params[1], {
          subjectUserId: String(b.subjectUserId ?? ""),
          finalResult: String(b.finalResult ?? ""),
          reason: typeof b.reason === "string" ? b.reason : undefined,
        })),
      "POST /approvals/:id/approve": guarded("approvals.approve", ({ me, params }) => opsApprove(getV2State(), me, params[1])),
      "POST /approvals/:id/reject": guarded("approvals.approve", ({ me, params, body: b }) => {
        opsRejectApproval(getV2State(), me, params[1], String(b.reason ?? ""));
        return { ok: true };
      }),
      "POST /inventory/adjustment-requests": guarded("inventory.propose", ({ me, body: b }) =>
        opsRequestInventoryAdjustment(getV2State(), me, {
          unit: String(b.unit ?? "demo-point"),
          signedDelta: Number(b.signedDelta ?? 0),
          reason: String(b.reason ?? ""),
        })),
      "POST /anchors/:jobId/retry": guarded("anchors.retry", ({ me, params }) => opsAnchorRetry(getV2State(), me, params[1])),
      "POST /config/drafts": guarded("config.propose", ({ me, body: b }) =>
        opsProposeConfig(getV2State(), me, {
          radarNewEnabled: b.radarNewEnabled === true,
          planNewEnabled: b.planNewEnabled === true,
          anchorSubmitEnabled: b.anchorSubmitEnabled === true,
          maintenanceNotice: String(b.maintenanceNotice ?? ""),
          reason: String(b.reason ?? ""),
        })),
    };
    // 三段路径的参数化匹配
    const handler = routes[key]
      ?? (path?.length === 3 && path[0] === "claims" && path[2] === "assign" ? routes["POST /claims/:id/assign"]
        : path?.length === 3 && path[0] === "claims" && path[2] === "decision" ? routes["POST /claims/:id/decision"]
        : path?.length === 3 && path[0] === "exceptions" && path[2] === "resolution-requests" ? routes["POST /exceptions/:planId/resolution-requests"]
        : path?.length === 3 && path[0] === "trust-disputes" && path[2] === "resolve" ? routes["POST /trust-disputes/:disputeId/resolve"]
        : path?.length === 3 && path[0] === "approvals" && path[2] === "approve" ? routes["POST /approvals/:id/approve"]
        : path?.length === 3 && path[0] === "approvals" && path[2] === "reject" ? routes["POST /approvals/:id/reject"]
        : path?.length === 3 && path[0] === "anchors" && path[2] === "retry" ? routes["POST /anchors/:jobId/retry"]
        : undefined);
    if (!handler) throw new ApiError(404, "NOT_FOUND", `未知接口：${key}`);
    return ok(handler(ctx));
  } catch (error) {
    return fail(error);
  }
}

// 敏感总览读取也留痕（轻量摘要，不记业务材料）。
function auditRead(me: AdminPrincipal, what: string): void {
  audit({ actorId: me.accountId, actorName: me.displayName, action: `${what}.read`, targetType: "system", targetId: "-", detail: `查看${what}` });
}
