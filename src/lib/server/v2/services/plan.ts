// 相守计划服务（计划书第 6 节）：演示点数账本、冷静期、审核、领取、失效与例外复核。
// v2.5：新增补正闭环（need_more → supplement → submitted）、受控审核（actor/版本/原因码/通知）、
// 例外复核起点 exceptionOpenedAt、结算预留最终状态 consumed。
import type { V2State } from "../../../repositories/demo-repo";
import { balanceOf, postLedger, pushNotification } from "../../../repositories/demo-repo";
import { ApiError, badRequest, conflict, forbidden, notFound, versionConflict } from "../errors";
import {
  DAY, GRACE_DAYS, HOUR, INVEST_PER_USER, PLAN_INVITE_HOURS, PLAN_TERMS_VERSION,
  REWARD_POINTS_EACH, claimAppealEnd, planCoolingEnd, planExpiry, planGraceEnd,
  planInviteExpiry, planForfeitWindowEnd, rewardBudgetFor, targetWindowValid,
  REVIEW_LIMIT_DAYS, SUPPLEMENT_LIMIT_DAYS,
} from "../../../domain/plan-rules";
import { consumeReservation, planMembers, refundPrincipals, releaseReservation, settleForfeit } from "../registry";
import { enqueueAnchor } from "./anchor";
import { activeRelationshipOf } from "../../../repositories/demo-repo";
import type { ClaimStatus, CommitmentPlan, GoalClaim, RewardChoice } from "../../../domain/v2-types";
import { businessDateKey } from "../../../domain/v2-types";

const activePlanStatuses = ["awaiting_partner", "active", "claim_review", "approved", "redeemable", "forfeit_pending", "exception_review"];

function findPlan(state: V2State, viewer: string, planId: unknown): { plan: CommitmentPlan; members: string[] } {
  if (typeof planId !== "string") throw badRequest("无效计划 ID");
  const plan = state.plans.find(p => p.id === planId);
  if (!plan) throw notFound("计划不存在");
  const rel = state.relationships.find(r => r.id === plan.relationshipId);
  if (!rel || !rel.members.includes(viewer)) throw forbidden("只有计划参与者可以操作");
  return { plan, members: [...rel.members] };
}

export function createPlan(state: V2State, viewer: string, input: Record<string, unknown>, now: number): string {
  const rel = activeRelationshipOf(state, viewer);
  if (!rel) throw forbidden("相守计划需要双方有效绑定后才能加入");
  // v2.5：后台功能开关（仅拦截新建邀请；已激活计划的审核/退款/领取继续）。
  if (!state.featureConfig.planNewEnabled) {
    throw new ApiError(503, "MAINTENANCE", "相守计划暂停新加入（维护公告期内），已成立的计划不受影响。", true);
  }
  if (state.plans.some(p => p.relationshipId === rel.id && activePlanStatuses.includes(p.status))) {
    throw conflict("PLAN_EXISTS", "这段关系已有一个进行中的相守计划");
  }
  const targetType = input.targetType === "anniversary" ? "anniversary" : "marriage";
  const rewardChoice: RewardChoice = input.rewardChoice === "B" ? "B" : "A";
  // 奖励 B 的玫瑰演示券为双方共同持有（每人各一张），不再指定单独领取人。
  const beneficiary: string | null = null;
  const plan: CommitmentPlan = {
    id: `plan-${Math.random().toString(36).slice(2, 10)}`,
    relationshipId: rel.id, status: "awaiting_partner",
    targetType, investPerUser: INVEST_PER_USER, rewardChoice, beneficiary,
    termsVersion: PLAN_TERMS_VERSION, proposedBy: viewer, partnerConsent: false,
    invitedAt: now, inviteExpiresAt: planInviteExpiry(now),
    activatedAt: null, coolingUntil: null, expiresAt: null, graceUntil: null,
    revision: 1, reservationId: null, forfeitWindowUntil: null, exceptionOpenedAt: null, endedReason: null, anchor: null,
  };
  state.plans.push(plan);
  return plan.id;
}

// 激活：双方同意 + 双方余额充足 + 奖励预留成功，全部检查通过后才扣点（无半激活状态）。
export function acceptPlan(state: V2State, viewer: string, input: Record<string, unknown>, now: number): void {
  const { plan, members } = findPlan(state, viewer, input.planId);
  // v2.5：暂停新计划时，未激活邀请同样不接受（已激活计划的审核/退款/领取继续）。
  if (!state.featureConfig.planNewEnabled) {
    throw new ApiError(503, "MAINTENANCE", "相守计划暂停新加入（维护公告期内），这份邀请暂不能接受。", true);
  }
  if (input.expectedRevision !== plan.revision) throw versionConflict("计划状态已更新，请重新确认。");
  if (input.termsConfirmed !== true) throw badRequest("需要确认条款后才能加入");
  if (plan.status !== "awaiting_partner") throw conflict("PLAN_STATE", "计划当前不可加入");
  if (plan.proposedBy === viewer) throw badRequest("发起人等待对方确认即可");
  const rel = state.relationships.find(r => r.id === plan.relationshipId)!;
  if (!["active", "married"].includes(rel.status)) throw conflict("RELATIONSHIP_ENDED", "关系已结束，无法激活新计划");
  for (const uid of members) {
    if (!state.users.get(uid)?.adultDeclared) throw forbidden("双方都需要完成成年演示声明");
    if (balanceOf(state, `user:${uid}`, "demo-point") < plan.investPerUser) {
      throw conflict("INSUFFICIENT_BALANCE", `演示点数余额不足（需要 ${plan.investPerUser} 点）`);
    }
  }
  const budget = rewardBudgetFor(plan.rewardChoice);
  const poolAvailable = balanceOf(state, "pool:reward", budget.kind === "points" ? "demo-point" : "rose-ticket");
  if (poolAvailable < budget.amount) {
    throw conflict("REWARD_UNAVAILABLE", "奖励预算不足，计划无法激活（双方均不会被扣点）");
  }
  // ---- 全部检查通过，以下为一次性变更 ----
  const reservation = {
    id: `reserve-${Math.random().toString(36).slice(2, 10)}`,
    planId: plan.id, kind: budget.kind, amount: budget.amount,
    status: "reserved" as const, createdAt: now,
  };
  state.reservations.push(reservation);
  plan.reservationId = reservation.id;
  for (const uid of members) {
    postLedger(state, {
      from: `user:${uid}`, to: `plan:${plan.id}`, amount: plan.investPerUser, unit: "demo-point",
      businessKey: `invest:${plan.id}:${uid}`, type: "invest", note: "相守计划投入（演示点数）",
    }, now);
  }
  plan.partnerConsent = true;
  plan.status = "active";
  plan.activatedAt = now;
  plan.coolingUntil = planCoolingEnd(now);
  plan.expiresAt = planExpiry(now);
  plan.graceUntil = planGraceEnd(plan.expiresAt);
  const job = enqueueAnchor(state, "plan_terms", plan.id, 1, {
    recordType: "plan_terms", recordId: plan.id, version: 1,
    relationshipId: plan.relationshipId,
    businessOccurredAt: new Date(now).toISOString(),
    previousVersionCommitment: null,
    participants: members,
    content: { targetType: plan.targetType, rewardChoice: plan.rewardChoice, investPerUser: plan.investPerUser, termsVersion: plan.termsVersion },
    attachmentHashes: [], rulesVersion: PLAN_TERMS_VERSION,
  }, now);
  plan.anchor = {
    jobId: job.id, commitment: job.commitment, chainStatus: job.status,
    txHash: job.txHash, blockNumber: job.blockNumber,
    networkLabel: job.chainMode === "preview" ? "preview（未连接真实链）" : job.chainMode,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

// 取消/结束：冷静期退款；普通结束进入 7 天异议窗口；例外进入复核。均不替代关系结束。
export function cancelPlan(state: V2State, viewer: string, input: Record<string, unknown>, now: number): void {
  const { plan, members } = findPlan(state, viewer, input.planId);
  if (input.expectedRevision !== plan.revision) throw versionConflict("计划状态已更新，请重新确认。");
  const reasonType = String(input.reasonType ?? "");
  if (plan.status === "awaiting_partner") {
    plan.status = "cancelled";
    plan.revision += 1;
    return;
  }
  if (reasonType === "exception") {
    if (["settled", "cancelled", "forfeited"].includes(plan.status)) throw conflict("PLAN_STATE", "计划已结束");
    plan.status = "exception_review";
    plan.exceptionOpenedAt ??= now; // v2.5：例外复核起点
    plan.revision += 1;
    state.disputes.push({
      id: `dispute-${Math.random().toString(36).slice(2, 10)}`,
      targetType: "plan", targetId: plan.id, raisedBy: viewer,
      note: typeof input.note === "string" ? input.note.slice(0, 120) : "申请例外处理",
      createdAt: now, resolvedAt: null, resolution: null, subjectUserId: null,
    });
    return;
  }
  if (plan.status !== "active") throw conflict("PLAN_STATE", "计划当前状态不支持该操作");
  if (plan.coolingUntil !== null && now < plan.coolingUntil) {
    // 冷静期内取消：原路退回双方投入，不给奖励。
    plan.status = "cancelled";
    plan.endedReason = "cooling_cancel";
    refundPrincipals(state, plan, now, "cooling");
    plan.revision += 1;
    return;
  }
  const inFlight = state.claims.some(c => c.planId === plan.id && ["submitted", "need_more", "approved"].includes(c.status));
  if (inFlight) throw conflict("CLAIM_PENDING", "已有在途的达成申请，请等待核验或走例外复核");
  // 冷静期后普通结束：进入 7 天异议窗口。
  plan.status = "forfeit_pending";
  plan.endedReason = "normal_end";
  plan.forfeitWindowUntil = planForfeitWindowEnd(now);
  plan.revision += 1;
  void members;
}

// 达成申请：目标必须发生在 [冷静期结束, 到期]；到期宽限期内仍可提交到期前已发生的目标。
export function submitClaim(state: V2State, viewer: string, input: Record<string, unknown>, now: number): void {
  const { plan, members } = findPlan(state, viewer, input.planId);
  if (!["active", "claim_review"].includes(plan.status)) {
    if (plan.status === "forfeit_pending") {
      // 异议窗口内仍可受理有证据的“结束前已达成”申请。
    } else {
      throw conflict("PLAN_STATE", "计划当前状态不可提交达成申请");
    }
  }
  const existing = state.claims.find(c => c.planId === plan.id && ["submitted", "need_more", "approved"].includes(c.status));
  if (existing) throw conflict("CLAIM_PENDING", "该计划已有在途申请");
  const occurredAt = typeof input.targetOccurredAt === "number" ? input.targetOccurredAt : Date.parse(String(input.targetOccurredAt));
  if (!Number.isFinite(occurredAt)) throw badRequest("请选择目标发生时间");
  if (!plan.activatedAt || !plan.coolingUntil || !plan.expiresAt) throw conflict("PLAN_STATE", "计划尚未激活");
  // v2.8 复测修复（N08）：核验目标采用“业务日期”语义 —— 目标发生日期不能晚于业务今天。
  // 此前页面把当天日期转成 12:00Z（北京时间 20:00），服务端只校验计划区间，
  // 未来 13+ 小时的“发生时刻”也能提交并通过审核。
  if (businessDateKey(occurredAt) > businessDateKey(now)) {
    throw badRequest("目标发生日期不能晚于今天");
  }
  if (!targetWindowValid(plan, occurredAt)) throw badRequest("目标必须发生在冷静期结束后、计划到期前（激活前已达成不计）");
  if (plan.graceUntil !== null && now > plan.graceUntil) throw badRequest("已超过到期宽限期，不能再提交申请");
  const evidenceNote = typeof input.evidenceNote === "string" && input.evidenceNote.trim() ? input.evidenceNote.trim().slice(0, 200) : null;
  if (!evidenceNote) throw badRequest("请说明演示材料（P0 全部为演示材料，醒目标注非真实证件）");
  const claim: GoalClaim = {
    id: `claim-${Math.random().toString(36).slice(2, 10)}`,
    planId: plan.id, submittedBy: viewer, targetOccurredAt: occurredAt,
    evidenceNote, isDemoMaterial: true, status: "submitted",
    submittedAt: now, decidedAt: null, decidedBy: null, decisionNote: null,
    appealUntil: null, dedupeToken: `claim:${plan.id}`,
    reviewDeadlineAt: now + REVIEW_LIMIT_DAYS * DAY,
    revision: 1, assignedTo: null, reasonCode: null, lastSupplementAt: null,
    materials: [{ index: 1, note: evidenceNote, submittedBy: viewer, submittedAt: now, source: "initial" }],
    reviewEvents: [],
  };
  state.claims.push(claim);
  plan.status = "claim_review";
  void members; void SUPPLEMENT_LIMIT_DAYS;
}

// v2.5 补正闭环（设计 3.2）：need_more → 用户补充材料 → submitted，保留原 claimId 与审核记录。
// 服务端校验成员、补正窗口、材料长度；补正后重新计算 7 天审核期限。
export function supplementClaim(state: V2State, viewer: string, claimId: unknown, note: unknown, now: number): void {
  if (typeof claimId !== "string") throw badRequest("无效申请 ID");
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim) throw notFound("申请不存在");
  const plan = state.plans.find(p => p.id === claim.planId)!;
  const rel = state.relationships.find(r => r.id === plan.relationshipId);
  if (!rel || !rel.members.includes(viewer)) throw forbidden("只有计划成员可以补充材料");
  if (claim.status !== "need_more") throw conflict("CLAIM_STATE", "该申请当前不在补正状态");
  if (plan.status !== "claim_review") {
    throw conflict("PLAN_STATE", "计划已进入例外复核，补正通道关闭，请等待人工复核");
  }
  if (claim.reviewDeadlineAt !== null && now > claim.reviewDeadlineAt) {
    throw conflict("SUPPLEMENT_EXPIRED", "已超过补正期限，申请转入例外复核处理");
  }
  const material = typeof note === "string" ? note.trim().slice(0, 200) : "";
  if (material.length < 2) throw badRequest("请说明补充的材料（2–200 字）");
  claim.materials.push({ index: claim.materials.length + 1, note: material, submittedBy: viewer, submittedAt: now, source: "supplement" });
  claim.evidenceNote = material; // 展示字段指向最新材料；完整历史见 materials
  claim.lastSupplementAt = now;
  claim.status = "submitted";
  claim.decidedAt = null;
  claim.decisionNote = null;
  claim.reviewDeadlineAt = now + REVIEW_LIMIT_DAYS * DAY;
  claim.revision += 1;
  claim.reviewEvents.push({ at: now, actor: viewer, decision: "supplement", reasonCode: null, note: `补充材料 v${claim.materials.length}` });
  plan.revision += 1;
}

// v2.5 受控审核决定：真实 actor、原因码、版本保护、审核时间线与双方站内通知。
// 演示台 decideClaim 是本函数的无版本保护包装（actor=demo-admin）。
export function decideClaimControlled(
  state: V2State,
  actor: string,
  claimId: string,
  input: { decision: string; reasonCode?: string | null; note?: string | null; expectedClaimRevision?: number; expectedPlanRevision?: number },
  now: number,
  options?: { skipVersionGuard?: boolean },
): { claimStatus: ClaimStatus; claimRevision: number; planRevision: number } {
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim) throw notFound("申请不存在");
  if (!["submitted", "need_more"].includes(claim.status)) throw conflict("CLAIM_STATE", "该申请已处理");
  const plan = state.plans.find(p => p.id === claim.planId)!;
  if (!options?.skipVersionGuard) {
    if (input.expectedClaimRevision !== undefined && input.expectedClaimRevision !== claim.revision) {
      throw versionConflict("申请已被他人处理（版本变化），请刷新后重新确认。");
    }
    if (input.expectedPlanRevision !== undefined && input.expectedPlanRevision !== plan.revision) {
      throw versionConflict("计划状态已更新，请刷新后重新确认。");
    }
  }
  const decision = String(input.decision ?? "");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  const reasonCode = typeof input.reasonCode === "string" && input.reasonCode.trim() ? input.reasonCode.trim().slice(0, 40) : null;
  if (decision === "need_more" && !note) throw new ApiError(422, "MATERIAL_INCOMPLETE", "要求补正必须写明缺失项说明");
  const members = planMembers(state, plan);

  claim.decidedAt = now;
  claim.decidedBy = actor;
  claim.decisionNote = note;
  claim.reasonCode = reasonCode;
  claim.revision += 1;
  plan.revision += 1;
  claim.reviewEvents.push({ at: now, actor, decision, reasonCode, note });

  if (decision === "approve") {
    claim.status = "approved";
    claim.appealUntil = claimAppealEnd(now);
    if (["claim_review", "exception_review"].includes(plan.status)) {
      plan.status = "approved";
      plan.exceptionOpenedAt = null;
    }
    // 婚姻目标通过审核：只有仍为 active 的关系可更新为 married；已结束的保持结束。
    if (plan.targetType === "marriage") {
      const rel = state.relationships.find(r => r.id === plan.relationshipId)!;
      if (rel.status === "active") { rel.status = "married"; rel.marriedAt = now; }
    }
    enqueueAnchor(state, "claim_result", claim.id, 1, {
      recordType: "claim_result", recordId: claim.id, version: 1,
      relationshipId: plan.relationshipId,
      businessOccurredAt: new Date(now).toISOString(),
      previousVersionCommitment: plan.anchor?.commitment ?? null,
      participants: planMembers(state, plan),
      content: { planId: plan.id, decision: "approved", targetOccurredAt: new Date(claim.targetOccurredAt).toISOString(), isDemoMaterial: true, reasonCode },
      attachmentHashes: [], rulesVersion: PLAN_TERMS_VERSION,
    }, now);
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: claim.id,
        title: "核验已通过",
        body: `目标核验已通过${note ? `：${note}` : ""}。进入 7 天争议期，期满后可领取奖励。`,
      }, now);
    }
  } else if (decision === "need_more") {
    claim.status = "need_more";
    claim.reviewDeadlineAt = now + SUPPLEMENT_LIMIT_DAYS * DAY;
    claim.decidedAt = null; // 补正后重新进入待审
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: claim.id,
        title: "需要补充材料",
        body: `审核要求补充材料（${reasonCode ?? "材料不足"}）：${note ?? ""}。请在 ${SUPPLEMENT_LIMIT_DAYS} 天内到相守页补充。`,
      }, now);
    }
  } else if (decision === "reject") {
    claim.status = "rejected";
    if (plan.status === "claim_review") plan.status = "active"; // 尚在有效期则回到进行中；否则 sweep 按到期处理
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: claim.id,
        title: "核验未通过",
        body: `核验未通过（${reasonCode ?? "未说明"}）：${note ?? ""}。规则允许范围内可以另行提交申请。`,
      }, now);
    }
  } else {
    throw badRequest("无效审核决定");
  }
  return { claimStatus: claim.status, claimRevision: claim.revision, planRevision: plan.revision };
}

// 审核决定：仅演示台（APP_MODE=demo），模拟“通过 / 补充材料 / 不通过”（无版本保护包装）。
export function decideClaim(state: V2State, claimId: unknown, input: Record<string, unknown>, now: number): void {
  if (typeof claimId !== "string") throw badRequest("无效申请 ID");
  decideClaimControlled(state, "demo-admin", claimId, {
    decision: String(input.decision ?? ""),
    reasonCode: input.reasonCode as string | undefined,
    note: input.note as string | undefined,
  }, now, { skipVersionGuard: true });
}

// 领取：仅受益人；一次性幂等，重复点击/并发/重试都只结算一次。
export function redeemBenefit(state: V2State, viewer: string, benefitId: unknown, input: Record<string, unknown>, now: number): void {
  if (typeof benefitId !== "string") throw badRequest("无效权益 ID");
  const benefit = state.benefits.find(b => b.id === benefitId);
  if (!benefit) throw notFound("权益不存在");
  if (!benefit.recipients.includes(viewer)) throw forbidden("只有权益领取人可以领取");
  if (benefit.status === "settled") return; // 幂等：重复领取返回原结果
  const plan = state.plans.find(p => p.id === benefit.planId)!;
  if (plan.status !== "redeemable") throw conflict("PLAN_STATE", "计划当前不可领取");
  // ---- 原子结算 ----
  // v2.5 修正：结算时预留走 consumed（预算已被使用），不再先 release 再 consume 导致
  // 已结算预留留在 released 状态（源码核对发现的衔接缺口 3）。
  refundPrincipals(state, plan, now, "settle", { releaseReservation: false });
  if (benefit.kind === "points_each") {
    for (const uid of planMembers(state, plan)) {
      postLedger(state, {
        from: "pool:reward", to: `user:${uid}`, amount: REWARD_POINTS_EACH, unit: "demo-point",
        businessKey: `reward:${plan.id}:${uid}`, type: "reward", note: "相守计划达成奖励（独立奖励预算）",
      }, now);
    }
  } else {
    // 玫瑰演示券双方共同持有：每人各得一张（预留库存 2 张）。
    for (const uid of planMembers(state, plan)) {
      postLedger(state, {
        from: "pool:reward", to: `user:${uid}`, amount: 1, unit: "rose-ticket",
        businessKey: `rose:${plan.id}:${uid}`, type: "redeem", note: "99 朵玫瑰演示券 · 双方共同持有（不可实际核销）",
      }, now);
    }
  }
  consumeReservation(state, plan);
  benefit.status = "settled";
  benefit.redeemedAt = now;
  plan.status = "settled";
  enqueueAnchor(state, "settlement", plan.id, 1, {
    recordType: "settlement", recordId: plan.id, version: 1,
    relationshipId: plan.relationshipId,
    businessOccurredAt: new Date(now).toISOString(),
    previousVersionCommitment: plan.anchor?.commitment ?? null,
    participants: planMembers(state, plan),
    content: { planId: plan.id, kind: benefit.kind, rewardChoice: plan.rewardChoice },
    attachmentHashes: [], rulesVersion: PLAN_TERMS_VERSION,
  }, now);
}

// 申诉：普通失效等待期或审核争议 → 冻结结算进入例外复核，不冻结退出权。
export function raiseDispute(state: V2State, viewer: string, input: Record<string, unknown>, now: number): void {
  const targetType = String(input.targetType ?? "");
  const targetId = typeof input.targetId === "string" ? input.targetId : null;
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  if (!targetId) throw badRequest("无效申诉目标");
  if (targetType === "plan") {
    const { plan } = findPlan(state, viewer, targetId);
    if (!["forfeit_pending", "approved", "redeemable", "claim_review"].includes(plan.status)) {
      throw conflict("PLAN_STATE", "该计划当前没有可申诉的结算");
    }
    plan.status = "exception_review";
    plan.exceptionOpenedAt ??= now; // v2.5：例外复核起点（用户申诉路径）
    plan.revision += 1;
  } else if (targetType === "trust") {
    const promise = state.promises.find(p => p.id === targetId);
    if (!promise) throw notFound("承诺不存在");
    memberCheck(state, viewer, promise.relationshipId);
  } else {
    throw badRequest("无效申诉类型");
  }
  state.disputes.push({
    id: `dispute-${Math.random().toString(36).slice(2, 10)}`,
    targetType: targetType as "plan" | "trust", targetId, raisedBy: viewer,
    note: note ?? "", createdAt: now, resolvedAt: null, resolution: null, subjectUserId: null,
  });
}

function memberCheck(state: V2State, viewer: string, relationshipId: string): void {
  const rel = state.relationships.find(r => r.id === relationshipId);
  if (!rel || !rel.members.includes(viewer)) throw forbidden("只有关系成员可以申诉");
}

// 例外复核结论：取消退款 / 维持失效 / 返回核验。
// v2.5：返回核验必须存在可继续审核的申请并设置新的审核期限；
// 所有结论递增 revision 并记录例外复核起点；退款/失效路径通知双方。
export function resolveExceptionControlled(
  state: V2State,
  planId: string,
  decision: string,
  now: number,
  options?: { expectedPlanRevision?: number; actor?: string; skipVersionGuard?: boolean },
): void {
  const plan = state.plans.find(p => p.id === planId);
  if (!plan) throw notFound("计划不存在");
  if (plan.status !== "exception_review") throw conflict("PLAN_STATE", "该计划不在例外复核中");
  if (!options?.skipVersionGuard && options?.expectedPlanRevision !== undefined && options.expectedPlanRevision !== plan.revision) {
    throw versionConflict("计划状态已更新，请刷新后重新确认。");
  }
  const members = planMembers(state, plan);
  if (decision === "refund") {
    plan.status = "cancelled";
    plan.endedReason = "exception";
    refundPrincipals(state, plan, now, "exception");
    plan.revision += 1;
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: plan.id,
        title: "例外复核：退回本金",
        body: "例外复核结论为退回双方投入；关系状态不受影响，投入已回到各自账户。",
      }, now);
    }
  } else if (decision === "forfeit") {
    plan.status = "forfeited";
    plan.endedReason = plan.endedReason ?? "normal_end";
    settleForfeit(state, plan, now);
    plan.revision += 1;
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: plan.id,
        title: "例外复核：维持失效",
        body: "例外复核维持按规则失效：投入记入不可流通的演示失效账户，不转给任何人。",
      }, now);
    }
  } else if (decision === "back_to_review") {
    // 必须存在可继续审核的申请，不能造出没有申请的 claim_review（设计 3.3）。
    const claim = state.claims.find(c => c.planId === plan.id && ["submitted", "need_more"].includes(c.status));
    if (!claim) {
      throw new ApiError(422, "MATERIAL_INCOMPLETE", "没有可继续审核的申请，无法返回核验（可走退款或维持失效）");
    }
    plan.status = "claim_review";
    plan.exceptionOpenedAt = null;
    claim.reviewDeadlineAt = now + REVIEW_LIMIT_DAYS * DAY;
    claim.revision += 1;
    plan.revision += 1;
    for (const uid of members) {
      pushNotification(state, {
        userId: uid, kind: "claim_decision", objectId: claim.id,
        title: "已返回核验",
        body: "例外复核结论为返回核验：申请恢复审核，审核期限已重新计算。",
      }, now);
    }
  } else {
    throw badRequest("无效复核结论");
  }
  const dispute = state.disputes.find(d => d.targetId === plan.id && !d.resolvedAt);
  if (dispute) { dispute.resolvedAt = now; dispute.resolution = decision; }
}

// 演示台：例外复核结论 —— 取消退款 或 维持失效 或 返回核验（无版本保护包装）。
export function resolveException(state: V2State, planId: unknown, decision: string, now: number): void {
  if (typeof planId !== "string") throw badRequest("无效计划 ID");
  resolveExceptionControlled(state, planId, decision, now, { skipVersionGuard: true });
}

export { findPlan };
