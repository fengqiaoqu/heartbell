// /api/v2 统一入口（计划书 10.3 节）。旧 /api/demo 保留为 legacy，仅限 demo 模式。
// v2.6：普通用户接口先校验 Demo 会话（hb_demo_a / hb_demo_b 双槽位），服务器确认 viewer
// 后才执行业务（含 sweep）——不再把 viewer 参数当作身份证明。
// admin/* 演示台路由保持原有 APP_MODE=demo 边界（requireDemoMode），不套用户会话。
import { NextResponse } from "next/server";
import { getV2State, runModes, sweepAndNow } from "../../../../lib/server/v2/registry";
import { ApiError } from "../../../../lib/server/v2/errors";
import { assertSameOrigin, requireDemoSession } from "../../../../lib/server/demo-auth";
import { resolveDemoUser } from "../../../../lib/server/v2/session";
import * as meet from "../../../../lib/server/v2/services/meet";
import * as rel from "../../../../lib/server/v2/services/relationship";
import * as trust from "../../../../lib/server/v2/services/trust";
import * as diary from "../../../../lib/server/v2/services/diary";
import * as plan from "../../../../lib/server/v2/services/plan";
import * as anchor from "../../../../lib/server/v2/services/anchor";
import * as admin from "../../../../lib/server/v2/services/admin";
import { buildStateView } from "../../../../lib/server/v2/services/view";
import * as safety from "../../../../lib/server/v2/services/safety";
import * as privacy from "../../../../lib/server/v2/services/privacy";

export const dynamic = "force-dynamic";

function ok(data: unknown, status = 200) {
  return NextResponse.json({ data, requestId: crypto.randomUUID(), mode: runModes() }, { status, headers: { "Cache-Control": "no-store" } });
}
function fail(error: ApiError | Error) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, retryable: error.retryable }, requestId: crypto.randomUUID() },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: "INTERNAL", message: error.message || "服务器内部错误", retryable: false }, requestId: crypto.randomUUID() },
    { status: 500 },
  );
}

type Handler = (ctx: { viewer: string | null; body: Record<string, unknown>; params: string[]; url: URL; idempotencyKey: string | null }) => unknown;

const routes: Record<string, Handler> = {
  // ---------- 视图 ----------
  "GET /state": ({ viewer }) => { const { state } = sweepAndNow(); return buildStateView(state, resolveDemoUser(state, viewer)); },
  "GET /me": ({ viewer }) => { const { state } = sweepAndNow(); const v = resolveDemoUser(state, viewer); return buildStateView(state, v).me; },
  "GET /diaries/detail": ({ viewer, url }) => {
    const { state, now } = sweepAndNow();
    return diary.getDiaryDetail(state, resolveDemoUser(state, viewer), url.searchParams.get("id"));
  },
  // v2.7：已结束关系的只读归档列表（实测：旧归档只有数量没有入口）。
  "GET /diaries/archive": ({ viewer, url }) => {
    const { state } = sweepAndNow();
    return diary.archivedDiaries(state, resolveDemoUser(state, viewer), url.searchParams.get("relationshipId"));
  },
  "GET /trust/summary": ({ viewer, url }) => {
    const { state, now } = sweepAndNow();
    const subject = url.searchParams.get("subjectId");
    if (!subject) throw new ApiError(400, "BAD_REQUEST", "缺少 subjectId");
    return trust.readTrustForAudience(state, subject, resolveDemoUser(state, viewer), now);
  },
  "GET /export": ({ viewer, url }) => {
    const { state } = sweepAndNow();
    return anchor.exportEvidence(state, resolveDemoUser(state, viewer), url.searchParams.get("recordId"));
  },
  // ---------- 我的 ----------
  "POST /declare-adult": ({ viewer, body }) => { const state = getV2State(); rel.declareAdult(state, resolveDemoUser(state, body.viewer ?? viewer)); return { ok: true }; },
  "POST /profile": ({ viewer, body }) => { const state = getV2State(); rel.updateMyProfile(state, resolveDemoUser(state, body.viewer ?? viewer), body); return { ok: true }; },
  // ---------- 相遇 ----------
  "POST /radar": ({ viewer, body }) => { const { state, now } = sweepAndNow(); meet.setRadar(state, resolveDemoUser(state, body.viewer ?? viewer), body.active === true, body.traits, now); return { ok: true }; },
  "POST /ring": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const bellId = meet.ringBell(state, resolveDemoUser(state, body.viewer ?? viewer), body.message, now); return { ok: true, bellId }; },
  "POST /respond": ({ viewer, body }) => { const { state, now } = sweepAndNow(); meet.respondBell(state, resolveDemoUser(state, body.viewer ?? viewer), body.bellId, body.status, now); return { ok: true }; },
  "POST /connection-close": ({ viewer, body }) => { const { state, now } = sweepAndNow(); meet.closeConnection(state, resolveDemoUser(state, body.viewer ?? viewer), body.connectionId, now); return { ok: true }; },
  // ---------- 授权 ----------
  "POST /share-grants": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const id = rel.createShareGrant(state, resolveDemoUser(state, body.viewer ?? viewer), body.scope, now); return { ok: true, grantId: id }; },
  "POST /share-grants/revoke": ({ viewer, body }) => { const { state, now } = sweepAndNow(); rel.revokeShareGrant(state, resolveDemoUser(state, body.viewer ?? viewer), body.grantId, now); return { ok: true }; },
  // ---------- 关系 ----------
  "POST /relationships/propose": ({ viewer, body }) => { const { state, now } = sweepAndNow(); return rel.proposeRelationship(state, resolveDemoUser(state, body.viewer ?? viewer), now); },
  "POST /relationships/accept": ({ viewer, body }) => { const { state, now } = sweepAndNow(); rel.acceptRelationship(state, resolveDemoUser(state, body.viewer ?? viewer), body.relationshipId, now); return { ok: true }; },
  "POST /relationships/decline": ({ viewer, body }) => { const state = getV2State(); rel.declineRelationship(state, resolveDemoUser(state, body.viewer ?? viewer), body.relationshipId); return { ok: true }; },
  "POST /relationships/cancel": ({ viewer, body }) => { const state = getV2State(); rel.cancelRelationship(state, resolveDemoUser(state, body.viewer ?? viewer), body.relationshipId); return { ok: true }; },
  "POST /relationships/end": ({ viewer, body }) => { const { state, now } = sweepAndNow(); rel.endRelationship(state, resolveDemoUser(state, body.viewer ?? viewer), body.relationshipId, body.reason, now); return { ok: true }; },
  "POST /space-settings": ({ viewer, body }) => { const state = getV2State(); rel.updateSpaceSettings(state, resolveDemoUser(state, body.viewer ?? viewer), body.relationshipId, body); return { ok: true }; },
  // ---------- 我们：日记 ----------
  // v2.7：创建类接口支持 Idempotency-Key 请求头（或 body.idempotencyKey），网络重试返回原记录。
  "POST /diaries": ({ viewer, body, idempotencyKey }) => {
    const { state, now } = sweepAndNow();
    const key = idempotencyKey ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
    const id = diary.createDiary(state, resolveDemoUser(state, body.viewer ?? viewer), body, now, { idempotencyKey: key });
    return { ok: true, diaryId: id };
  },
  "POST /diaries/version": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const version = diary.addDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true, version }; },
  "POST /diaries/share": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.shareDraft(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, now); return { ok: true }; },
  // v2.7：确认/退回/撤回必须携带 expectedVersion —— 旧版本请求 409，防止“看旧版确认了新版”。
  "POST /diaries/confirm": ({ viewer, body }) => {
    const { state, now } = sweepAndNow();
    diary.confirmDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), { diaryId: body.diaryId, expectedVersion: body.expectedVersion }, now);
    return { ok: true };
  },
  "POST /diaries/return": ({ viewer, body }) => {
    const state = getV2State();
    diary.returnDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), { diaryId: body.diaryId, expectedVersion: body.expectedVersion, note: body.note });
    return { ok: true };
  },
  "POST /diaries/withdraw": ({ viewer, body }) => {
    const state = getV2State();
    diary.withdrawDiary(state, resolveDemoUser(state, body.viewer ?? viewer), { diaryId: body.diaryId, expectedVersion: body.expectedVersion });
    return { ok: true };
  },
  "POST /diaries/anchor": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.anchorDiary(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, now); return { ok: true }; },
  // ---------- 我们：承诺 ----------
  "POST /promises": ({ viewer, body, idempotencyKey }) => {
    const { state, now } = sweepAndNow();
    const key = idempotencyKey ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
    const id = diary.createPromise(state, resolveDemoUser(state, body.viewer ?? viewer), body, now, { idempotencyKey: key });
    return { ok: true, promiseId: id };
  },
  "POST /promises/confirm": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.confirmPromise(state, resolveDemoUser(state, body.viewer ?? viewer), body.promiseId, body.expectedRevision, now); return { ok: true }; },
  "POST /promises/return": ({ viewer, body }) => { const state = getV2State(); diary.returnPromise(state, resolveDemoUser(state, body.viewer ?? viewer), body.promiseId); return { ok: true }; },
  "POST /promises/resolutions": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.recordResolution(state, resolveDemoUser(state, body.viewer ?? viewer), body.promiseId, body, now); return { ok: true }; },
  "POST /promises/resolutions/confirm": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.confirmResolution(state, resolveDemoUser(state, body.viewer ?? viewer), body.promiseId, body.subjectUserId, body.outcome, now); return { ok: true }; },
  "POST /promises/resolutions/dispute": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.disputePromiseResolution(state, resolveDemoUser(state, body.viewer ?? viewer), body.promiseId, body.subjectUserId, now); return { ok: true }; },
  // ---------- 相守 ----------
  "POST /plans": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const id = plan.createPlan(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true, planId: id }; },
  "POST /plans/accept": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.acceptPlan(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true }; },
  "POST /plans/cancel": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.cancelPlan(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true }; },
  "POST /plans/claims": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.submitClaim(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true }; },
  // v2.5 补正闭环：need_more → 补充材料 → submitted（保留原 claimId 与审核记录）。
  "POST /plans/claims/supplement": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.supplementClaim(state, resolveDemoUser(state, body.viewer ?? viewer), body.claimId, body.note, now); return { ok: true }; },
  "POST /benefits/redeem": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.redeemBenefit(state, resolveDemoUser(state, body.viewer ?? viewer), body.benefitId, body, now); return { ok: true }; },
  "POST /disputes": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.raiseDispute(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true }; },
  // ---------- 存证 ----------
  "POST /anchors/retry": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const job = anchor.retryAnchor(state, resolveDemoUser(state, body.viewer ?? viewer), body.recordId, now); return { ok: true, status: job.status }; },
  // ---------- 站内通知（v2.5） ----------
  "POST /notifications/read": ({ viewer, body }) => {
    const state = getV2State();
    const me = resolveDemoUser(state, body.viewer ?? viewer);
    const all = body.all === true;
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    let updated = 0;
    for (const n of state.notifications) {
      if (n.userId !== me || n.readAt !== null) continue;
      if (!all && !ids.includes(n.id)) continue;
      n.readAt = Date.now();
      updated += 1;
    }
    return { ok: true, updated };
  },
  // ---------- 演示台（仅 APP_MODE=demo；独立演示工具，不套用户会话） ----------
  "GET /admin/snapshot": () => admin.adminSnapshot(getV2State()),
  "POST /admin/reset": () => { admin.adminReset(); return { ok: true }; },
  "POST /admin/advance-time": ({ body }) => ({ ok: true, virtualNow: admin.adminAdvanceTime(body.ms) }),
  "POST /admin/chain-fault": ({ body }) => ({ ok: true, chainFault: admin.adminSetChainFault(body.active) }),
  "POST /admin/claims/decision": ({ body }) => { admin.adminDecideClaim(getV2State(), body.claimId, body); return { ok: true }; },
  "POST /admin/exception/resolve": ({ body }) => { admin.adminResolveException(getV2State(), body.planId, body.decision); return { ok: true }; },
  "POST /admin/trust-dispute/resolve": ({ body }) => { admin.adminResolveTrustDispute(getV2State(), body.promiseId, body.finalResult, body.subjectUserId); return { ok: true }; },
  // ---------- 安全与隐私（v2.6） ----------
  "GET /privacy/overview": ({ viewer }) => { const { state, now } = sweepAndNow(); return privacy.privacyOverview(state, resolveDemoUser(state, viewer), now); },
  "GET /privacy/grants": ({ viewer }) => { const { state, now } = sweepAndNow(); return privacy.myGrants(state, resolveDemoUser(state, viewer), now); },
  "POST /privacy/grants/revoke-all": ({ viewer, body }) => {
    const { state, now } = sweepAndNow();
    return privacy.revokeAllGrantsFor(state, resolveDemoUser(state, body.viewer ?? viewer), body.connectionId, body.expectedActive, now);
  },
  "POST /privacy/exports": ({ viewer, body }) => { const { state, now } = sweepAndNow(); return privacy.createExport(state, resolveDemoUser(state, body.viewer ?? viewer), body.scopes, now); },
  "GET /privacy/exports/:id": ({ viewer, params }) => { const { state } = sweepAndNow(); return privacy.exportDetail(state, resolveDemoUser(state, viewer), params[2]); },
  "GET /privacy/exports/:id/download": ({ viewer, params }) => { const { state } = sweepAndNow(); return privacy.downloadExport(state, resolveDemoUser(state, viewer), params[2]); },
  "POST /privacy/deletions": ({ viewer, body }) => {
    const { state, now } = sweepAndNow();
    return privacy.requestDeletion(state, resolveDemoUser(state, body.viewer ?? viewer), {
      password: body.password, confirmation: body.confirmation, endBindingConsent: body.endBindingConsent,
    }, now);
  },
  // 独立受限凭据查询：不依赖用户会话（注销后原会话已全部撤销，只能用凭据查结果）。
  "GET /privacy/deletions/:id/credential": ({ url, params }) => privacy.deletionStatusByCredential(getV2State(), params[2], url.searchParams.get("credential")),
  "GET /safety/target-context": ({ viewer, url }) => {
    const { state, now } = sweepAndNow();
    return safety.targetContext(state, resolveDemoUser(state, viewer), url.searchParams.get("sourceType"), url.searchParams.get("sourceId"), now);
  },
  "GET /safety/blocks": ({ viewer }) => { const { state } = sweepAndNow(); return safety.listBlocks(state, resolveDemoUser(state, viewer)); },
  "POST /safety/blocks": ({ viewer, body }) => { const { state, now } = sweepAndNow(); return safety.blockTarget(state, resolveDemoUser(state, body.viewer ?? viewer), body.targetRef, now); },
  "POST /safety/blocks/:id/revoke": ({ viewer, body, params }) => {
    const { state, now } = sweepAndNow();
    return safety.unblockTarget(state, resolveDemoUser(state, body.viewer ?? viewer), params[2], body.expectedRevision, now);
  },
  "GET /safety/reports": ({ viewer }) => { const { state } = sweepAndNow(); return safety.listReports(state, resolveDemoUser(state, viewer)); },
  "POST /safety/reports": ({ viewer, body }) => {
    const { state, now } = sweepAndNow();
    return safety.createReport(state, resolveDemoUser(state, body.viewer ?? viewer), {
      targetRef: body.targetRef, reason: body.reason, description: body.description, blockTarget: body.blockTarget,
    }, now);
  },
  "GET /safety/reports/:id": ({ viewer, params }) => { const { state } = sweepAndNow(); return safety.reportDetail(state, resolveDemoUser(state, viewer), params[2]); },
  "POST /safety/reports/:id/supplements": ({ viewer, body, params }) => {
    const { state, now } = sweepAndNow();
    return safety.supplementReport(state, resolveDemoUser(state, body.viewer ?? viewer), params[2], body.text, body.expectedRevision, now);
  },
  "POST /safety/reports/:id/withdraw": ({ viewer, body, params }) => {
    const { state, now } = sweepAndNow();
    return safety.withdrawReport(state, resolveDemoUser(state, body.viewer ?? viewer), params[2], body.expectedRevision, now);
  },
  "POST /safety/reports/:id/appeals": ({ viewer, body, params }) => {
    const { state, now } = sweepAndNow();
    return safety.appealReport(state, resolveDemoUser(state, body.viewer ?? viewer), params[2], body.reason, body.expectedRevision, now);
  },
};

// 无需用户会话的例外路由（演示台 / 受限凭据查询）。
function routeExemptFromSession(key: string, path: string[]): boolean {
  if (key.startsWith("GET /admin/") || key.startsWith("POST /admin/")) return true;
  // 注销结果查询使用独立受限凭据（注销后原会话已撤销）。
  if (path.length === 4 && path[0] === "privacy" && path[1] === "deletions" && path[3] === "credential") return true;
  return false;
}

// 参数化路由解析（v2.6 安全与隐私新增 /privacy/...、/safety/...）。
function resolveRoute(key: string, path: string[]): Handler | undefined {
  const direct = routes[key];
  if (direct) return direct;
  if (path.length === 3 && path[0] === "privacy" && path[1] === "exports") {
    return routes["GET /privacy/exports/:id"];
  }
  if (path.length === 4 && path[0] === "privacy" && path[1] === "exports" && path[3] === "download") {
    return routes["GET /privacy/exports/:id/download"];
  }
  if (path.length === 4 && path[0] === "privacy" && path[1] === "deletions" && path[3] === "credential") {
    return routes["GET /privacy/deletions/:id/credential"];
  }
  if (path.length === 3 && path[0] === "safety" && path[1] === "reports") {
    return key.startsWith("GET ") ? routes["GET /safety/reports/:id"] : undefined;
  }
  if (path.length === 4 && path[0] === "safety" && path[1] === "reports") {
    if (path[3] === "supplements") return routes["POST /safety/reports/:id/supplements"];
    if (path[3] === "withdraw") return routes["POST /safety/reports/:id/withdraw"];
    if (path[3] === "appeals") return routes["POST /safety/reports/:id/appeals"];
  }
  if (path.length === 4 && path[0] === "safety" && path[1] === "blocks" && path[3] === "revoke") {
    return routes["POST /safety/blocks/:id/revoke"];
  }
  return undefined;
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const url = new URL(request.url);
    const key = `GET /${(path ?? []).join("/")}`;
    const handler = resolveRoute(key, path ?? []);
    if (!handler) return fail(new ApiError(404, "NOT_FOUND", `未知接口：${key}`));
    let viewer: string | null = url.searchParams.get("viewer");
    if (!routeExemptFromSession(key, path ?? [])) {
      viewer = requireDemoSession(request.headers.get("cookie"), viewer);
    }
    return ok(handler({ viewer, body: {}, params: path ?? [], url, idempotencyKey: null }));
  } catch (error) {
    return fail(error as Error);
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
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(new ApiError(400, "BAD_REQUEST", "请求必须为对象"));
    const key = `POST /${(path ?? []).join("/")}`;
    const handler = resolveRoute(key, path ?? []);
    if (!handler) return fail(new ApiError(404, "NOT_FOUND", `未知接口：${key}`));
    const queryViewer = url.searchParams.get("viewer");
    const bodyViewer = typeof body.viewer === "string" ? body.viewer : null;
    // body 与 query 同时携带不同 viewer 时拒绝，不悄悄选择其中一个。
    let viewer: string | null;
    if (bodyViewer !== null && queryViewer !== null && bodyViewer !== queryViewer) {
      return fail(new ApiError(400, "BAD_REQUEST", "请求中的 viewer 参数冲突"));
    }
    viewer = bodyViewer ?? queryViewer;
    if (!routeExemptFromSession(key, path ?? [])) {
      viewer = requireDemoSession(request.headers.get("cookie"), viewer);
    }
    // v2.7：读取 Idempotency-Key 请求头（创建类接口的服务端幂等依据）。
    const idempotencyKey = request.headers.get("idempotency-key");
    return ok(handler({ viewer, body, params: path ?? [], url, idempotencyKey }));
  } catch (error) {
    return fail(error as Error);
  }
}
