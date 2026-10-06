// /api/v2 统一入口（计划书 10.3 节）。旧 /api/demo 保留为 legacy，仅限 demo 模式。
// 会话：P0 使用 viewer=a|b 本地演示身份（服务端仍然执行全部权限校验）；
// live 模式必须替换为服务端可信会话，不信任请求中的身份参数。
import { NextResponse } from "next/server";
import { getV2State, runModes, sweepAndNow } from "../../../../lib/server/v2/registry";
import { ApiError } from "../../../../lib/server/v2/errors";
import { resolveDemoUser } from "../../../../lib/server/v2/session";
import * as meet from "../../../../lib/server/v2/services/meet";
import * as rel from "../../../../lib/server/v2/services/relationship";
import * as trust from "../../../../lib/server/v2/services/trust";
import * as diary from "../../../../lib/server/v2/services/diary";
import * as plan from "../../../../lib/server/v2/services/plan";
import * as anchor from "../../../../lib/server/v2/services/anchor";
import * as admin from "../../../../lib/server/v2/services/admin";
import { buildStateView } from "../../../../lib/server/v2/services/view";

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

type Handler = (ctx: { viewer: string | null; body: Record<string, unknown>; params: string[]; url: URL }) => unknown;

const routes: Record<string, Handler> = {
  // ---------- 视图 ----------
  "GET /state": ({ viewer }) => { const { state } = sweepAndNow(); return buildStateView(state, resolveDemoUser(state, viewer)); },
  "GET /me": ({ viewer }) => { const { state } = sweepAndNow(); const v = resolveDemoUser(state, viewer); return buildStateView(state, v).me; },
  "GET /diaries/detail": ({ viewer, url }) => {
    const { state, now } = sweepAndNow();
    return diary.getDiaryDetail(state, resolveDemoUser(state, viewer), url.searchParams.get("id"));
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
  "POST /diaries": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const id = diary.createDiary(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true, diaryId: id }; },
  "POST /diaries/version": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const version = diary.addDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true, version }; },
  "POST /diaries/share": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.shareDraft(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, now); return { ok: true }; },
  "POST /diaries/confirm": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.confirmDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, now); return { ok: true }; },
  "POST /diaries/return": ({ viewer, body }) => { const state = getV2State(); diary.returnDiaryVersion(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, body.note); return { ok: true }; },
  "POST /diaries/withdraw": ({ viewer, body }) => { const state = getV2State(); diary.withdrawDiary(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId); return { ok: true }; },
  "POST /diaries/anchor": ({ viewer, body }) => { const { state, now } = sweepAndNow(); diary.anchorDiary(state, resolveDemoUser(state, body.viewer ?? viewer), body.diaryId, now); return { ok: true }; },
  // ---------- 我们：承诺 ----------
  "POST /promises": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const id = diary.createPromise(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true, promiseId: id }; },
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
  "POST /benefits/redeem": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.redeemBenefit(state, resolveDemoUser(state, body.viewer ?? viewer), body.benefitId, body, now); return { ok: true }; },
  "POST /disputes": ({ viewer, body }) => { const { state, now } = sweepAndNow(); plan.raiseDispute(state, resolveDemoUser(state, body.viewer ?? viewer), body, now); return { ok: true }; },
  // ---------- 存证 ----------
  "POST /anchors/retry": ({ viewer, body }) => { const { state, now } = sweepAndNow(); const job = anchor.retryAnchor(state, resolveDemoUser(state, body.viewer ?? viewer), body.recordId, now); return { ok: true, status: job.status }; },
  // ---------- 演示台（仅 APP_MODE=demo） ----------
  "GET /admin/snapshot": () => admin.adminSnapshot(getV2State()),
  "POST /admin/reset": () => { admin.adminReset(); return { ok: true }; },
  "POST /admin/advance-time": ({ body }) => ({ ok: true, virtualNow: admin.adminAdvanceTime(body.ms) }),
  "POST /admin/chain-fault": ({ body }) => ({ ok: true, chainFault: admin.adminSetChainFault(body.active) }),
  "POST /admin/claims/decision": ({ body }) => { admin.adminDecideClaim(getV2State(), body.claimId, body); return { ok: true }; },
  "POST /admin/exception/resolve": ({ body }) => { admin.adminResolveException(getV2State(), body.planId, body.decision); return { ok: true }; },
  "POST /admin/trust-dispute/resolve": ({ body }) => { admin.adminResolveTrustDispute(getV2State(), body.promiseId, body.finalResult); return { ok: true }; },
};

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const url = new URL(request.url);
    const key = `GET /${(path ?? []).join("/")}`;
    const handler = routes[key];
    if (!handler) return fail(new ApiError(404, "NOT_FOUND", `未知接口：${key}`));
    return ok(handler({ viewer: url.searchParams.get("viewer"), body: {}, params: path ?? [], url }));
  } catch (error) {
    return fail(error as Error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const url = new URL(request.url);
    let body: Record<string, unknown>;
    try { body = (await request.json()) as Record<string, unknown>; }
    catch { body = {}; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(new ApiError(400, "BAD_REQUEST", "请求必须为对象"));
    const key = `POST /${(path ?? []).join("/")}`;
    const handler = routes[key];
    if (!handler) return fail(new ApiError(404, "NOT_FOUND", `未知接口：${key}`));
    return ok(handler({ viewer: (body.viewer as string) ?? url.searchParams.get("viewer"), body, params: path ?? [], url }));
  } catch (error) {
    return fail(error as Error);
  }
}
