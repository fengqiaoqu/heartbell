// 视图装配：为轮询端点组装按权限裁剪的状态（隐私规则在服务端执行）。
import type { V2State } from "../../../repositories/demo-repo";
import {
  activeRelationshipOf, balanceOf, currentTrustSnapshot, pendingInviteFor, unreadNotificationsOf,
} from "../../../repositories/demo-repo";
import { intentionLabels, planStatusLabels } from "../../../domain/v2-types";
import { trustReasonLabels } from "../../../domain/score";
import { planRulesSummary } from "../../../domain/plan-rules";
import { now as v2now, runModes, sweep } from "../registry";
import { anchorEvidenceOf } from "./anchor";
import { findActiveGrant } from "./relationship";
import { currentVersion } from "./diary";
import type { KnowConnectionDto, TimelineItemDto, V2StateView } from "../../../domain/view-dtos";
import type { AnchorJob, CommitmentPlan, PromiseDoc } from "../../../domain/v2-types";

const DAY = 86_400_000;

function zhDate(ts: number): string {
  return new Date(ts).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function anchorView(state: V2State, job: AnchorJob | undefined, modes: ReturnType<typeof runModes>) {
  if (!job) return null;
  return anchorEvidenceOf(job, modes.chainMode);
}

function promiseAnchorOf(state: V2State, promise: PromiseDoc, modes: ReturnType<typeof runModes>) {
  // 承诺有生效（v1）与结算（v2/v3）多个存证任务时，展示最新一个。
  const jobs = state.anchorJobs.filter(j => j.recordId === promise.id && j.recordType === "promise");
  const job = jobs.length ? jobs[jobs.length - 1] : undefined;
  return job ? anchorView(state, job, modes) : null;
}

function planAnchorOf(state: V2State, plan: CommitmentPlan, modes: ReturnType<typeof runModes>) {
  const job = state.anchorJobs.find(j => j.recordId === plan.id && (j.recordType === "plan_terms"));
  return job ? anchorView(state, job, modes) : null;
}

export function buildStateView(state: V2State, viewer: string): V2StateView {
  sweep(state);
  const now = v2now(state);
  const modes = runModes();
  const user = state.users.get(viewer)!;
  const partnerCandidates = [...state.users.values()].filter(u => u.id !== viewer && u.kind === "demo");
  const partner = partnerCandidates[0] ?? null;

  // ---------- 相遇 ----------
  const radar = state.radar.get(viewer);
  const myRel = activeRelationshipOf(state, viewer);
  const closedWith = new Set(state.connections.filter(c => c.closed && c.members.includes(viewer)).map(c => c.members[0] === viewer ? c.members[1] : c.members[0]));
  // 雷达互相可见、连接未关闭、双方都没有有效关系（MEET-02/MEET-06）；
  // 最小资料仅含一句话介绍，不含其他长期信息。
  const partnerRadar = partner ? state.radar.get(partner.id) : null;
  const nearbyVisible = (radar?.active && partner && partnerRadar?.active && !closedWith.has(partner.id) && !myRel && !activeRelationshipOf(state, partner.id))
    ? [{ userId: partner.id, traits: partnerRadar!.traits.map(t => ({ category: t.category, value: t.value })), bio: partner.profile.bio }]
    : [];
  const myBells = state.bells.filter(b => b.from === viewer || b.to === viewer);
  const roundStart = radar?.expiresAt ? radar.expiresAt - 600_000 : 0;
  const ringRoundUsed = !!partner && state.bells.some(b => b.from === viewer && b.to === partner.id && b.createdAt >= roundStart);

  // ---------- 了解 ----------
  const connections: KnowConnectionDto[] = state.connections.filter(c => c.members.includes(viewer)).map(conn => {
    const otherId = conn.members[0] === viewer ? conn.members[1] : conn.members[0];
    const other = state.users.get(otherId);
    const echoed = !conn.closed; // 连接本身即已回响
    const contactGrant = findActiveGrant(state, otherId, viewer, "profile_contact", now);
    const trustGrantActive = findActiveGrant(state, otherId, viewer, "trust_summary", now);
    const trustGrantAny = state.shareGrants.find(g => g.ownerId === otherId && g.audienceId === viewer && g.scope === "trust_summary");
    const snapshot = currentTrustSnapshot(state, otherId);
    let trustStatus: "grantable" | "granted" | "revoked" | "expired" = "grantable";
    if (trustGrantActive && snapshot && !snapshot.revokedAt) trustStatus = "granted";
    else if (trustGrantAny?.revokedAt) trustStatus = "revoked";
    else if (trustGrantAny && trustGrantAny.expiresAt <= now) trustStatus = "expired";
    const otherRel = activeRelationshipOf(state, otherId);
    return {
      id: conn.id,
      userId: otherId,
      profile: echoed && other ? {
        nickname: other.profile.nickname, avatar: other.profile.avatar,
        ageWindow: other.profile.ageWindow, orientation: other.profile.orientation,
        orientationCustom: other.profile.orientationCustom,
        mbti: other.profile.mbti,
        interests: other.profile.interests, bio: other.profile.bio,
        intention: other.profile.intention, contacts: [], // 联系方式绝不随档案返回
      } : null,
      intention: echoed ? other?.profile.intention ?? null : null,
      intentionLabel: echoed ? intentionLabels[other?.profile.intention ?? "open"] : null,
      appBindingStatus: otherRel ? (otherRel.status === "married" ? "married" as const : "active" as const) : "none" as const,
      contacts: contactGrant && other ? other.profile.contacts.map(c => ({ label: c.label, value: c.value })) : null,
      trust: {
        status: trustStatus,
        summary: trustStatus === "granted" && snapshot
          ? { ...snapshot, reasonLabel: trustReasonLabels[snapshot.reason] }
          : null,
      },
      closed: conn.closed,
      createdAt: conn.createdAt,
    };
  });

  // ---------- 我们 ----------
  const invite = pendingInviteFor(state, viewer);
  const incomingInvite = invite && invite.proposedBy !== viewer ? invite : null;
  const outgoingInvite = invite && invite.proposedBy === viewer ? invite : null;
  const nicknameOf: Record<string, string | undefined> = {};
  for (const u of state.users.values()) if (u.kind === "demo") nicknameOf[u.id] = u.profile.nickname;
  nicknameOf["system"] = "系统";
  nicknameOf["demo-admin"] = "演示审核台";

  const relDiaries = myRel ? state.diaries.filter(d => d.relationshipId === myRel.id) : [];
  const timeline: TimelineItemDto[] = relDiaries
    .filter(d => {
      const v = currentVersion(d);
      return v.visibility !== "draft" || v.author === viewer; // 私人草稿仅作者可见
    })
    .map(d => {
      const v = currentVersion(d);
      const needsMe = v.status === "awaiting" && !v.confirmations[viewer];
      const confirmCount = Object.keys(v.confirmations).length;
      return {
        id: d.id,
        type: (v.kind === "milestone" ? (v.author === "system" ? "auto-milestone" : "milestone") : "diary") as TimelineItemDto["type"],
        title: v.title,
        subtitle: v.body.length > 40 ? v.body.slice(0, 40) + "…" : v.body,
        dateLabel: v.date,
        sortAt: Date.parse(`${v.date}T12:00:00Z`) || v.createdAt,
        statusText: v.status === "confirmed" ? "双方已确认" : v.status === "awaiting" ? (needsMe ? "待你确认" : "待对方确认") : v.status === "returned" ? "已退回" : v.status === "withdrawn" ? "已撤回" : "私人草稿",
        needsMyAction: needsMe,
        anchor: anchorView(state, state.anchorJobs.find(j => j.recordId === d.id), modes),
        confirmSummary: `${confirmCount}/2 已确认${d.versions.length > 1 ? ` · 版本 ${v.version}` : ""}`,
      };
    });
  const relPromises = myRel ? state.promises.filter(p => p.relationshipId === myRel.id && p.status !== "returned") : [];
  for (const promise of relPromises) {
    const needsMe = promise.status === "proposed" && !promise.confirmations[viewer];
    timeline.push({
      id: promise.id, type: "promise" as const,
      title: promise.content,
      subtitle: `${promise.scoringOptIn ? "计入履约参考" : "浪漫约定（不计分）"} · 责任人：${promise.responsibleUserIds.length > 1 ? "双方" : nicknameOf[promise.responsibleUserIds[0]] ?? "对方"}`,
      dateLabel: `截止 ${new Date(promise.dueAt).toLocaleDateString("zh-CN")}`,
      sortAt: promise.createdAt,
      statusText: promise.status === "proposed" ? (needsMe ? "待你确认承诺" : "待对方确认") : resolutionStatusText(promise),
      needsMyAction: needsMe || hasResolutionToConfirm(promise, viewer),
      anchor: promiseAnchorOf(state, promise, modes),
      confirmSummary: `${Object.keys(promise.confirmations).length}/2 已确认`,
    });
  }
  timeline.sort((a, b) => b.sortAt - a.sortAt);

  const daysTogether = myRel?.startedAt ? Math.floor((now - myRel.startedAt) / DAY) + 1 : null;
  const nextAnniversaryInDays = myRel?.startedAt
    ? (() => {
      const start = new Date(myRel.startedAt);
      const nowDate = new Date(now);
      let anniversaries = new Date(start); anniversaries.setFullYear(nowDate.getFullYear());
      if (anniversaries.getTime() < nowDate.getTime()) anniversaries.setFullYear(nowDate.getFullYear() + 1);
      return Math.ceil((anniversaries.getTime() - nowDate.getTime()) / DAY);
    })() : null;

  const archives = state.relationships
    .filter(r => r.members.includes(viewer) && r.status === "ended")
    .map(r => ({
      id: r.id, endedAt: r.endedAt,
      partnerLabel: r.id.startsWith("fx-") ? "演示前史对象（虚构）" : "已结束的关系",
      timelineCount: state.diaries.filter(d => d.relationshipId === r.id).length,
    }));

  const scoringPromises = myRel ? state.promises.filter(p => p.relationshipId === myRel.id && p.scoringOptIn && p.status === "active") : [];
  const todayKey = new Date(now).toISOString().slice(0, 10);

  // ---------- 相守 ----------
  const myPlans = state.plans.filter(p => {
    const rel = state.relationships.find(r => r.id === p.relationshipId);
    return rel?.members.includes(viewer);
  });
  const currentPlan = myPlans.find(p => !["cancelled", "forfeited", "settled"].includes(p.status)) ?? myPlans[myPlans.length - 1] ?? null;
  const planClaims = currentPlan ? state.claims.filter(c => c.planId === currentPlan.id) : [];
  const planClaim = planClaims.find(c => ["submitted", "need_more", "approved"].includes(c.status)) ?? planClaims[planClaims.length - 1] ?? null;
  const planBenefit = currentPlan ? state.benefits.find(b => b.planId === currentPlan.id) ?? null : null;

  return {
    modes: { ...modes, virtualNow: now, realNow: Date.now() },
    // v2.5：后台功能配置与公告（app-shell 顶部横幅；服务端同步执行限制）。
    publicMaintenance: {
      notice: state.featureConfig.maintenanceNotice,
      radarNewEnabled: state.featureConfig.radarNewEnabled,
      planNewEnabled: state.featureConfig.planNewEnabled,
      anchorSubmitEnabled: state.featureConfig.anchorSubmitEnabled,
      configVersion: state.featureConfig.version,
    },
    notifications: unreadNotificationsOf(state, viewer).slice(-30).reverse(),
    me: {
      id: viewer,
      profile: user.profile,
      adultDeclared: user.adultDeclared,
      verificationLevels: user.verificationLevels,
      balance: balanceOf(state, `user:${viewer}`, "demo-point"),
      roseTickets: balanceOf(state, `user:${viewer}`, "rose-ticket"),
      grantsIssued: state.shareGrants.filter(g => g.ownerId === viewer).map(g => {
        const other = state.users.get(g.audienceId);
        return {
          ...g,
          audienceLabel: other?.profile.nickname ?? g.audienceId,
          scopeLabel: g.scope === "profile_contact" ? "交换联系方式" : "查看履约摘要",
          active: !g.revokedAt && g.expiresAt > now,
        };
      }),
      ledger: state.ledger.filter(e => e.from === `user:${viewer}` || e.to === `user:${viewer}`).slice(-30).reverse(),
    },
    meet: {
      radarActive: !!radar?.active,
      radarExpiresAt: radar?.expiresAt ?? null,
      myTraits: radar?.traits.map(t => ({ category: t.category, value: t.value })) ?? [],
      zoneLabel: "武汉 · 演示街区（模拟位置，非真实距离）",
      blockedByRelationship: !!myRel,
      nearby: nearbyVisible.map(n => ({ userId: n.userId, traits: n.traits.map(t => ({ category: String(t.category), value: t.value })), bio: n.bio })),
      bells: myBells.map(b => ({
        id: b.id,
        from: b.status === "pending" && b.to === viewer ? "匿名铃铛" : b.from,
        to: b.to, message: b.message, status: b.status, createdAt: b.createdAt,
        anonymous: b.status === "pending",
      })),
      ringRoundUsed,
      waitingEcho: myBells.some(b => b.from === viewer && b.status === "pending"),
    },
    know: {
      connections,
      hasAnyEcho: state.connections.some(c => c.members.includes(viewer)),
    },
    us: {
      relationship: myRel ? {
        id: myRel.id, status: myRel.status, members: [...myRel.members], nicknameOf,
        proposedBy: myRel.proposedBy, inviteExpiresAt: myRel.inviteExpiresAt,
        startedAt: myRel.startedAt, endedAt: myRel.endedAt, marriedAt: myRel.marriedAt,
        termsVersion: myRel.termsVersion, spaceSettings: myRel.spaceSettings,
      } : null,
      incomingInvite: incomingInvite ? {
        id: incomingInvite.id, status: incomingInvite.status, members: [...incomingInvite.members], nicknameOf,
        proposedBy: incomingInvite.proposedBy, inviteExpiresAt: incomingInvite.inviteExpiresAt,
        startedAt: null, endedAt: null, marriedAt: null, termsVersion: incomingInvite.termsVersion,
        spaceSettings: incomingInvite.spaceSettings,
      } : null,
      outgoingInvite: outgoingInvite ? {
        id: outgoingInvite.id, status: outgoingInvite.status, members: [...outgoingInvite.members], nicknameOf,
        proposedBy: outgoingInvite.proposedBy, inviteExpiresAt: outgoingInvite.inviteExpiresAt,
        startedAt: null, endedAt: null, marriedAt: null, termsVersion: outgoingInvite.termsVersion,
        spaceSettings: outgoingInvite.spaceSettings,
      } : null,
      daysTogether,
      nextAnniversaryInDays,
      timeline,
      promises: relPromises.map(p => ({
        id: p.id, content: p.content, responsibleUserIds: p.responsibleUserIds,
        dueAt: p.dueAt, criteria: p.criteria, scoringOptIn: p.scoringOptIn,
        attachments: p.attachments ?? [],
        status: p.status, revision: p.revision, confirmations: p.confirmations, resolutions: p.resolutions,
        anchor: promiseAnchorOf(state, p, modes),
      })),
      archives,
      scoringUsage: {
        used: scoringPromises.length, max: 10,
        todayNew: scoringPromises.filter(p => new Date(p.createdAt).toISOString().slice(0, 10) === todayKey).length,
      },
    },
    future: {
      plan: currentPlan ? {
        ...currentPlan,
        members: (() => { const rel = state.relationships.find(r => r.id === currentPlan.relationshipId); return rel ? [...rel.members] : []; })(),
        nicknameOf,
        claim: planClaim,
        benefit: planBenefit,
        investedTotal: currentPlan.activatedAt ? currentPlan.investPerUser * 2 : 0,
        anchor: planAnchorOf(state, currentPlan, modes),
        statusLabel: planStatusLabels[currentPlan.status],
      } : null,
      eligible: !!myRel,
      blockingReason: myRel ? null : "相守计划需要双方先建立关系",
      rules: planRulesSummary,
      myBalance: balanceOf(state, `user:${viewer}`, "demo-point"),
      rewardPoolBalance: balanceOf(state, "pool:reward", "demo-point"),
      roseStock: balanceOf(state, "pool:reward", "rose-ticket"),
    },
  };
}

function resolutionStatusText(promise: PromiseDoc): string {
  const entries = promise.responsibleUserIds.map(uid => promise.resolutions[uid]);
  const results = entries.map(r => r?.result ?? "pending");
  if (results.includes("disputed")) return "申诉处理中";
  if (results.length > 0 && results.every(r => r === "fulfilled")) return "已完成";
  if (results.every(r => ["fulfilled", "unfulfilled", "waived"].includes(r))) {
    return results.includes("unfulfilled") ? "已结算（含未完成）" : "已结算";
  }
  // v2.2 修复：只有“仍存在已提交证据但未经对方确认”的责任项，才提示待确认履约证据；
  // 证据确认后不再残留旧提示（此前确认完仍显示“待确认履约证据”）。
  if (entries.some(r => r?.result === "pending" && (r.confirmedBy?.length ?? 0) > 0)) return "待确认履约证据";
  return results.some(r => r !== "pending") ? "部分已完成" : "进行中";
}

function hasResolutionToConfirm(promise: PromiseDoc, viewer: string): boolean {
  return promise.responsibleUserIds.some(uid => {
    const r = promise.resolutions[uid];
    return uid !== viewer && r?.result === "pending" && (r.confirmedBy?.length ?? 0) > 0 && !r.settledAt;
  });
}
