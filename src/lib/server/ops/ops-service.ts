// v2.5 维护后台业务服务（设计文档第 2/3/6 节）。
// 与用户端共用同一业务状态与服务函数；查询按最小披露（脱敏 DTO），
// 写操作带 actor、版本保护、双人审批与审计。
import type { V2State } from "../../repositories/demo-repo";
import { balanceOf, postLedger } from "../../repositories/demo-repo";
import { sweepAndNow } from "../v2/registry";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../v2/errors";
import { decideClaimControlled, resolveExceptionControlled } from "../v2/services/plan";
import { retryAnchorJob } from "../v2/services/anchor";
import { resolveTrustDisputeControlled } from "../v2/services/diary";
import type { AdminPrincipal } from "../../domain/admin-types";
import type { ApprovalRequest, CommitmentPlan, FeatureConfigV2, GoalClaim } from "../../domain/v2-types";
import { planStatusLabels } from "../../domain/v2-types";
import { EXCEPTION_LIMIT_DAYS, DAY } from "../../domain/plan-rules";
import { audit } from "./auth";

const DAY_MS = DAY;

// 用户 ID 脱敏（设计 3.4：列表只返回脱敏标识，不带昵称/性取向/联系方式）。
export function maskUser(userId: string): string {
  return `u-${userId.slice(0, 1)}***${userId.length}`;
}

// ---------- 运行总览（设计 3.1） ----------

export function opsOverview(state: V2State) {
  const { now } = sweepAndNow();
  const pendingClaims = state.claims.filter(c => c.status === "submitted");
  const needMoreClaims = state.claims.filter(c => c.status === "need_more");
  const exceptions = state.plans.filter(p => p.status === "exception_review");
  const failedAnchors = state.anchorJobs.filter(j => j.status === "failed" || j.status === "reorged");
  const unconfiguredAnchors = state.anchorJobs.filter(j => j.status === "unconfigured");
  const reservedRose = state.reservations.filter(r => r.status === "reserved" && r.kind === "rose_ticket").reduce((s, r) => s + r.amount, 0);
  const reservedPoints = state.reservations.filter(r => r.status === "reserved" && r.kind === "points").reduce((s, r) => s + r.amount, 0);
  const tasks: { source: string; targetId: string; owner: string; deadlineAt: number | null; impact: string }[] = [];
  for (const claim of [...pendingClaims, ...needMoreClaims]) {
    tasks.push({
      source: claim.status === "need_more" ? "核验补正期" : "待核验申请",
      targetId: claim.id, owner: claim.assignedTo ?? "未领取",
      deadlineAt: claim.reviewDeadlineAt,
      impact: claim.status === "need_more" ? "等待用户补充材料，超期转例外复核" : "超 7 天未处理转例外复核",
    });
  }
  for (const plan of exceptions) {
    const deadline = (plan.exceptionOpenedAt ?? plan.activatedAt ?? now) + EXCEPTION_LIMIT_DAYS * DAY_MS;
    tasks.push({
      source: "例外复核", targetId: plan.id, owner: "复核岗",
      deadlineAt: deadline, impact: "30 天未结论按平台无法履约取消并退回本金",
    });
  }
  for (const job of failedAnchors) {
    tasks.push({ source: "失败存证", targetId: job.id, owner: "运维", deadlineAt: null, impact: "可按 jobId 重试（保留同一承诺与版本）" });
  }
  tasks.sort((a, b) => (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity));
  return {
    metrics: {
      pendingClaims: pendingClaims.length,
      needMoreClaims: needMoreClaims.length,
      exceptionReviews: exceptions.length,
      failedAnchors: failedAnchors.length,
      unconfiguredAnchors: unconfiguredAnchors.length, // 未连接真实链，不计为失败
      availableRose: balanceOf(state, "pool:reward", "rose-ticket") - reservedRose,
      availablePoints: balanceOf(state, "pool:reward", "demo-point") - reservedPoints,
    },
    tasks: tasks.slice(0, 12),
    health: {
      appMode: process.env.APP_MODE === "live" ? "live" : "demo",
      storage: "内存演示仓库（重启清空；Postgres 持久化见设计 M3，未在本轮实现）",
      lastSweepAt: state.lastSweepAt,
      virtualNow: now,
      pendingApprovals: state.approvals.filter(a => a.status === "pending").length,
      configVersion: state.featureConfig.version,
    },
    asOf: now,
    dataOrigin: "与用户端共用同一内存业务状态（/api/v2 与 /api/v2/ops 同源）",
  };
}

// ---------- 核验工作台（设计 3.2） ----------

export interface ClaimRowDto {
  id: string; planId: string; status: string; targetType: string;
  membersMasked: string[]; submittedAt: number; reviewDeadlineAt: number | null;
  assignedTo: string | null; revision: number; latestMaterial: string;
}

function claimRow(state: V2State, claim: GoalClaim): ClaimRowDto {
  const plan = state.plans.find(p => p.id === claim.planId);
  const rel = plan ? state.relationships.find(r => r.id === plan.relationshipId) : null;
  return {
    id: claim.id, planId: claim.planId, status: claim.status,
    targetType: plan?.targetType === "anniversary" ? "周年目标" : "登记结婚（演示核验）",
    membersMasked: rel ? rel.members.filter(m => state.users.get(m)?.kind === "demo").map(maskUser) : [],
    submittedAt: claim.submittedAt, reviewDeadlineAt: claim.reviewDeadlineAt,
    assignedTo: claim.assignedTo, revision: claim.revision,
    latestMaterial: claim.materials[claim.materials.length - 1]?.note ?? claim.evidenceNote,
  };
}

export function opsClaimsList(state: V2State, filter: { status?: string | null; mine?: string | null }) {
  sweepAndNow();
  let claims = [...state.claims];
  if (filter.status && filter.status !== "all") claims = claims.filter(c => c.status === filter.status);
  if (filter.mine) claims = claims.filter(c => c.assignedTo === filter.mine);
  claims.sort((a, b) => (a.reviewDeadlineAt ?? Infinity) - (b.reviewDeadlineAt ?? Infinity));
  return { items: claims.map(c => claimRow(state, c)), total: state.claims.length };
}

export function opsClaimDetail(state: V2State, actor: AdminPrincipal, claimId: string) {
  sweepAndNow();
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim) throw notFound("申请不存在");
  const plan = state.plans.find(p => p.id === claim.planId);
  if (!plan) throw notFound("计划不存在");
  const rel = state.relationships.find(r => r.id === plan.relationshipId);
  const ruleChecks = [
    { item: "目标发生时间在窗口内（冷静期后、到期前）", pass: windowOk(plan, claim.targetOccurredAt) },
    { item: "材料来源：演示材料（非真实证件）", pass: claim.isDemoMaterial === true },
    { item: "条款版本一致", pass: plan.termsVersion === "plan-terms-v1" },
    { item: "申请在途（未终结）", pass: ["submitted", "need_more"].includes(claim.status) },
  ];
  // 读取敏感核验材料也记录审计事件（设计 4 节）。
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: "claims.read",
    targetType: "claim", targetId: claim.id, detail: "查看核验申请详情（材料与规则核对）",
  });
  return {
    ...claimRow(state, claim),
    targetOccurredAt: claim.targetOccurredAt,
    decidedAt: claim.decidedAt, decidedBy: claim.decidedBy, decisionNote: claim.decisionNote,
    reasonCode: claim.reasonCode, lastSupplementAt: claim.lastSupplementAt,
    appealUntil: claim.appealUntil,
    plan: {
      id: plan.id, status: plan.status, statusLabel: planStatusLabels[plan.status],
      revision: plan.revision, rewardChoice: plan.rewardChoice,
      activatedAt: plan.activatedAt, coolingUntil: plan.coolingUntil,
      expiresAt: plan.expiresAt, graceUntil: plan.graceUntil,
      exceptionOpenedAt: plan.exceptionOpenedAt,
    },
    materials: claim.materials,
    reviewEvents: claim.reviewEvents,
    ruleChecks,
  };
}

function windowOk(plan: CommitmentPlan, occurredAt: number): boolean {
  if (!plan.coolingUntil || !plan.expiresAt) return false;
  return occurredAt >= plan.coolingUntil && occurredAt <= plan.expiresAt;
}

export function opsAssignClaim(state: V2State, actor: AdminPrincipal, claimId: string, assigneeId: string): void {
  const { now } = sweepAndNow();
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim) throw notFound("申请不存在");
  if (!["submitted", "need_more"].includes(claim.status)) throw conflict("CLAIM_STATE", "该申请已处理，不能领取");
  claim.assignedTo = assigneeId === "me" ? actor.accountId : assigneeId;
  claim.revision += 1;
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: "claims.assign",
    targetType: "claim", targetId: claim.id, detail: `受理人设为 ${assigneeId === "me" ? actor.displayName : assigneeId}`,
  });
  void now;
}

export function opsDecideClaim(state: V2State, actor: AdminPrincipal, claimId: string, input: Record<string, unknown>): unknown {
  const { now } = sweepAndNow();
  // 未领取、非被指派人禁写（服务端校验，UI 隐藏不算数）。
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim) throw notFound("申请不存在");
  if (claim.assignedTo !== null && claim.assignedTo !== actor.accountId) {
    throw forbidden("该工单已由其他管理员受理，你不能处理");
  }
  const result = decideClaimControlled(state, actor.displayName, claimId, {
    decision: String(input.decision ?? ""),
    reasonCode: input.reasonCode as string | undefined,
    note: input.note as string | undefined,
    expectedClaimRevision: input.expectedClaimRevision as number | undefined,
    expectedPlanRevision: input.expectedPlanRevision as number | undefined,
  }, now);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: `claims.decide:${input.decision}`,
    targetType: "claim", targetId: claimId,
    detail: `原因码 ${input.reasonCode ?? "-"}，说明：${String(input.note ?? "-").slice(0, 120)}`,
  });
  return result;
}

// ---------- 例外与申诉（设计 3.3） ----------

export function opsCases(state: V2State) {
  const { now } = sweepAndNow();
  const exceptions = state.plans.filter(p => p.status === "exception_review").map(plan => {
    const dispute = state.disputes.find(d => d.targetId === plan.id && !d.resolvedAt);
    const escrow = balanceOf(state, `plan:${plan.id}`, "demo-point");
    const reservation = state.reservations.find(r => r.planId === plan.id) ?? null;
    const openedAt = plan.exceptionOpenedAt ?? dispute?.createdAt ?? plan.activatedAt;
    return {
      planId: plan.id, revision: plan.revision, targetType: plan.targetType,
      openedAt, deadlineAt: openedAt !== null ? openedAt + EXCEPTION_LIMIT_DAYS * DAY_MS : null,
      raisedBy: dispute ? maskUser(dispute.raisedBy) : "（审核超期自动转入）",
      note: dispute?.note ?? "审核超期：转入例外复核",
      escrowPoints: escrow,
      reservation: reservation ? { kind: reservation.kind, amount: reservation.amount, status: reservation.status } : null,
      benefitIssued: state.benefits.some(b => b.planId === plan.id && b.status === "settled"),
      membersMasked: (state.relationships.find(r => r.id === plan.relationshipId)?.members ?? []).map(maskUser),
    };
  });
  const trustDisputes = state.disputes.filter(d => d.targetType === "trust" && !d.resolvedAt).map(d => {
    const promise = state.promises.find(p => p.id === d.targetId);
    const subjects = promise
      ? promise.responsibleUserIds.map(uid => ({
        userId: maskUser(uid), raw: uid,
        current: promise.resolutions[uid]?.result ?? "pending",
      }))
      : [];
    return {
      disputeId: d.id, promiseId: d.targetId, raisedBy: maskUser(d.raisedBy), note: d.note,
      createdAt: d.createdAt, promiseContent: promise?.content ?? "（承诺不存在）",
      subjectUserId: d.subjectUserId, subjects,
    };
  });
  return { exceptions, trustDisputes, asOf: now };
}

export function opsRequestExceptionResolution(
  state: V2State, actor: AdminPrincipal, planId: string,
  input: { decision: string; reason: string; expectedPlanRevision?: number },
): { requiresApproval: boolean; approvalId?: string } {
  const { now } = sweepAndNow();
  const plan = state.plans.find(p => p.id === planId);
  if (!plan) throw notFound("计划不存在");
  if (plan.status !== "exception_review") throw conflict("PLAN_STATE", "该计划不在例外复核中");
  if (input.expectedPlanRevision !== undefined && input.expectedPlanRevision !== plan.revision) {
    throw new ApiError(409, "VERSION_CONFLICT", "计划状态已更新，请刷新后重新确认。");
  }
  const reason = input.reason.trim();
  if (reason.length < 4) throw badRequest("请填写复核理由（≥4 字）");
  if (input.decision === "back_to_review") {
    // 返回核验不涉及资金处置，直接执行。
    resolveExceptionControlled(state, planId, "back_to_review", now, { actor: actor.displayName });
    audit({
      actorId: actor.accountId, actorName: actor.displayName, action: "exceptions.back_to_review",
      targetType: "plan", targetId: planId, detail: reason,
    });
    return { requiresApproval: false };
  }
  if (input.decision !== "refund" && input.decision !== "forfeit") throw badRequest("无效复核结论");
  // 退款/维持失效涉及资金处置：双人审批（申请人 ≠ 批准人）。
  const approval: ApprovalRequest = {
    id: `appr-${Math.random().toString(36).slice(2, 10)}`,
    type: "exception_resolution",
    summary: `例外复核：${input.decision === "refund" ? "退回双方本金" : "维持失效"}（计划 ${planId.slice(0, 12)}…）`,
    payloadJson: JSON.stringify({ planId, decision: input.decision, reason, expectedPlanRevision: input.expectedPlanRevision ?? plan.revision }),
    targetId: planId, targetRevision: plan.revision,
    proposerId: actor.accountId, proposerName: actor.displayName,
    status: "pending", createdAt: now, resolvedAt: null,
    approverId: null, approverName: null, rejectReason: null,
  };
  state.approvals.push(approval);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: `exceptions.${input.decision}:request`,
    targetType: "plan", targetId: planId, detail: reason,
  });
  return { requiresApproval: true, approvalId: approval.id };
}

export function opsResolveTrustDispute(
  state: V2State, actor: AdminPrincipal, disputeId: string,
  input: { subjectUserId: string; finalResult: string; reason?: string },
): unknown {
  const { now } = sweepAndNow();
  const result = resolveTrustDisputeControlled(state, actor.displayName, disputeId, input.subjectUserId, input.finalResult, input.reason ?? null, now);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: `trust.resolve:${input.finalResult}`,
    targetType: "dispute", targetId: disputeId, detail: `责任人 ${maskUser(result.subject)}；理由：${input.reason ?? "-"}`,
  });
  return result;
}

// ---------- 双人审批（设计 4/6 节：不得自批；对象版本变动需重提） ----------

export function opsApprovals(state: V2State) {
  sweepAndNow();
  return state.approvals.slice(-50).reverse();
}

export function opsApprove(state: V2State, actor: AdminPrincipal, approvalId: string): unknown {
  const { state: s, now } = sweepAndNow();
  void state;
  const approval = s.approvals.find(a => a.id === approvalId);
  if (!approval) throw notFound("审批请求不存在");
  if (approval.status !== "pending") throw conflict("APPROVAL_STATE", "该审批已处理");
  if (approval.proposerId === actor.accountId) {
    throw new ApiError(409, "SECOND_APPROVER_REQUIRED", "第一申请人不能批准自己的操作，需要另一名有权限的管理员批准");
  }
  // 设计第 4 节权限矩阵：功能/公告发布只有负责人（owner）可批准；
  // 例外退款/失效与库存校正由具备 approvals.approve 的第二人批准。
  if (approval.type === "config_publish" && !actor.roles.includes("owner")) {
    throw forbidden("功能配置发布只能由负责人批准");
  }
  approval.status = "approved";
  approval.resolvedAt = now;
  approval.approverId = actor.accountId;
  approval.approverName = actor.displayName;
  try {
    const outcome = executeApproval(s, approval, actor, now);
    approval.status = "executed";
    audit({
      actorId: actor.accountId, actorName: actor.displayName, action: `approvals.approve:${approval.type}`,
      targetType: "approval", targetId: approval.id, detail: `执行：${approval.summary}`,
    });
    return outcome;
  } catch (error) {
    approval.status = "rejected";
    approval.rejectReason = `执行失败：${error instanceof Error ? error.message : "未知错误"}`;
    audit({
      actorId: actor.accountId, actorName: actor.displayName, action: `approvals.approve:${approval.type}`,
      targetType: "approval", targetId: approval.id, detail: approval.rejectReason, result: "rejected",
    });
    throw error;
  }
}

export function opsRejectApproval(state: V2State, actor: AdminPrincipal, approvalId: string, reason: string): void {
  const { now } = sweepAndNow();
  const approval = state.approvals.find(a => a.id === approvalId);
  if (!approval) throw notFound("审批请求不存在");
  if (approval.status !== "pending") throw conflict("APPROVAL_STATE", "该审批已处理");
  approval.status = "rejected";
  approval.resolvedAt = now;
  approval.approverId = actor.accountId;
  approval.approverName = actor.displayName;
  approval.rejectReason = reason || "未说明";
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: `approvals.reject:${approval.type}`,
    targetType: "approval", targetId: approval.id, detail: `驳回：${approval.rejectReason}`,
  });
}

function executeApproval(state: V2State, approval: ApprovalRequest, actor: AdminPrincipal, now: number): unknown {
  const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>;
  if (approval.type === "exception_resolution") {
    const plan = state.plans.find(p => p.id === payload.planId);
    if (!plan) throw notFound("计划不存在");
    if (plan.revision !== approval.targetRevision) {
      throw new ApiError(409, "VERSION_CONFLICT", "计划在等待批准期间已变化，请重新提交复核请求");
    }
    resolveExceptionControlled(state, String(payload.planId), String(payload.decision), now, { actor: actor.displayName });
    return { planId: payload.planId, decision: payload.decision };
  }
  if (approval.type === "inventory_adjustment") {
    return executeInventoryAdjustment(state, approval, payload, now);
  }
  if (approval.type === "config_publish") {
    const config: FeatureConfigV2 = {
      version: state.featureConfig.version + 1,
      radarNewEnabled: payload.radarNewEnabled === true,
      planNewEnabled: payload.planNewEnabled === true,
      anchorSubmitEnabled: payload.anchorSubmitEnabled === true,
      maintenanceNotice: String(payload.maintenanceNotice ?? "").slice(0, 120),
      updatedBy: actor.displayName,
      updatedAt: now,
    };
    state.featureConfig = config;
    return { configVersion: config.version };
  }
  throw badRequest("未知审批类型");
}

// ---------- 用户与关系（设计 3.4：只读排障，最小披露） ----------

export function opsUsers(state: V2State) {
  sweepAndNow();
  return [...state.users.values()].filter(u => u.kind === "demo").map(user => {
    const radar = state.radar.get(user.id);
    const rel = state.relationships.find(r => r.members.includes(user.id) && ["active", "married"].includes(r.status));
    const plan = state.plans.find(p => rel && p.relationshipId === rel.id && !["settled", "cancelled", "forfeited"].includes(p.status));
    const lastFailedJob = [...state.anchorJobs].reverse().find(j => j.status === "failed");
    return {
      userId: maskUser(user.id),
      adultDeclared: user.adultDeclared, // 自我声明，非真人认证
      accountStatus: "正常（演示）",
      radar: radar?.active ? { active: true, expiresAt: radar.expiresAt } : { active: false, expiresAt: null },
      relationshipStatus: rel ? (rel.status === "married" ? "应用内已婚标记" : "在一起") : "无有效绑定",
      planStatus: plan ? planStatusLabels[plan.status] : "无进行中计划",
      activeGrants: state.shareGrants.filter(g => g.ownerId === user.id && !g.revokedAt).length,
      lastFaultJobId: lastFailedJob?.id ?? null,
    };
  });
}

export function opsRelationships(state: V2State) {
  sweepAndNow();
  return state.relationships.filter(r => !r.id.startsWith("fx-")).map(rel => {
    const plan = state.plans.find(p => p.relationshipId === rel.id);
    return {
      id: rel.id, status: rel.status,
      membersMasked: rel.members.map(maskUser),
      startedAt: rel.startedAt, endedAt: rel.endedAt, marriedAt: rel.marriedAt,
      plan: plan ? { id: plan.id, status: plan.status, statusLabel: planStatusLabels[plan.status] } : null,
      diaryCount: state.diaries.filter(d => d.relationshipId === rel.id).length,
      promiseCount: state.promises.filter(p => p.relationshipId === rel.id).length,
    };
  });
}

// ---------- 奖励与账本（设计 3.5） ----------

function accountLabel(account: string, state: V2State): string {
  if (account.startsWith("user:")) {
    const uid = account.slice(5);
    return state.users.get(uid)?.kind === "demo" ? `演示用户 ${maskUser(uid)}` : "演示前史对象（虚构）";
  }
  if (account === "pool:reward") return "奖励预算池";
  if (account === "pool:forfeit-demo") return "演示失效账户（不可流通）";
  if (account.startsWith("plan:")) return `计划托管 ${account.slice(5, 13)}…`;
  if (account === "system:mint") return "演示系统发放";
  if (account === "system:burn") return "演示系统回收";
  return account;
}

export function opsRewards(state: V2State) {
  sweepAndNow();
  const reservedRose = state.reservations.filter(r => r.status === "reserved" && r.kind === "rose_ticket").reduce((s, r) => s + r.amount, 0);
  const reservedPoints = state.reservations.filter(r => r.status === "reserved" && r.kind === "points").reduce((s, r) => s + r.amount, 0);
  return {
    pools: [
      { unit: "demo-point", label: "演示点数", face: balanceOf(state, "pool:reward", "demo-point"), reserved: reservedPoints, available: balanceOf(state, "pool:reward", "demo-point") - reservedPoints },
      { unit: "rose-ticket", label: "玫瑰演示券（张）", face: balanceOf(state, "pool:reward", "rose-ticket"), reserved: reservedRose, available: balanceOf(state, "pool:reward", "rose-ticket") - reservedRose },
    ],
    reservations: state.reservations.map(r => ({
      id: r.id, planId: r.planId, kind: r.kind, amount: r.amount, status: r.status, createdAt: r.createdAt,
    })),
    ledger: state.ledger.slice(-60).reverse().map(e => ({
      id: e.id, from: accountLabel(e.from, state), to: accountLabel(e.to, state),
      amount: e.amount, unit: e.unit === "rose-ticket" ? "券" : "点",
      type: e.type, businessKey: e.businessKey, note: e.note, createdAt: e.createdAt,
    })),
    fixedRules: "每人投入 100 演示点；A 奖励每人 50 点；B 奖励双方各 1 张 99 朵玫瑰演示券；365 天有效、24h 冷静期、30 天宽限、7 天争议/异议窗口。P0 不提供数值编辑。",
  };
}

export function opsRequestInventoryAdjustment(
  state: V2State, actor: AdminPrincipal,
  input: { unit: string; signedDelta: number; reason: string },
): { approvalId: string } {
  const { now } = sweepAndNow();
  const unit = input.unit === "rose-ticket" ? "rose-ticket" : "demo-point";
  const delta = Math.trunc(input.signedDelta);
  if (delta === 0 || Math.abs(delta) > 10_000) throw badRequest("调整数量无效（非零，绝对值 ≤ 10000）");
  if (!input.reason || input.reason.trim().length < 4) throw badRequest("请填写调整原因（≥4 字，含凭证引用更佳）");
  const approval: ApprovalRequest = {
    id: `appr-${Math.random().toString(36).slice(2, 10)}`,
    type: "inventory_adjustment",
    summary: `库存校正：${unit === "rose-ticket" ? "玫瑰券" : "演示点数"} ${delta > 0 ? "+" : ""}${delta}${unit === "rose-ticket" ? " 张" : " 点"}`,
    payloadJson: JSON.stringify({ unit, signedDelta: delta, reason: input.reason.trim() }),
    targetId: `pool:reward:${unit}`, targetRevision: state.featureConfig.version,
    proposerId: actor.accountId, proposerName: actor.displayName,
    status: "pending", createdAt: now, resolvedAt: null,
    approverId: null, approverName: null, rejectReason: null,
  };
  state.approvals.push(approval);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: "inventory.propose",
    targetType: "pool", targetId: approval.targetId ?? "pool:reward", detail: approval.summary + `；原因：${input.reason.trim()}`,
  });
  return { approvalId: approval.id };
}

function executeInventoryAdjustment(state: V2State, approval: ApprovalRequest, payload: Record<string, unknown>, now: number): unknown {
  const unit = payload.unit === "rose-ticket" ? "rose-ticket" : "demo-point";
  const delta = Number(payload.signedDelta);
  if (delta > 0) {
    postLedger(state, {
      from: "system:mint", to: "pool:reward", amount: delta, unit,
      businessKey: `inventory:${approval.id}`, type: "grant",
      note: `库存校正（演示系统发放账户）：${String(payload.reason ?? "")}`,
    }, now);
  } else {
    const reserved = state.reservations.filter(r => r.status === "reserved" && ((unit === "rose-ticket") === (r.kind === "rose_ticket")))
      .reduce((s, r) => s + r.amount, 0);
    const balance = balanceOf(state, "pool:reward", unit);
    if (balance + delta < reserved) {
      throw conflict("INVENTORY", `减少后可用量将低于已预留量（账面 ${balance}，已预留 ${reserved}）`);
    }
    postLedger(state, {
      from: "pool:reward", to: "system:burn", amount: -delta, unit,
      businessKey: `inventory:${approval.id}`, type: "forfeit",
      note: `库存校正（回收入库）：${String(payload.reason ?? "")}`,
    }, now);
  }
  return { unit, delta };
}

// ---------- 存证任务（设计 3.6） ----------

export function opsAnchors(state: V2State) {
  sweepAndNow();
  return state.anchorJobs.slice(-100).reverse().map(job => ({
    jobId: job.id, recordType: job.recordType, recordId: job.recordId,
    contentVersion: job.contentVersion, chainMode: job.chainMode, status: job.status,
    attempts: job.attempts, commitment: job.commitment,
    txHash: job.txHash, blockNumber: job.blockNumber,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
    // 摘要 DTO 不携带 salt / payloadJson（设计 3.6）
  }));
}

export function opsAnchorRetry(state: V2State, actor: AdminPrincipal, jobId: string): { status: string; attempts: number } {
  const { now } = sweepAndNow();
  const job = retryAnchorJob(state, jobId, now);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: "anchors.retry",
    targetType: "anchor_job", targetId: jobId,
    detail: `按 jobId+版本精确重试（${job.recordType} v${job.contentVersion}，保留同一承诺）→ ${job.status}`,
  });
  return { status: job.status, attempts: job.attempts };
}

// ---------- 运行与审计（设计 3.7） ----------

export function opsSystemHealth(state: V2State) {
  const { now } = sweepAndNow();
  return {
    appMode: process.env.APP_MODE === "live" ? "live" : "demo",
    chainMode: process.env.CHAIN_MODE ?? "preview（默认）",
    chainConfigured: Boolean(process.env.CHAIN_RPC_URL && process.env.NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS),
    writerKeyConfigured: Boolean(process.env.CHAIN_WRITER_PRIVATE_KEY),
    storage: "内存演示仓库（重启清空）",
    lastSweepAt: state.lastSweepAt,
    anchorQueue: {
      failed: state.anchorJobs.filter(j => j.status === "failed").length,
      queued: state.anchorJobs.filter(j => j.status === "queued").length,
      unconfigured: state.anchorJobs.filter(j => j.status === "unconfigured").length,
      confirmed: state.anchorJobs.filter(j => j.status === "confirmed").length,
    },
    featureConfig: {
      version: state.featureConfig.version,
      radarNewEnabled: state.featureConfig.radarNewEnabled,
      planNewEnabled: state.featureConfig.planNewEnabled,
      anchorSubmitEnabled: state.featureConfig.anchorSubmitEnabled,
      maintenanceNotice: state.featureConfig.maintenanceNotice,
      updatedBy: state.featureConfig.updatedBy,
      updatedAt: state.featureConfig.updatedAt,
    },
    virtualNow: now,
    note: "真实链提交为待接入项：preview 模式保留本地承诺指纹，不伪造交易。",
  };
}

export function opsProposeConfig(
  state: V2State, actor: AdminPrincipal,
  input: { radarNewEnabled: boolean; planNewEnabled: boolean; anchorSubmitEnabled: boolean; maintenanceNotice: string; reason: string },
): { approvalId: string } {
  const { now } = sweepAndNow();
  const notice = input.maintenanceNotice.trim().slice(0, 120);
  if (!input.reason || input.reason.trim().length < 4) throw badRequest("请填写发布原因（≥4 字）");
  const approval: ApprovalRequest = {
    id: `appr-${Math.random().toString(36).slice(2, 10)}`,
    type: "config_publish",
    summary: `功能配置 v${state.featureConfig.version + 1}：雷达${input.radarNewEnabled ? "开" : "停"} / 计划${input.planNewEnabled ? "开" : "停"} / 存证${input.anchorSubmitEnabled ? "开" : "停"}${notice ? `；公告「${notice.slice(0, 24)}」` : ""}`,
    payloadJson: JSON.stringify({
      radarNewEnabled: input.radarNewEnabled === true,
      planNewEnabled: input.planNewEnabled === true,
      anchorSubmitEnabled: input.anchorSubmitEnabled === true,
      maintenanceNotice: notice,
    }),
    targetId: "feature-config", targetRevision: state.featureConfig.version,
    proposerId: actor.accountId, proposerName: actor.displayName,
    status: "pending", createdAt: now, resolvedAt: null,
    approverId: null, approverName: null, rejectReason: null,
  };
  state.approvals.push(approval);
  audit({
    actorId: actor.accountId, actorName: actor.displayName, action: "config.propose",
    targetType: "feature_config", targetId: `v${state.featureConfig.version + 1}`,
    detail: `${approval.summary}；原因：${input.reason.trim()}`,
  });
  return { approvalId: approval.id };
}
