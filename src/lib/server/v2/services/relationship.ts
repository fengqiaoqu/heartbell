// 关系与授权服务（计划书 2.3/2.4/第 5 节）。
import type { V2State, } from "../../../repositories/demo-repo";
import {
  activeRelationshipOf, pendingInviteFor,
} from "../../../repositories/demo-repo";
import { badRequest, conflict, forbidden, notFound, versionConflict } from "../errors";
import { RELATIONSHIP_INVITE_HOURS, RELATIONSHIP_TERMS_VERSION, isActiveBinding } from "../../../domain/relationship";
import { ageCohorts, spaceThemeLabels, type ShareScope, type SpaceSettings, type SpaceTheme, type V2Relationship } from "../../../domain/v2-types";
import { defaultAvatarIds, MAX_UPLOAD_AVATAR_LENGTH } from "../../../domain/avatars";
import { HOUR } from "../../../domain/relationship";
import { enqueueAnchor } from "./anchor";
import { assertPairCanInteract, revokeGrantsBetween } from "../privacy-policy";

function connectionOf(state: V2State, viewer: string): { id: string; members: [string, string] } | null {
  return state.connections.find(c => c.members.includes(viewer) && !c.closed) ?? null;
}

// 建立关系邀请：需要已回响连接、双方当前无有效绑定、无其他待处理邀请。
export function proposeRelationship(state: V2State, viewer: string, now: number): V2Relationship {
  const conn = connectionOf(state, viewer);
  if (!conn) throw forbidden("需要先互相回响，才能邀请建立关系");
  const partner = conn.members[0] === viewer ? conn.members[1] : conn.members[0];
  assertPairCanInteract(state, viewer, partner); // v2.6：屏蔽期间拒绝新邀请
  if (activeRelationshipOf(state, viewer)) throw conflict("ALREADY_BOUND", "你已有进行中的关系绑定");
  if (activeRelationshipOf(state, partner)) throw conflict("ALREADY_BOUND", "对方已有进行中的关系绑定");
  if (pendingInviteFor(state, viewer) || pendingInviteFor(state, partner)) {
    throw conflict("INVITE_PENDING", "已有一份待处理的关系邀请");
  }
  const rel: V2Relationship = {
    id: `rel-${Math.random().toString(36).slice(2, 10)}`,
    members: [viewer, partner], status: "proposed", proposedBy: viewer,
    consents: { [viewer]: true, [partner]: false },
    proposedAt: now, inviteExpiresAt: now + RELATIONSHIP_INVITE_HOURS * HOUR,
    startedAt: null, endedAt: null, endedBy: null, marriedAt: null,
    termsVersion: RELATIONSHIP_TERMS_VERSION, archiveReason: null,
    spaceSettings: { name: "我们的空间", theme: "peach", showDays: true },
  };
  state.relationships.push(rel);
  return rel;
}

// 接受邀请：服务端在同一逻辑事务内锁定双方绑定（同时接受两份只能成功一份）。
export function acceptRelationship(state: V2State, viewer: string, relId: unknown, now: number): void {
  const rel = findMemberRelationship(state, viewer, relId);
  if (rel.status !== "proposed") throw conflict("INVITE_NOT_PENDING", "邀请已处理或已过期");
  if (rel.proposedBy === viewer) throw badRequest("不能自己确认自己的邀请");
  if (now > rel.inviteExpiresAt) { rel.status = "expired"; throw conflict("INVITE_EXPIRED", "邀请已过期"); }
  if (activeRelationshipOf(state, viewer)) throw conflict("ALREADY_BOUND", "你已有进行中的关系绑定");
  const partner = rel.members[0] === viewer ? rel.members[1] : rel.members[0];
  if (activeRelationshipOf(state, partner)) throw conflict("ALREADY_BOUND", "对方已在这段时间建立了新的关系");
  rel.consents[viewer] = true;
  rel.status = "active";
  rel.startedAt = now;
  // 建立事件生成存证任务（每段关系独立档案；链上只写承诺）。
  enqueueAnchor(state, "relationship_started", rel.id, 1, {
    recordType: "relationship_started", recordId: rel.id, version: 1,
    relationshipId: rel.id,
    businessOccurredAt: new Date(now).toISOString(),
    previousVersionCommitment: null,
    participants: [...rel.members],
    content: { startedAt: new Date(now).toISOString(), termsVersion: rel.termsVersion },
    attachmentHashes: [], rulesVersion: RELATIONSHIP_TERMS_VERSION,
  }, now);
  // 建立即生成系统纪念节点（私密，不存证）。
  state.diaries.push({
    id: `diary-${Math.random().toString(36).slice(2, 10)}`,
    relationshipId: rel.id, createdAt: now,
    versions: [{
      version: 1, kind: "milestone", date: new Date(now).toISOString().slice(0, 10),
      title: "关系第一天", body: "我们决定在一起了。", attachments: [],
      author: "system", createdAt: now, visibility: "shared", status: "confirmed",
      confirmations: { [rel.members[0]]: { at: now }, [rel.members[1]]: { at: now } },
      returnedBy: null, returnedNote: null,
    }],
    anchor: null, anchoredVersion: null,
  });
}

export function declineRelationship(state: V2State, viewer: string, relId: unknown): void {
  const rel = findMemberRelationship(state, viewer, relId);
  if (rel.status !== "proposed") throw conflict("INVITE_NOT_PENDING", "邀请已处理或已过期");
  rel.status = "declined";
}

export function cancelRelationship(state: V2State, viewer: string, relId: unknown): void {
  const rel = findMemberRelationship(state, viewer, relId);
  if (rel.status !== "proposed") throw conflict("INVITE_NOT_PENDING", "邀请已处理或已过期");
  rel.status = "cancelled";
}

// 结束绑定：本人单方确认即可；不等待对方同意、链上确认或计划结算。
export function endRelationship(state: V2State, viewer: string, relId: unknown, reason: unknown, now: number): void {
  const rel = findMemberRelationship(state, viewer, relId);
  if (!isActiveBinding(rel)) throw conflict("NOT_ACTIVE", "当前没有可结束的绑定");
  rel.status = "ended";
  rel.endedAt = now;
  rel.endedBy = viewer;
  rel.archiveReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 100) : null;
  // v2.6：结束绑定同时撤销双方全部资料授权（退出无需对方批准，旧授权立即失效）。
  revokeGrantsBetween(state, rel.members[0], rel.members[1], now, "relationship_ended");
  // 结束事件：退出成员本人授权，单方事实，不伪造另一方同意。
  enqueueAnchor(state, "relationship_ended", rel.id, 1, {
    recordType: "relationship_ended", recordId: rel.id, version: 1,
    relationshipId: rel.id,
    businessOccurredAt: new Date(now).toISOString(),
    previousVersionCommitment: null,
    participants: [viewer], // 退出成员本人授权
    content: { endedAt: new Date(now).toISOString(), endedBy: viewer, reason: rel.archiveReason },
    attachmentHashes: [], rulesVersion: RELATIONSHIP_TERMS_VERSION,
  }, now);
  // 立即停止共享写入：待确认版本冻结为 returned/withdrawn 不再可确认。
  for (const diary of state.diaries) {
    if (diary.relationshipId !== rel.id) continue;
    for (const version of diary.versions) {
      if (version.status === "awaiting") version.status = "withdrawn";
    }
  }
  for (const promise of state.promises) {
    if (promise.relationshipId === rel.id && promise.status === "proposed") promise.status = "returned";
  }
  // 计划独立处理：审核中/待失效的进入例外复核，不阻塞关系结束。
  for (const plan of state.plans) {
    if (plan.relationshipId !== rel.id) continue;
    if (["active", "claim_review", "approved", "redeemable"].includes(plan.status)) {
      if (["claim_review", "approved", "redeemable"].includes(plan.status)) {
        plan.status = "exception_review"; // 在途申请：比较目标时间、退出时间与条款后复核
        plan.exceptionOpenedAt ??= now;   // v2.5：例外复核起点（关系结束路径）
        plan.revision += 1;
      } else {
        plan.status = "forfeit_pending";
        plan.forfeitWindowUntil = now + 7 * 24 * HOUR;
        plan.endedReason = "normal_end";
        plan.revision += 1;
      }
    }
  }
}

function findMemberRelationship(state: V2State, viewer: string, relId: unknown): V2Relationship {
  if (typeof relId !== "string") throw badRequest("无效的关系 ID");
  const rel = state.relationships.find(r => r.id === relId && r.members.includes(viewer));
  if (!rel) throw notFound("关系不存在");
  return rel;
}

// ---------- 空间自定义（v2.2） ----------
// 仅开放外观与展示项：空间名称 / 主题 / 天数展示。任一成员可改，双方同步可见；
// 计分规则、存证条款版本、对方资料与履约记录不开放自定义（公平性与合规边界）。
export function updateSpaceSettings(state: V2State, viewer: string, relationshipId: unknown, patch: Record<string, unknown>): SpaceSettings {
  const rel = findMemberRelationship(state, viewer, relationshipId);
  if (!["active", "married"].includes(rel.status) && rel.status !== "proposed") {
    throw conflict("SPACE_STATE", "关系已结束，空间设置不可修改");
  }
  const next: SpaceSettings = { ...rel.spaceSettings };
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 16);
    next.name = name || "我们的空间";
  }
  if (patch.theme !== undefined) {
    if (typeof patch.theme !== "string" || !(patch.theme in spaceThemeLabels)) throw badRequest("无效的空间主题");
    next.theme = patch.theme as SpaceTheme;
  }
  if (patch.showDays !== undefined) next.showDays = patch.showDays === true;
  rel.spaceSettings = next;
  return next;
}

// ---------- 独立授权（不是总开关） ----------

const shareHours = 72;

export function createShareGrant(state: V2State, viewer: string, scope: unknown, now: number): string {
  const validScopes: ShareScope[] = ["profile_contact", "trust_summary"];
  if (!validScopes.includes(scope as ShareScope)) throw badRequest("未知授权范围");
  const conn = state.connections.find(c => c.members.includes(viewer) && !c.closed);
  if (!conn) throw forbidden("授权对象必须是已回响的连接");
  const audience = conn.members[0] === viewer ? conn.members[1] : conn.members[0];
  // v2.6：被屏蔽或对方已注销时拒绝新授权（掩护性错误，不泄露具体状态）。
  assertPairCanInteract(state, viewer, audience);
  if (state.users.get(audience)?.disabledAt) throw forbidden("当前无法继续此操作。");
  // 重复授权返回原凭证（幂等），刷新有效期
  const existing = state.shareGrants.find(g =>
    g.ownerId === viewer && g.audienceId === audience && g.scope === scope && !g.revokedAt);
  if (existing && existing.expiresAt > now) return existing.id;
  if (existing) { existing.expiresAt = now + shareHours * HOUR; existing.createdAt = now; return existing.id; }
  const grant = {
    id: `grant-${Math.random().toString(36).slice(2, 10)}`,
    ownerId: viewer, audienceId: audience, scope: scope as ShareScope,
    createdAt: now, expiresAt: now + shareHours * HOUR, revokedAt: null,
  };
  state.shareGrants.push(grant);
  return grant.id;
}

export function revokeShareGrant(state: V2State, viewer: string, grantId: unknown, now: number): void {
  const grant = state.shareGrants.find(g => g.id === grantId && g.ownerId === viewer);
  if (!grant) throw notFound("授权不存在");
  grant.revokedAt = now; // 立即撤销后续读取
}

// 受众读取时校验：受众匹配连接、未过期、未撤销。
export function findActiveGrant(state: V2State, ownerId: string, audienceId: string, scope: ShareScope, now: number) {
  return state.shareGrants.find(g =>
    g.ownerId === ownerId && g.audienceId === audienceId && g.scope === scope &&
    g.revokedAt === null && g.expiresAt > now) ?? null;
}

export function declareAdult(state: V2State, viewer: string): void {
  state.users.get(viewer)!.adultDeclared = true;
}

export function updateMyProfile(state: V2State, viewer: string, patch: Record<string, unknown>): void {
  const user = state.users.get(viewer)!;
  const p = user.profile;
  if (patch.intention !== undefined) {
    if (!["serious", "open", "not_now"].includes(String(patch.intention))) throw badRequest("无效交往意向");
    p.intention = patch.intention as "serious" | "open" | "not_now";
  }
  if (patch.avatar !== undefined) {
    const avatar = typeof patch.avatar === "string" ? patch.avatar.trim() : "";
    if (avatar.startsWith("def:")) {
      if (!defaultAvatarIds.includes(avatar)) throw badRequest("无效的官方头像");
    } else if (avatar.startsWith("data:image/")) {
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) throw badRequest("头像仅支持 PNG/JPEG/WebP 图片");
      if (avatar.length > MAX_UPLOAD_AVATAR_LENGTH) throw badRequest("上传头像过大，请重新选择图片");
    } else if (avatar.length < 1 || avatar.length > 8) {
      throw badRequest("头像不能为空");
    }
    p.avatar = avatar;
  }
  if (patch.nickname !== undefined) {
    const nickname = String(patch.nickname).trim();
    if (nickname.length < 1 || nickname.length > 16) throw badRequest("称呼 1–16 字");
    p.nickname = nickname;
  }
  if (patch.ageWindow !== undefined) {
    const w = String(patch.ageWindow).trim();
    if (w !== "" && !(ageCohorts as readonly string[]).includes(w)) {
      throw badRequest("出生年代请从选项中选择（如 95后 / 00后）");
    }
    p.ageWindow = w;
  }
  if (patch.orientation !== undefined) {
    if (patch.orientation === null || patch.orientation === "") { p.orientation = null; p.orientationCustom = null; }
    else if (!["women", "men", "everyone", "other", "not_say"].includes(String(patch.orientation))) throw badRequest("无效性取向选项");
    else {
      p.orientation = patch.orientation as typeof p.orientation;
      if (p.orientation !== "other") p.orientationCustom = null;
    }
  }
  if (patch.orientationCustom !== undefined) {
    if (p.orientation !== "other" && patch.orientationCustom) throw badRequest("只有选择“其他”时才能自由填写说明");
    const custom = patch.orientationCustom === null || patch.orientationCustom === "" ? null : String(patch.orientationCustom).trim().slice(0, 12);
    p.orientationCustom = custom;
  }
  if (patch.mbti !== undefined) {
    const m = patch.mbti === null || patch.mbti === "" ? null : String(patch.mbti).toUpperCase();
    if (m !== null && !/^[EI][SN][TF][JP]$/.test(m)) throw badRequest("MBTI 格式无效");
    p.mbti = m;
  }
  if (patch.bio !== undefined) {
    if (typeof patch.bio !== "string" || patch.bio.length > 120) throw badRequest("一句话介绍最多 120 字");
    p.bio = patch.bio.trim();
  }
  if (patch.interests !== undefined) {
    if (!Array.isArray(patch.interests) || patch.interests.length > 8) throw badRequest("爱好标签最多 8 个");
    const seen = new Set<string>();
    p.interests = patch.interests.map(i => {
      const tag = String(i).trim();
      if (tag.length < 1 || tag.length > 10) throw badRequest("每个标签 1–10 字");
      if (seen.has(tag)) throw badRequest("标签不能重复");
      seen.add(tag);
      return tag;
    });
  }
  if (patch.contacts !== undefined) {
    if (!Array.isArray(patch.contacts) || patch.contacts.length === 0 || patch.contacts.length > 5) throw badRequest("联系方式需 1–5 栏");
    const seen = new Set<string>();
    p.contacts = patch.contacts.map((c: { label?: unknown; value?: unknown }, i: number) => {
      const label = String(c?.label ?? "").trim();
      const value = String(c?.value ?? "").trim();
      if (label.length < 1 || label.length > 12) throw badRequest("联系方式名称 1–12 字");
      if (seen.has(label)) throw badRequest("联系方式名称不能重复");
      seen.add(label);
      if (value.length < 1 || value.length > 40) throw badRequest("联系方式内容 1–40 字");
      return { id: `c-${viewer}-${i}-${label}`, label, value };
    });
  }
}
