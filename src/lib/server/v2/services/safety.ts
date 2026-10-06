// 安全与隐私服务（v2.6，依据安全与隐私交付计划书第 4/5 节）。
// 屏蔽与举报彼此独立：屏蔽不自动结束关系；举报不扣履约分；解除屏蔽不恢复旧授权。
// targetRef 由服务器签发并绑定调用者与来源，举报前不揭晓匿名对象身份。
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf, pushNotification, pushPrivacyAudit } from "../../../repositories/demo-repo";
import { ApiError, badRequest, conflict, forbidden, notFound, versionConflict } from "../errors";
import { activeBlocksOf, blockedEitherWay, revokeGrantsBetween } from "../privacy-policy";
import {
  safetyReasons, safetyReasonLabels, safetyReportStatusLabels,
  type SafetyReason, type SafetyReport, type SafetyTargetRef, type UserBlock,
} from "../../../domain/safety-types";

const REF_VALID_DAYS = 7;
const DAY = 86_400_000;
const MAX_NEW_REPORTS_PER_DAY = 5;
const APPEAL_WINDOW_DAYS = 7;
const SUPPLEMENT_WINDOW_DAYS = 7;
import { resolveCandidateRef } from "./discovery";

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function aliasCodeOf(sourceId: string): string {
  // 设计别名（如 7K2）：仅用于未揭晓对象的展示，不承载身份信息。
  let hash = 0;
  for (const ch of sourceId) hash = (hash * 31 + ch.charCodeAt(0)) % 46656;
  return hash.toString(36).toUpperCase().padStart(3, "0");
}

// ---------- targetRef 签发与校验 ----------

// 来源可见性校验：铃声接收者（近 7 天内，含已过期/已忽略）、连接成员、关系成员可以引用对应对象。
// 未通过可见性校验的引用不能用来探测其他用户档案（T23）。
// v2.8（M03 MD-13）：铃声来源核验覆盖接收者最近 7 天的铃声历史，包括 expired/dismissed ——
// 这只扩大救济入口，不扩大回响或读档案权限。
export function targetContext(state: V2State, viewer: string, sourceType: unknown, sourceId: unknown, now: number): {
  sourceLabel: string; targetLabel: string; targetRef: string;
} {
  if (sourceType !== "bell" && sourceType !== "connection" && sourceType !== "relationship" && sourceType !== "candidate") {
    throw badRequest("无效的来源类型");
  }
  if (typeof sourceId !== "string") throw badRequest("无效的来源 ID");
  let targetId: string | null = null;
  let targetLabel = "";
  let sourceLabel = "";
  if (sourceType === "bell") {
    const bell = state.bells.find(b =>
      b.id === sourceId && b.to === viewer && now - b.createdAt <= REF_VALID_DAYS * DAY);
    if (!bell) throw notFound("来源不存在或不可见");
    targetId = bell.from;
    targetLabel = `相遇对象 · ${aliasCodeOf(bell.id)}`; // 未揭晓：仅临时标签
    sourceLabel = "一条铃声（含已过期或已忽略）";
  } else if (sourceType === "candidate") {
    // v2.8（MD-13）：候选卡举报入口 —— 只接受有效候选引用换签，不能提交裸 targetUserId。
    const ref = resolveCandidateRefForSafety(state, viewer, sourceId, now);
    targetId = ref.targetId;
    targetLabel = `相遇对象 · ${aliasCodeOf(ref.token)}`;
    sourceLabel = "一张匿名候选卡";
  } else if (sourceType === "connection") {
    const conn = state.connections.find(c => c.id === sourceId && c.members.includes(viewer));
    if (!conn) throw notFound("来源不存在或不可见");
    targetId = conn.members[0] === viewer ? conn.members[1] : conn.members[0];
    const target = state.users.get(targetId);
    targetLabel = target && !target.disabledAt ? target.profile.nickname : "已注销用户";
    sourceLabel = "一个已回响的连接";
  } else {
    const rel = state.relationships.find(r => r.id === sourceId && r.members.includes(viewer));
    if (!rel) throw notFound("来源不存在或不可见");
    targetId = rel.members[0] === viewer ? rel.members[1] : rel.members[0];
    const target = state.users.get(targetId);
    targetLabel = target && !target.disabledAt ? target.profile.nickname : "已注销用户";
    sourceLabel = "当前绑定关系";
  }
  const existing = state.safetyTargetRefs.find(t =>
    t.actorId === viewer && t.sourceType === sourceType && t.sourceId === sourceId && t.expiresAt > now);
  if (existing) return { sourceLabel, targetLabel: existing.targetLabel, targetRef: existing.ref };
  const ref: SafetyTargetRef = {
    ref: rid("tr"), actorId: viewer, targetId,
    sourceType, sourceId, targetLabel,
    createdAt: now, expiresAt: now + REF_VALID_DAYS * DAY,
  };
  state.safetyTargetRefs.push(ref);
  return { sourceLabel, targetLabel, targetRef: ref.ref };
}

// v2.8（M03 MD-13）：候选卡安全上下文 —— 有效 candidateRef 换取独立 safety targetRef；
// 后者沿用 7 天时效，只用于举报/屏蔽，不能用于摇铃或读档案（服务端不签发反向能力）。
function resolveCandidateRefForSafety(state: V2State, viewer: string, token: string, now: number) {
  const ref = resolveCandidateRef(state, viewer, token, now);
  if (!ref) throw notFound("此候选已不可操作，请刷新后重新选择");
  return ref;
}

export function candidateSafetyContext(state: V2State, viewer: string, candidateRef: unknown, now: number): {
  sourceLabel: string; targetLabel: string; targetRef: string;
} {
  if (typeof candidateRef !== "string" || !candidateRef) throw badRequest("缺少候选引用");
  return targetContext(state, viewer, "candidate", candidateRef, now);
}

function resolveTargetRef(state: V2State, viewer: string, ref: unknown, now: number): SafetyTargetRef {
  if (typeof ref !== "string") throw badRequest("缺少对象引用（targetRef）");
  const found = state.safetyTargetRefs.find(t => t.ref === ref);
  // 伪造/他人/过期引用统一 404，不泄露引用是否存在。
  if (!found || found.actorId !== viewer || found.expiresAt <= now) {
    pushPrivacyAudit(state, { actorId: viewer, actorRole: "user", action: "safety.targetref.rejected", targetType: "target_ref", targetId: "invalid", result: "rejected" });
    throw notFound("当前无法继续此操作。");
  }
  return found;
}

// ---------- 屏蔽 ----------

export function blockTargetDto(block: UserBlock) {
  return {
    id: block.id, targetLabel: block.targetLabel,
    active: block.active, createdAt: block.createdAt,
    revokedAt: block.revokedAt, revision: block.revision,
  };
}

// 原子屏蔽：校验引用 → 写入/复用 active block → 关闭双方连接 → 撤双向授权
// → 取消待响应铃声/邀请 → 记录脱敏审计。active/married 关系不自动结束；计划不自动扣分/没收。
export function blockTarget(state: V2State, viewer: string, targetRef: unknown, now: number) {
  const ref = resolveTargetRef(state, viewer, targetRef, now);
  const target = ref.targetId;
  if (target === viewer) throw badRequest("不能屏蔽自己");
  const existing = state.blocks.find(b => b.ownerId === viewer && b.targetId === target && b.active);
  if (existing) return { block: blockTargetDto(existing), cascade: { alreadyBlocked: true } };

  const label = ref.sourceType === "bell" ? `相遇对象 · ${aliasCodeOf(ref.sourceId)}` : ref.targetLabel;
  const block: UserBlock = {
    id: rid("block"), ownerId: viewer, targetId: target, targetLabel: label,
    active: true, createdAt: now, revokedAt: null, revision: 1,
  };
  state.blocks.push(block);

  const cascade = { connectionsClosed: 0, grantsRevoked: 0, bellsCancelled: 0, invitesCancelled: 0 };
  // 关闭双方现有连接
  for (const conn of state.connections) {
    if (!conn.closed && conn.members.includes(viewer) && conn.members.includes(target)) {
      conn.closed = true; conn.closedAt = now; conn.closedBy = viewer;
      cascade.connectionsClosed += 1;
    }
  }
  // 撤销双向资料授权
  cascade.grantsRevoked = revokeGrantsBetween(state, viewer, target, now, "blocked");
  // 取消待响应铃声（两个方向）
  for (const bell of state.bells) {
    if (bell.status === "pending" && ((bell.from === viewer && bell.to === target) || (bell.from === target && bell.to === viewer))) {
      bell.status = "expired";
      cascade.bellsCancelled += 1;
    }
  }
  // v2.8（M03 MD-13）：屏蔽立即影响候选引用 —— 双方相关引用全部失效；解除屏蔽不复活旧记录。
  state.candidateRefs = state.candidateRefs.filter(ref =>
    !((ref.actorId === viewer && ref.targetId === target) || (ref.actorId === target && ref.targetId === viewer)));
  // 屏蔽双方雷达保持运行（可被其他人发现），只是彼此不可见 —— 由资格函数排除。
  // 取消待响应关系邀请（两个方向；已有 active/married 关系不动）
  for (const rel of state.relationships) {
    if (rel.status === "proposed" && rel.members.includes(viewer) && rel.members.includes(target)) {
      rel.status = "cancelled";
      cascade.invitesCancelled += 1;
    }
  }
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "safety.block",
    targetType: "user_block", targetId: block.id,
  });
  // 不向被屏蔽者发送“某某屏蔽了你”的通知（仅本人留档提醒）。
  pushNotification(state, {
    userId: viewer, kind: "system", objectId: block.id,
    title: "已更新屏蔽设置",
    body: "已停止向对方展示你的资料与新的互动入口。屏蔽不会自动结束当前绑定。",
  }, now);
  return { block: blockTargetDto(block), cascade };
}

// 解除屏蔽：只移除本人的屏蔽记录；不恢复连接、旧授权或已撤回内容；
// 另一方向仍屏蔽时互动保持不可用（不向用户泄露对方是否屏蔽）。
export function unblockTarget(state: V2State, viewer: string, blockId: unknown, expectedRevision: unknown, now: number) {
  if (typeof blockId !== "string") throw badRequest("无效的屏蔽记录 ID");
  const block = state.blocks.find(b => b.id === blockId);
  if (!block || block.ownerId !== viewer || !block.active) throw notFound("屏蔽记录不存在");
  if (expectedRevision !== block.revision) throw versionConflict("这条记录刚刚更新，请重新查看后再操作。");
  block.active = false;
  block.revokedAt = now;
  block.revision += 1;
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "safety.unblock",
    targetType: "user_block", targetId: block.id,
  });
  return { ok: true, note: "已解除屏蔽。此操作不会恢复此前的连接和授权。" };
}

export function listBlocks(state: V2State, viewer: string) {
  return activeBlocksOf(state, viewer).map(blockTargetDto);
}

// ---------- 举报 ----------

export function reportDtoForUser(report: SafetyReport) {
  return {
    id: report.id,
    targetLabel: report.targetLabel, // 脱敏标签，不含对方真实档案
    sourceLabel: report.sourceType === "bell" ? "相遇铃声" : report.sourceType === "candidate" ? "匿名候选卡" : report.sourceType === "connection" ? "已回响连接" : "绑定关系",
    reason: report.reason,
    reasonLabel: safetyReasonLabels[report.reason],
    description: report.description,
    status: report.status,
    statusLabel: safetyReportStatusLabels[report.status],
    revision: report.revision,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    dueAt: report.dueAt,
    supplements: report.supplements.map(s => ({ at: s.at, text: s.text })),
    events: report.events.map(e => ({ at: e.at, label: e.label })),
    userResult: report.userResult,
    appeal: report.appeal ? {
      reason: report.appeal.reason,
      requestedAt: report.appeal.requestedAt,
      decidedAt: report.appeal.decidedAt,
      userMessage: report.appeal.userMessage,
    } : null,
    // 内部意见（internalReason）、被举报者身份、审核员身份都不进入用户 DTO。
  };
}

export function createReport(
  state: V2State, viewer: string,
  input: { targetRef: unknown; reason: unknown; description: unknown; blockTarget: unknown },
  now: number,
) {
  const ref = resolveTargetRef(state, viewer, input.targetRef, now);
  if (!safetyReasons.includes(input.reason as SafetyReason)) throw badRequest("请选择举报原因");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length < 10 || description.length > 1000) throw badRequest("说明需 10–1000 字");
  // 频率限制：同账号 24 小时内新举报最多 5 次；给已有案件补充不受此限制。
  const dayAgo = now - DAY;
  const recent = state.safetyReports.filter(r => r.reporterId === viewer && r.createdAt > dayAgo);
  if (recent.length >= MAX_NEW_REPORTS_PER_DAY) {
    throw new ApiError(429, "TOO_MANY_REQUESTS", "已达到今日新举报上限；你仍可以给已有案件补充材料。", true);
  }
  // 相同来源与原因在未结案时复用工单（幂等）。
  const open = state.safetyReports.find(r =>
    r.reporterId === viewer && r.sourceType === ref.sourceType && r.sourceId === ref.sourceId &&
    r.reason === input.reason && !["resolved", "rejected", "withdrawn"].includes(r.status));
  if (open) {
    return { report: reportDtoForUser(open), reused: true, block: null };
  }
  const report: SafetyReport = {
    id: rid("sr"), reporterId: viewer,
    targetId: ref.targetId, targetLabel: ref.targetLabel,
    sourceType: ref.sourceType, sourceId: ref.sourceId,
    reason: input.reason as SafetyReason, description,
    status: "submitted", revision: 1, assignedTo: null,
    createdAt: now, updatedAt: now,
    dueAt: now + REF_VALID_DAYS * DAY, // 7 天处理窗口
    withdrawnAt: null, supplements: [],
    events: [{ at: now, action: "submitted", label: "已提交举报，等待运营领取" }],
    decisions: [], userResult: null, appeal: null,
  };
  state.safetyReports.push(report);
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "safety.report.create",
    targetType: "safety_report", targetId: report.id,
  });
  // 可选“同时屏蔽此人”（默认不勾选）：举报与屏蔽级联同事务提交；
  // 屏蔽失败（如引用失效）则整体失败，不出现“举报成功但屏蔽失败”的半成功。
  let block: ReturnType<typeof blockTargetDto> | null = null;
  if (input.blockTarget === true) {
    block = blockTarget(state, viewer, input.targetRef, now).block;
  }
  pushNotification(state, {
    userId: viewer, kind: "system", objectId: report.id,
    title: "举报已收到",
    body: `工单号 ${report.id}。举报本身不影响对方履约分；处理结果会在这里通知你。`,
  }, now);
  return { report: reportDtoForUser(report), reused: false, block };
}

function ownReport(state: V2State, viewer: string, reportId: unknown): SafetyReport {
  if (typeof reportId !== "string") throw badRequest("无效的工单 ID");
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report || report.reporterId !== viewer) throw notFound("工单不存在"); // 不区分“不存在/非本人”，防枚举
  return report;
}

export function listReports(state: V2State, viewer: string) {
  return state.safetyReports
    .filter(r => r.reporterId === viewer)
    .sort((x, y) => y.updatedAt - x.updatedAt)
    .map(reportDtoForUser);
}

export function reportDetail(state: V2State, viewer: string, reportId: unknown) {
  return reportDtoForUser(ownReport(state, viewer, reportId));
}

// 补充材料：允许在 submitted/in_review/awaiting_supplement 状态追加（持续骚扰可继续举证）。
export function supplementReport(state: V2State, viewer: string, reportId: unknown, text: unknown, expectedRevision: unknown, now: number) {
  const report = ownReport(state, viewer, reportId);
  if (expectedRevision !== undefined && expectedRevision !== report.revision) throw versionConflict("这条记录刚刚更新，请重新查看后再操作。");
  if (!["submitted", "in_review", "awaiting_supplement"].includes(report.status)) {
    throw conflict("REPORT_STATE", "当前状态不能补充材料");
  }
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length < 5 || trimmed.length > 1000) throw badRequest("补充说明需 5–1000 字");
  report.supplements.push({ at: now, text: trimmed });
  if (report.status === "awaiting_supplement") {
    report.status = "in_review";
    report.dueAt = now + SUPPLEMENT_WINDOW_DAYS * DAY;
    report.events.push({ at: now, action: "supplemented", label: "已按要求补充材料，回到审核" });
  } else {
    report.events.push({ at: now, action: "supplemented", label: "追加了补充说明" });
  }
  report.updatedAt = now;
  report.revision += 1;
  return reportDtoForUser(report);
}

// 撤回：仅 submitted 状态可由本人撤回；已进入审核的请求记入补充记录由审核员处理。
export function withdrawReport(state: V2State, viewer: string, reportId: unknown, expectedRevision: unknown, now: number) {
  const report = ownReport(state, viewer, reportId);
  if (expectedRevision !== report.revision) throw versionConflict("这条记录刚刚更新，请重新查看后再操作。");
  if (report.status === "submitted") {
    report.status = "withdrawn";
    report.withdrawnAt = now;
    report.events.push({ at: now, action: "withdrawn", label: "已撤回举报（必要处理记录保留）" });
    report.updatedAt = now;
    report.revision += 1;
    return reportDtoForUser(report);
  }
  if (["in_review", "awaiting_supplement", "appeal_requested"].includes(report.status)) {
    report.supplements.push({ at: now, text: "（用户请求撤回本工单，请审核员处理）" });
    report.events.push({ at: now, action: "withdraw_requested", label: "撤回请求已转交审核员" });
    report.updatedAt = now;
    report.revision += 1;
    return reportDtoForUser(report);
  }
  throw conflict("REPORT_STATE", "当前状态不能撤回");
}

// 复核申请：结案后 7 天内一次。
export function appealReport(state: V2State, viewer: string, reportId: unknown, reason: unknown, expectedRevision: unknown, now: number) {
  const report = ownReport(state, viewer, reportId);
  if (expectedRevision !== report.revision) throw versionConflict("这条记录刚刚更新，请重新查看后再操作。");
  if (!["resolved", "rejected"].includes(report.status) || !report.userResult) {
    throw conflict("REPORT_STATE", "只有已结案的举报可以申请复核");
  }
  if (report.appeal) throw conflict("APPEAL_EXISTS", "每个工单只能申请一次复核");
  if (now - report.userResult.at > APPEAL_WINDOW_DAYS * DAY) {
    throw conflict("APPEAL_WINDOW", "复核申请窗口（结案后 7 天）已过");
  }
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 5 || trimmed.length > 500) throw badRequest("复核理由需 5–500 字");
  report.appeal = { reason: trimmed, requestedAt: now, decidedAt: null, reviewerId: null, userMessage: null };
  report.status = "appeal_requested";
  report.events.push({ at: now, action: "appeal_requested", label: "已申请复核（由不同审核员处理）" });
  report.updatedAt = now;
  report.revision += 1;
  return reportDtoForUser(report);
}

// ---------- 运营侧（由 ops 路由调用；权限与审计在路由层执行） ----------

export function opsReportsList(state: V2State, filter: { status?: string | null }) {
  let items = [...state.safetyReports].sort((x, y) => y.createdAt - x.createdAt);
  if (filter.status) items = items.filter(r => r.status === filter.status);
  // 队列脱敏：不暴露举报人/被举报者身份，只给工单号、原因、状态与摘要。
  return items.map(r => ({
    id: r.id,
    reason: r.reason, reasonLabel: safetyReasonLabels[r.reason],
    status: r.status, statusLabel: safetyReportStatusLabels[r.status],
    descriptionExcerpt: r.description.slice(0, 40),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    assigned: r.assignedTo !== null,
    hasAppeal: r.appeal !== null && r.appeal.decidedAt === null,
  }));
}

export function opsReportDetail(state: V2State, accountId: string, reportId: string, isSupervisor: boolean) {
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report) throw notFound("工单不存在");
  if (report.assignedTo !== accountId && !isSupervisor) {
    throw forbidden("只有被指派的审核员可以读取案内材料（主管可复核调取）");
  }
  // 敏感材料读取留痕（脱敏：只记工单号）。
  pushPrivacyAudit(state, { actorId: accountId, actorRole: "admin", action: "safety.report.read", targetType: "safety_report", targetId: report.id });
  return {
    ...reportDtoForUser(report),
    internal: {
      assignedTo: report.assignedTo,
      decisions: report.decisions.map(d => ({
        at: d.at, reviewerName: d.reviewerName, decision: d.decision,
        userMessage: d.userMessage, internalReason: d.internalReason,
      })),
    },
  };
}

export function opsAssignReport(state: V2State, accountId: string, reportId: string, now: number) {
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report) throw notFound("工单不存在");
  if (report.assignedTo !== null && report.assignedTo !== accountId) {
    throw conflict("ALREADY_ASSIGNED", "该工单已被其他审核员领取");
  }
  if (report.assignedTo === accountId) return { ok: true, alreadyMine: true };
  if (["withdrawn"].includes(report.status)) throw conflict("REPORT_STATE", "已撤回的工单不能领取");
  report.assignedTo = accountId;
  if (report.status === "submitted") {
    report.status = "in_review";
    report.events.push({ at: now, action: "claimed", label: "运营已领取，处理中" });
  }
  report.updatedAt = now;
  report.revision += 1;
  return { ok: true, alreadyMine: false };
}

export function opsDecideReport(
  state: V2State, principal: { accountId: string; displayName: string },
  reportId: string,
  input: { decision: unknown; userMessage: unknown; internalReason: unknown; expectedRevision: unknown },
  now: number,
) {
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report) throw notFound("工单不存在");
  if (report.assignedTo !== principal.accountId) throw forbidden("未领取或非受理人不能裁定");
  const decision = input.decision;
  if (decision !== "resolved" && decision !== "rejected" && decision !== "need_supplement") {
    throw badRequest("无效的裁定类型");
  }
  const userMessage = typeof input.userMessage === "string" ? input.userMessage.trim() : "";
  if (userMessage.length < 5 || userMessage.length > 200) throw badRequest("用户可见结果需 5–200 字");
  const internalReason = typeof input.internalReason === "string" && input.internalReason.trim()
    ? input.internalReason.trim().slice(0, 500) : null;
  if (decision === "need_supplement" && !internalReason) throw badRequest("要求补充时需填写内部原因");
  if (input.expectedRevision !== report.revision) throw versionConflict("案件刚刚更新（他人可能已处理），请刷新后再操作。");

  report.decisions.push({
    at: now, reviewerId: principal.accountId, reviewerName: principal.displayName,
    decision, userMessage, internalReason,
  });
  if (decision === "need_supplement") {
    report.status = "awaiting_supplement";
    report.dueAt = now + SUPPLEMENT_WINDOW_DAYS * DAY;
    report.events.push({ at: now, action: "need_supplement", label: "需要你补充材料（见站内通知）" });
  } else {
    report.status = decision;
    report.userResult = { at: now, userMessage };
    report.events.push({
      at: now, action: decision,
      label: decision === "resolved" ? "已处理（结论见详情）" : "暂无法处理（结论见详情）",
    });
  }
  report.updatedAt = now;
  report.revision += 1;
  // 用户可见结论推送（只发 userMessage，不含内部意见）。
  pushNotification(state, {
    userId: report.reporterId, kind: "system", objectId: report.id,
    title: decision === "need_supplement" ? "举报需要补充材料" : "举报已有结论",
    body: userMessage,
  }, now);
  return reportDtoForUser(report);
}

// 复核裁定：必须由与原审核员不同的人处理（回避规则）。
export function opsAppealDecide(
  state: V2State, principal: { accountId: string; displayName: string },
  reportId: string,
  input: { decision: unknown; userMessage: unknown; internalReason: unknown },
  now: number,
) {
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report) throw notFound("工单不存在");
  if (!report.appeal || report.appeal.decidedAt !== null) throw conflict("APPEAL_STATE", "没有待处理的复核");
  const originalDecider = report.decisions.length
    ? report.decisions[report.decisions.length - 1].reviewerId : null;
  if (originalDecider === principal.accountId) {
    throw conflict("REVIEWER_CONFLICT", "原审核员不能复核自己的裁定，需改派其他审核员");
  }
  const decision = input.decision;
  if (decision !== "resolved" && decision !== "rejected") throw badRequest("复核裁定只能是 resolved/rejected");
  const userMessage = typeof input.userMessage === "string" ? input.userMessage.trim() : "";
  if (userMessage.length < 5 || userMessage.length > 200) throw badRequest("用户可见结果需 5–200 字");
  const internalReason = typeof input.internalReason === "string" && input.internalReason.trim()
    ? input.internalReason.trim().slice(0, 500) : null;

  report.appeal.decidedAt = now;
  report.appeal.reviewerId = principal.accountId;
  report.appeal.userMessage = userMessage;
  report.status = decision;
  report.userResult = { at: now, userMessage };
  report.decisions.push({
    at: now, reviewerId: principal.accountId, reviewerName: principal.displayName,
    decision: "appeal", userMessage, internalReason,
  });
  report.events.push({ at: now, action: "appeal_decided", label: "复核完成（结论见详情，历史结论保留）" });
  report.updatedAt = now;
  report.revision += 1;
  pushNotification(state, {
    userId: report.reporterId, kind: "system", objectId: report.id,
    title: "举报复核已有结论", body: userMessage,
  }, now);
  return reportDtoForUser(report);
}

// 限时限制：仅新发现/摇铃；不封锁退出、撤权、举报、申诉与既有权益处理。
export function opsRestrictTarget(
  state: V2State, principal: { accountId: string },
  reportId: string, scope: unknown, days: unknown, now: number,
) {
  const report = state.safetyReports.find(r => r.id === reportId);
  if (!report) throw notFound("工单不存在");
  if (scope !== "discovery" && scope !== "ring") throw badRequest("无效的限制范围");
  const dayCount = typeof days === "number" ? Math.floor(days) : 0;
  if (dayCount < 1 || dayCount > 30) throw badRequest("限制时长 1–30 天");
  const restriction = {
    id: rid("restrict"), userId: report.targetId,
    scope: scope as "discovery" | "ring",
    startsAt: now, expiresAt: now + dayCount * DAY,
    reasonCode: "SAFETY_REPORT_RESOLVED", approvedBy: principal.accountId,
    createdAt: now,
  };
  state.restrictions.push(restriction);
  pushPrivacyAudit(state, {
    actorId: principal.accountId, actorRole: "admin", action: "safety.restrict",
    targetType: "account_restriction", targetId: restriction.id,
  });
  return { ok: true, expiresAt: restriction.expiresAt };
}

// 供运营总览：当前屏蔽与举报统计（脱敏）。
export function safetyStats(state: V2State) {
  return {
    activeBlocks: state.blocks.filter(b => b.active).length,
    openReports: state.safetyReports.filter(r => ["submitted", "in_review", "awaiting_supplement", "appeal_requested"].includes(r.status)).length,
    pendingAppeals: state.safetyReports.filter(r => r.appeal && r.appeal.decidedAt === null).length,
    activeRestrictions: state.restrictions.filter(r => r.expiresAt > Date.now()).length,
  };
}

// 导出给 privacy 服务复用的掩码工具。
export { blockedEitherWay };
