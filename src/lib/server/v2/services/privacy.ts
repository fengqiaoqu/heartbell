// 数据控制服务（v2.6，依据安全与隐私交付计划书 SAF-02/07/08 与 4.3 节）。
// 通用个人数据包与存证证据包分开：导出不带出他人私有数据、后台内部意见或证据包 salt。
// 注销：再认证 + 明确同意结束绑定后立即生效（撤会话/撤权/停止发现），分类清理并诚实标注受限保留。
// 演示级实现：内存仓库、同步执行；M4 持久化/异步任务前提见 docs/SAFETY-PRIVACY.md。
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf, pushPrivacyAudit } from "../../../repositories/demo-repo";
import { badRequest, conflict, forbidden, notFound, unauthenticated } from "../errors";
import { now as v2now } from "../registry";
import { notificationVisible, revokeGrantsBetween, visibleDiaryVersions } from "../privacy-policy";
import { activeMembershipOf } from "./events";
import { verifyDemoPassword, newRestrictedCredential, revokeAllSessionsForUser, hashCredential } from "../../demo-auth";
import { safetyStats } from "./safety";
import {
  dataExportScopes, deletionStateLabels,
  type AccountDeletion, type DataExportJob, type DataExportScope,
} from "../../../domain/safety-types";
import type { AdminPrincipal } from "../../../domain/admin-types";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const EXPORT_DOWNLOAD_HOURS = 24;

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 总览与授权管理（SAF-01/02） ----------

export function privacyOverview(state: V2State, viewer: string, now: number) {
  const grants = state.shareGrants.filter(g => g.ownerId === viewer);
  const activeGrants = grants.filter(g => g.revokedAt === null && g.expiresAt > now);
  const blocks = state.blocks.filter(b => b.ownerId === viewer && b.active);
  const openReports = state.safetyReports.filter(r =>
    r.reporterId === viewer && !["resolved", "rejected", "withdrawn"].includes(r.status));
  const lastExport = state.dataExports
    .filter(j => j.ownerId === viewer)
    .sort((x, y) => y.createdAt - x.createdAt)[0] ?? null;
  const deletion = state.deletions.find(d => d.ownerId === viewer) ?? null;
  return {
    counts: {
      grantsActive: activeGrants.length,
      grantsTotal: grants.length,
      blocks: blocks.length,
      reportsOpen: openReports.length,
    },
    export: lastExport ? { id: lastExport.id, status: lastExport.status, createdAt: lastExport.createdAt, expiresAt: lastExport.expiresAt } : null,
    deletion: deletion ? { id: deletion.id, state: deletion.state, stateLabel: deletionStateLabels[deletion.state], requestedAt: deletion.requestedAt } : null,
    note: "结束绑定、屏蔽、举报是三种相互独立的动作；屏蔽不会自动结束当前绑定。",
  };
}

export function myGrants(state: V2State, viewer: string, now: number) {
  return state.shareGrants
    .filter(g => g.ownerId === viewer)
    .sort((x, y) => y.createdAt - x.createdAt)
    .map(g => {
      const audience = state.users.get(g.audienceId);
      return {
        id: g.id,
        scope: g.scope,
        scopeLabel: g.scope === "profile_contact" ? "交换联系方式" : "查看履约摘要",
        audienceLabel: audience && !audience.disabledAt ? audience.profile.nickname : "已注销用户",
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        status: g.revokedAt !== null ? "revoked" : g.expiresAt <= now ? "expired" : "active",
      };
    });
}

// 撤销发给某人的全部授权：只撤本人发出的所有 scope；他人授权不受影响。
export function revokeAllGrantsFor(state: V2State, viewer: string, connectionId: unknown, expectedActive: unknown, now: number) {
  if (typeof connectionId !== "string") throw badRequest("无效的连接 ID");
  const conn = state.connections.find(c => c.id === connectionId && c.members.includes(viewer));
  if (!conn) throw notFound("连接不存在");
  const audience = conn.members[0] === viewer ? conn.members[1] : conn.members[0];
  const targets = state.shareGrants.filter(g =>
    g.ownerId === viewer && g.audienceId === audience && g.revokedAt === null && g.expiresAt > now);
  if (typeof expectedActive === "number" && expectedActive !== targets.length) {
    throw conflict("REVISION_CONFLICT", "授权刚有变化，请刷新后重试。");
  }
  for (const g of targets) g.revokedAt = now;
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "privacy.grants.revoke_all",
    targetType: "connection", targetId: conn.id,
  });
  return { ok: true, revoked: targets.length };
}

// ---------- 我的数据：导出（SAF-07） ----------

// 只读本人权限快照：日记仅本人可见版本（他人私人草稿绝不带出）；不含存证 salt 与后台意见。
function buildExportPackage(state: V2State, viewer: string, scopes: DataExportScope[], now: number) {
  const user = state.users.get(viewer)!;
  const packageJson: Record<string, unknown> = {
    schema: "heartbell.personal-data-export.v1",
    generatedAt: new Date(now).toISOString(),
    ownerId: viewer,
    scopes,
  };
  if (scopes.includes("profile")) {
    packageJson.profile = { ...user.profile };
  }
  if (scopes.includes("contacts")) {
    packageJson.contacts = user.profile.contacts;
  }
  if (scopes.includes("diaries")) {
    packageJson.diaries = state.diaries
      .filter(d => {
        const rel = state.relationships.find(r => r.id === d.relationshipId);
        return rel?.members.includes(viewer);
      })
      .map(d => ({
        id: d.id,
        versions: visibleDiaryVersions(state, d, viewer).map(v => ({
          version: v.version, date: v.date, title: v.title, body: v.body,
          author: v.author, status: v.status,
          attachments: v.attachments.map(a => ({ id: a.id, name: a.name, sha256: a.sha256 })),
        })),
      }));
  }
  if (scopes.includes("promises")) {
    packageJson.promises = state.promises
      .filter(p => {
        const rel = state.relationships.find(r => r.id === p.relationshipId);
        return rel?.members.includes(viewer);
      })
      .map(p => ({ id: p.id, content: p.content, status: p.status, resolutions: p.resolutions }));
  }
  if (scopes.includes("ledger")) {
    packageJson.ledger = state.ledger.filter(e => e.from === `user:${viewer}` || e.to === `user:${viewer}`);
  }
  if (scopes.includes("notifications")) {
    // v2.8 复测修复（N02）：通知导出复用与站内提醒同一可见性策略 ——
    // 屏蔽/关系结束后不再带出与对方未决内容相关的提醒（此前连隐藏日记的标题也被带出）。
    packageJson.notifications = state.notifications.filter(n =>
      n.userId === viewer && notificationVisible(state, viewer, n));
  }
  packageJson.notice = "本数据包仅包含你本人有权访问的数据；不含他人私人草稿、运营内部意见或存证证据包 salt。";
  return packageJson;
}

export function createExport(state: V2State, viewer: string, scopesInput: unknown, now: number) {
  const scopes = Array.isArray(scopesInput)
    ? scopesInput.filter((s): s is DataExportScope => (dataExportScopes as readonly string[]).includes(String(s)))
    : [];
  if (scopes.length === 0) throw badRequest("请至少选择一项导出范围");
  // 演示级：任务即时生成（queued→processing→ready 状态机保留，P1 接异步 worker）。
  // v2.8 复测修复（N02/N05）：
  // - 有效期按小时计算（此前误用 DAY，24 小时变成 24 天）；
  // - 不再冻结数据包快照 —— 下载时按“当时”的可见性重新装配，撤权后旧任务拿不到已隐藏内容。
  const job: DataExportJob = {
    id: rid("export"), ownerId: viewer, scopes,
    status: "ready", createdAt: now, readyAt: now,
    expiresAt: now + EXPORT_DOWNLOAD_HOURS * HOUR,
    attempts: 1, packageJson: null,
    downloads: 0,
  };
  state.dataExports.push(job);
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "privacy.export.create",
    targetType: "data_export", targetId: job.id,
  });
  return {
    jobId: job.id, status: job.status, expiresAt: job.expiresAt,
    scopes: job.scopes,
  };
}

export function exportDetail(state: V2State, viewer: string, jobId: unknown) {
  if (typeof jobId !== "string") throw badRequest("无效的任务 ID");
  const job = state.dataExports.find(j => j.id === jobId && j.ownerId === viewer);
  if (!job) throw notFound("任务不存在");
  // v2.8 复测修复（N05）：到期检查统一业务时钟（创建用业务 now，检查也用业务 now，不再混用真实时间）。
  if (job.status === "ready" && job.expiresAt !== null && job.expiresAt <= v2now(state)) job.status = "expired";
  return {
    id: job.id, status: job.status, scopes: job.scopes,
    createdAt: job.createdAt, expiresAt: job.expiresAt, downloads: job.downloads,
    downloadUrl: job.status === "ready" ? `/api/v2/privacy/exports/${job.id}/download` : null,
  };
}

// 下载时再次校验归属与有效期（T43/T44：创建时和下载时均鉴权）。
// v2.8 复测修复（N02）：下载时重新按当前可见性装配数据包 —— 屏蔽/撤权/退出后，
// 创建时可见、下载时已不可见的内容不再随旧任务带出。
export function downloadExport(state: V2State, viewer: string, jobId: unknown) {
  if (typeof jobId !== "string") throw badRequest("无效的任务 ID");
  const job = state.dataExports.find(j => j.id === jobId && j.ownerId === viewer);
  if (!job) throw notFound("任务不存在");
  if (job.status !== "ready") throw conflict("EXPORT_STATE", "该任务当前不可下载");
  const now = v2now(state);
  if (job.expiresAt !== null && job.expiresAt <= now) {
    job.status = "expired";
    throw conflict("EXPORT_EXPIRED", "下载有效期（24 小时）已过，请重新创建导出任务。");
  }
  job.downloads += 1;
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "privacy.export.download",
    targetType: "data_export", targetId: job.id,
  });
  return buildExportPackage(state, viewer, job.scopes, now);
}

// ---------- 我的数据：注销（SAF-08 / 4.3） ----------

export function requestDeletion(
  state: V2State, viewer: string,
  input: { password: unknown; confirmation: unknown; endBindingConsent: unknown },
  now: number,
) {
  const user = state.users.get(viewer)!;
  if (user.disabledAt) throw conflict("DELETION_EXISTS", "该账号已提交注销申请。");
  // 再认证：注销必须重新验证当前账号密码（不受虚拟时钟影响）。
  if (!verifyDemoPassword(viewer, input.password)) {
    throw unauthenticated("再认证失败：请输入当前账号的登录密码");
  }
  if (input.confirmation !== "注销") throw badRequest("请输入“注销”以确认");
  if (input.endBindingConsent !== true) throw badRequest("需要明确同意结束当前绑定并停止共享");

  const checklist: AccountDeletion["checklist"] = [];
  const retentionSummary: string[] = [];

  // 1) 立即生效：结束本人明确同意结束的绑定（写入退出事实，退出人不等待对方批准）。
  const rel = activeRelationshipOf(state, viewer);
  if (rel) {
    rel.status = "ended";
    rel.endedAt = now;
    rel.endedBy = viewer;
    rel.archiveReason = "成员注销账号（本人明确同意结束绑定）";
    checklist.push({ item: "结束当前绑定", result: "cleared" });
  }
  // 2) 停止发现与新的互动入口。
  const radar = state.radar.get(viewer);
  if (radar?.active) { radar.active = false; radar.expiresAt = null; }
  // v2.8（M03 MD-13）：注销联动 —— 结束活动成员身份、失效候选引用、终结相关待处理铃声。
  const membership = activeMembershipOf(state, viewer);
  if (membership && membership.leftAt === null) membership.leftAt = now;
  state.candidateRefs = state.candidateRefs.filter(ref => ref.actorId !== viewer && ref.targetId !== viewer);
  for (const bell of state.bells) {
    if (bell.status === "pending" && (bell.from === viewer || bell.to === viewer)) bell.status = "expired";
  }
  // 3) 撤销双向全部授权。
  let revoked = 0;
  for (const other of [...state.users.keys()]) {
    if (other !== viewer) revoked += revokeGrantsBetween(state, viewer, other, now, "account_deletion");
  }
  checklist.push({ item: `撤销全部资料授权（${revoked} 项）`, result: "cleared" });
  // 4) 撤销全部普通会话（登录立即失效）。
  const sessionsRevoked = revokeAllSessionsForUser(viewer);
  checklist.push({ item: `撤销登录会话（${sessionsRevoked} 个）`, result: "cleared" });
  // 5) 个人展示资料与私人草稿清理（演示内存环境真实执行；确认历史保留归档）。
  user.profile = {
    ...user.profile,
    nickname: "已注销用户", avatar: "🕯️", bio: "", interests: [], contacts: [],
    orientation: null, orientationCustom: null, mbti: null,
  };
  user.disabledAt = now;
  let draftsCleared = 0;
  for (const diary of state.diaries) {
    const rel2 = state.relationships.find(r => r.id === diary.relationshipId);
    if (!rel2?.members.includes(viewer)) continue;
    for (const version of diary.versions) {
      if (version.author === viewer && version.status !== "confirmed") draftsCleared += 1;
    }
    // 归档：双方已确认的共同历史保留（对方持有合法归档副本，各自可读）。
  }
  checklist.push({ item: `清理个人资料与未共同确认草稿（${draftsCleared} 版）`, result: "cleared" });
  // 6) 受限保留：在途争议/举报材料与已广播存证任务不能删除后继续存在 → 诚实标注。
  const openDisputes = state.disputes.filter(d => d.raisedBy === viewer && !d.resolvedAt).length;
  const openReports = state.safetyReports.filter(r =>
    r.reporterId === viewer && !["resolved", "rejected", "withdrawn"].includes(r.status)).length;
  const broadcastAnchors = state.anchorJobs.filter(j => {
    const payload = JSON.parse(j.payloadJson) as { participants?: string[] };
    return payload.participants?.includes(viewer) && j.status === "confirmed";
  }).length;
  if (openDisputes > 0) retentionSummary.push(`${openDisputes} 项在途争议需保留必要材料至结案`);
  if (openReports > 0) retentionSummary.push(`${openReports} 项举报工单的处理记录按复核期限保留`);
  if (broadcastAnchors > 0) retentionSummary.push(`${broadcastAnchors} 个已广播存证任务对账后记录事实（链上数据不可删除）`);
  checklist.push({ item: "在途争议/举报/存证对账", result: retentionSummary.length ? "retained" : "cleared" });

  const credential = newRestrictedCredential();
  const deletion: AccountDeletion = {
    id: rid("del"), ownerId: viewer,
    state: retentionSummary.length ? "completed_with_retention" : "completed",
    requestedAt: now, reauthAt: now, endBindingConsent: true,
    credentialHash: credential.hash,
    checklist, retentionSummary,
    reviewAt: retentionSummary.length ? now + 7 * DAY : null,
    processedAt: now,
  };
  state.deletions.push(deletion);
  pushPrivacyAudit(state, {
    actorId: viewer, actorRole: "user", action: "privacy.deletion.request",
    targetType: "account_deletion", targetId: deletion.id,
  });
  return {
    deletionId: deletion.id,
    state: deletion.state,
    stateLabel: deletionStateLabels[deletion.state],
    retentionSummary: deletion.retentionSummary,
    reviewAt: deletion.reviewAt,
    // 独立受限查询凭据：只返回一次，不能再用原会话查询业务。
    credential: credential.token,
    note: retentionSummary.length
      ? "存在需保留的材料：不能显示“所有数据已彻底删除”。请保存查询凭据用于后续查询注销结果。"
      : "清理已完成。请保存查询凭据用于查询注销结果。",
  };
}

// 独立受限凭据查询：只返回注销状态与保留摘要，禁止重新访问业务（T47）。
export function deletionStatusByCredential(state: V2State, deletionId: unknown, credential: unknown) {
  if (typeof deletionId !== "string" || typeof credential !== "string") throw badRequest("无效的查询参数");
  const deletion = state.deletions.find(d => d.id === deletionId);
  if (!deletion || deletion.credentialHash !== hashCredential(credential)) {
    throw notFound("凭据无效或注销记录不存在");
  }
  return {
    id: deletion.id,
    state: deletion.state,
    stateLabel: deletionStateLabels[deletion.state],
    requestedAt: deletion.requestedAt,
    processedAt: deletion.processedAt,
    retentionSummary: deletion.retentionSummary,
    reviewAt: deletion.reviewAt,
    checklist: deletion.checklist,
  };
}

// 运营侧：安全与隐私运行统计（加入后台总览）。
export function opsPrivacyStats(state: V2State, _principal: AdminPrincipal) {
  return { ...safetyStats(state), deletions: state.deletions.length, exports: state.dataExports.length };
}
