// 演示台服务（计划书 7.2 /demo/admin）：仅 APP_MODE=demo 且本地开发开放。
import type { V2State } from "../../../repositories/demo-repo";
import { balanceOf } from "../../../repositories/demo-repo";
import { advanceClock, requireDemoMode, resetDemo, runModes, now as v2now } from "../registry";
import { badRequest } from "../errors";
import { setChainFault, chainFaultActive } from "./anchor";
import { decideClaim, resolveException } from "./plan";
import { refreshFor } from "./trust";
import { maybeAnchorPromiseSettlement } from "./diary";

export function adminSnapshot(state: V2State) {
  requireDemoMode();
  const t = v2now(state);
  return {
    modes: { ...runModes(), virtualNow: t },
    chainFault: chainFaultActive(),
    claims: state.claims.map(c => ({
      ...c,
      plan: (() => { const p = state.plans.find(p => p.id === c.planId); return p ? { id: p.id, status: p.status, targetType: p.targetType, relationshipId: p.relationshipId } : null; })(),
    })),
    exceptions: state.plans.filter(p => p.status === "exception_review").map(p => ({ id: p.id, relationshipId: p.relationshipId, endedReason: p.endedReason })),
    disputes: state.disputes,
    accounts: {
      userA: balanceOf(state, "user:a", "demo-point"),
      userB: balanceOf(state, "user:b", "demo-point"),
      rewardPool: balanceOf(state, "pool:reward", "demo-point"),
      roseStock: balanceOf(state, "pool:reward", "rose-ticket"),
      forfeitAccount: balanceOf(state, "pool:forfeit-demo", "demo-point"),
    },
    relationships: state.relationships.filter(r => !r.id.startsWith("fx-")).map(r => ({ id: r.id, status: r.status, members: r.members })),
    plans: state.plans.map(p => ({ id: p.id, status: p.status, revision: p.revision })),
    anchorJobs: state.anchorJobs.map(j => ({ id: j.id, recordId: j.recordId, status: j.status, commitment: j.commitment, attempts: j.attempts })),
  };
}

export function adminReset(): void {
  requireDemoMode();
  resetDemo();
}

export function adminAdvanceTime(ms: unknown): number {
  requireDemoMode();
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > 400 * 86_400_000) {
    throw badRequest("无效时间推进（毫秒，1–400 天）");
  }
  return advanceClock(ms);
}

export function adminSetChainFault(active: unknown): boolean {
  requireDemoMode();
  setChainFault(active === true);
  return chainFaultActive();
}

export function adminDecideClaim(state: V2State, claimId: unknown, input: Record<string, unknown>): void {
  requireDemoMode();
  decideClaim(state, claimId, input, v2now(state));
}

export function adminResolveException(state: V2State, planId: unknown, decision: unknown): void {
  requireDemoMode();
  if (typeof planId !== "string") throw badRequest("无效计划 ID");
  resolveException(state, planId, String(decision), v2now(state));
}

// 演示台解决履约争议：人工复核结论直接落为最终结果，并刷新摘要版本。
export function adminResolveTrustDispute(state: V2State, promiseId: unknown, finalResult: unknown): void {
  requireDemoMode();
  const promise = state.promises.find(p => p.id === promiseId);
  if (!promise) throw badRequest("承诺不存在");
  const result = String(finalResult);
  if (!["fulfilled", "unfulfilled", "waived"].includes(result)) throw badRequest("无效复核结论");
  const t = v2now(state);
  for (const uid of promise.responsibleUserIds) {
    promise.resolutions[uid] = {
      result: result as "fulfilled", note: promise.resolutions[uid]?.note ?? null,
      settledAt: t, confirmedBy: ["demo-admin"],
    };
  }
  const dispute = state.disputes.find(d => d.targetId === promise.id && !d.resolvedAt);
  if (dispute) { dispute.resolvedAt = t; dispute.resolution = result; }
  // v2.2：复核结论改变结算结果，锚定新版本存证（版本 3，保留原结算版本）。
  maybeAnchorPromiseSettlement(state, promise, t, 3);
  const rel = state.relationships.find(r => r.id === promise.relationshipId);
  if (rel) for (const member of rel.members) refreshFor(state, member, t);
}
