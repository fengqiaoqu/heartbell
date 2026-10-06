// V2 注册表：全局单例、虚拟业务时钟、运行模式与时间驱动的状态清扫。
// 演示时钟仅推进虚拟业务时间，不修改系统时间或链上时间。
import type { CommitmentPlan, RunModes } from "../../domain/v2-types";
import { balanceOf, createDemoState, postLedger, type V2State } from "../../repositories/demo-repo";
import { DAY, EXCEPTION_LIMIT_DAYS } from "../../domain/plan-rules";
import { teardownEventDiscovery } from "./services/events";
import { forbidden } from "./errors";

const globals = globalThis as typeof globalThis & { heartbellV2?: { state: V2State } };

export function getV2State(): V2State {
  globals.heartbellV2 ??= { state: createDemoState(realNow()) };
  return globals.heartbellV2.state;
}

export function realNow(): number { return Date.now(); }
export function now(state: V2State): number { return realNow() + state.virtualOffsetMs; }

export function advanceClock(ms: number): number {
  const state = getV2State();
  state.virtualOffsetMs += ms;
  sweep(state);
  return now(state);
}

export function resetDemo(): void {
  globals.heartbellV2 = { state: createDemoState(realNow()) };
}

export function runModes(): RunModes {
  const appMode = process.env.APP_MODE === "live" ? "live" : "demo";
  const rawChain = process.env.CHAIN_MODE;
  let chainMode: RunModes["chainMode"] = "preview";
  if (rawChain === "bot_testnet" || rawChain === "bot_mainnet") {
    // 真实链模式必须同时配置 RPC 与合约地址，否则明确报配置错误，不降级假成功。
    if (!process.env.CHAIN_RPC_URL || !process.env.NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS) {
      throw new Error("CHAIN_MODE 配置错误：真实链模式需要 CHAIN_RPC_URL 与 NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS");
    }
    chainMode = rawChain;
  }
  const rewardMode = process.env.REWARD_MODE === "partner" ? "partner" : "demo";
  const claimVerifierMode = process.env.CLAIM_VERIFIER_MODE === "manual" || process.env.CLAIM_VERIFIER_MODE === "provider"
    ? process.env.CLAIM_VERIFIER_MODE : "demo";
  return { appMode, chainMode, rewardMode, claimVerifierMode };
}

// 演示台、重置、虚拟时间仅在 APP_MODE=demo 开放；live 模式服务端直接拒绝。
export function requireDemoMode(): void {
  if (runModes().appMode !== "demo") {
    throw forbidden("演示台仅在 APP_MODE=demo 的本地演示环境开放");
  }
}

// 时间驱动的状态迁移：每次读取状态前调用，保证轮询看到一致的过期/到期结果。
// v2.8（M03）：先处理活动与雷达到期，再处理铃声、短期引用与相遇幂等记录。
export function sweep(state: V2State): void {
  const t = now(state);
  state.lastSweepAt = Date.now();
  // 0. 活动自然到期按关闭处理（结束成员身份并清理发现态；closed 不能重开）。
  for (const event of state.events) {
    if (event.status !== "closed" && event.endsAt <= t) {
      event.status = "closed";
      event.closedReason = "expired";
      teardownEventDiscovery(state, event.id, true, t);
    }
  }
  // 1. 雷达到期
  for (const radar of state.radar.values()) {
    if (radar.active && radar.expiresAt !== null && radar.expiresAt <= t) radar.active = false;
  }
  // 2. 铃声过期：v2.8 起按每条铃声自身的 expiresAt（受双方雷达/活动截止约束），
  //    兼容无 expiresAt 的历史数据仍按创建后 10 分钟。
  for (const bell of state.bells) {
    if (bell.status !== "pending") continue;
    const deadline = bell.expiresAt ?? bell.createdAt + 600_000;
    if (t >= deadline) bell.status = "expired";
  }
  // 2b. 短期候选引用与相遇幂等记录回收（防轮询无限增长）。
  if (state.candidateRefs.length > 0) {
    state.candidateRefs = state.candidateRefs.filter(ref => ref.expiresAt > t);
  }
  if (state.meetIdempotency.length > 0) {
    state.meetIdempotency = state.meetIdempotency.filter(e => e.expiresAt > t);
  }
  // 3. 关系邀请过期（72 小时）
  for (const rel of state.relationships) {
    if (rel.status === "proposed" && t > rel.inviteExpiresAt) rel.status = "expired";
  }
  // 4. 计划时间线
  for (const plan of state.plans) {
    if (plan.status === "awaiting_partner" && t > plan.inviteExpiresAt) {
      plan.status = "cancelled";
      plan.endedReason = "expired";
    }
    if (plan.status === "active" && plan.graceUntil !== null && t > plan.graceUntil) {
      // 审核期间到期不吞掉在途申请；无有效申请才按到期失效（宽限期即争议期）
      const hasClaim = state.claims.some(c => c.planId === plan.id && ["submitted", "need_more", "approved"].includes(c.status));
      if (!hasClaim) {
        plan.status = "forfeited";
        plan.endedReason = "expired";
        settleForfeit(state, plan, t);
      }
    }
    if (plan.status === "claim_review") {
      const claim = state.claims.find(c => c.planId === plan.id && (c.status === "submitted" || c.status === "need_more"));
      if (claim?.reviewDeadlineAt && t > claim.reviewDeadlineAt) {
        plan.status = "exception_review"; // 审核超期转入例外复核，不无限停留
        plan.exceptionOpenedAt ??= t;      // v2.5：例外复核起点，不用 activatedAt 代替
        plan.revision += 1;
      }
    }
    if (plan.status === "forfeit_pending" && plan.forfeitWindowUntil !== null && t > plan.forfeitWindowUntil) {
      plan.status = "forfeited";
      settleForfeit(state, plan, t);
    }
    if (plan.status === "approved") {
      const claim = state.claims.find(c => c.planId === plan.id && c.status === "approved");
      if (claim?.appealUntil && t > claim.appealUntil) {
        plan.status = "redeemable";
        createBenefitFor(state, plan, t);
      }
    }
    if (plan.status === "exception_review") {
      // v2.5：例外时限统一从 exceptionOpenedAt 起算（进入例外状态的各路径都会设置）。
      const started = plan.exceptionOpenedAt
        ?? state.disputes.find(d => d.targetId === plan.id && !d.resolvedAt)?.createdAt
        ?? plan.activatedAt;
      if (started !== null && started !== undefined && t - started > EXCEPTION_LIMIT_DAYS * DAY) {
        // 例外复核 30 天未完成：演示版按平台无法履约取消并退回双方本金，保留申诉记录
        plan.status = "cancelled";
        plan.endedReason = "exception";
        plan.revision += 1;
        refundPrincipals(state, plan, t, "exception-timeout");
      }
    }
  }
}

export function planMembers(state: V2State, plan: CommitmentPlan): string[] {
  const rel = state.relationships.find(r => r.id === plan.relationshipId);
  return rel ? [...rel.members] : [];
}

export function settleForfeit(state: V2State, plan: CommitmentPlan, t: number): void {
  const escrow = `plan:${plan.id}`;
  const escrowPoints = balanceOf(state, escrow, "demo-point");
  if (escrowPoints > 0) {
    postLedger(state, {
      from: escrow, to: "pool:forfeit-demo", amount: escrowPoints, unit: "demo-point",
      businessKey: `forfeit:${plan.id}`, type: "forfeit",
      note: "投入记入不可流通的演示失效账户（不转给任何人）",
    }, t);
  }
  releaseReservation(state, plan);
}

export function refundPrincipals(state: V2State, plan: CommitmentPlan, t: number, keyPrefix: string, options?: { releaseReservation?: boolean }): void {
  const escrow = `plan:${plan.id}`;
  for (const uid of planMembers(state, plan)) {
    postLedger(state, {
      from: escrow, to: `user:${uid}`, amount: plan.investPerUser, unit: "demo-point",
      businessKey: `refund:${keyPrefix}:${plan.id}:${uid}`, type: "refund",
      note: "退回本人投入",
    }, t);
  }
  // v2.5 修正：达成结算（redeemBenefit）时预留最终状态必须是 consumed 而不是 released；
  // 只有取消/失效路径才释放预留（released 只表示回到可用库存）。
  if (options?.releaseReservation !== false) releaseReservation(state, plan);
}

export function releaseReservation(state: V2State, plan: CommitmentPlan): void {
  const reservation = state.reservations.find(r => r.planId === plan.id && r.status === "reserved");
  if (reservation) reservation.status = "released";
}

export function consumeReservation(state: V2State, plan: CommitmentPlan): void {
  const reservation = state.reservations.find(r => r.planId === plan.id && r.status === "reserved");
  if (reservation) reservation.status = "consumed";
}

function createBenefitFor(state: V2State, plan: CommitmentPlan, t: number): void {
  if (state.benefits.some(b => b.planId === plan.id)) return; // 每 planId 仅产生一次 benefitId
  const rel = state.relationships.find(r => r.id === plan.relationshipId);
  // 奖励 A（点数）与奖励 B（玫瑰演示券）均为双方共同权益。
  const recipients = [...(rel?.members ?? [])];
  state.benefits.push({
    id: `benefit-${plan.id}`, planId: plan.id,
    kind: plan.rewardChoice === "A" ? "points_each" : "rose_ticket",
    recipients, status: "redeemable", createdAt: t, redeemedAt: null,
    idempotencyKey: `benefit:${plan.id}`,
  });
}

export function sweepAndNow(): { state: V2State; now: number } {
  const state = getV2State();
  sweep(state);
  return { state, now: now(state) };
}
