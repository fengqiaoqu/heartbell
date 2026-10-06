// 集中隐私策略（v2.6，依据安全与隐私交付计划书第 4 节）。
// state DTO、详情、直接摘要、证据导出、写入、任务和运营接口共同调用：
// 按对象、版本、用途、当前授权状态判断；默认拒绝未明确定义的访问。
// 掩护性错误：目标被屏蔽/删除/不存在统一“当前无法继续此操作”，不泄露另一方状态。
import type { V2State } from "../../repositories/demo-repo";
import { pushPrivacyAudit } from "../../repositories/demo-repo";
import type { ConnectionV2, DiaryDoc, RecordVersion, ShareScope } from "../../domain/v2-types";
import { forbidden } from "./errors";
import { findActiveGrant } from "./services/relationship";

// ---------- 屏蔽 ----------

export function activeBlockBetween(state: V2State, x: string, y: string) {
  return state.blocks.find(b =>
    b.active && ((b.ownerId === x && b.targetId === y) || (b.ownerId === y && b.targetId === x))) ?? null;
}
export function blockedEitherWay(state: V2State, x: string, y: string): boolean {
  return activeBlockBetween(state, x, y) !== null;
}
export function activeBlocksOf(state: V2State, ownerId: string) {
  return state.blocks.filter(b => b.ownerId === ownerId && b.active);
}

// 新互动（摇铃/邀请/授权/共享写入）统一门槛：任一方屏蔽即拒绝。
export function assertPairCanInteract(state: V2State, x: string, y: string): void {
  if (blockedEitherWay(state, x, y)) throw forbidden("当前无法继续此操作。");
}

// ---------- 连接与授权 ----------

export function openConnectionBetween(state: V2State, x: string, y: string): ConnectionV2 | null {
  return state.connections.find(c =>
    !c.closed && ((c.members[0] === x && c.members[1] === y) || (c.members[0] === y && c.members[1] === x))) ?? null;
}

// 联系方式 / 履约摘要读取：有效授权 + 未关闭连接 + 双方未被屏蔽（撤销后立即失效，无缓存回流）。
export function canReadShared(state: V2State, ownerId: string, audienceId: string, scope: ShareScope, now: number): boolean {
  if (blockedEitherWay(state, ownerId, audienceId)) return false;
  if (!openConnectionBetween(state, ownerId, audienceId)) return false;
  return findActiveGrant(state, ownerId, audienceId, scope, now) !== null;
}

// 撤销 x↔y 双向全部授权（关闭连接 / 结束绑定 / 屏蔽 / 注销级联共用）。
export function revokeGrantsBetween(state: V2State, x: string, y: string, now: number, reason: string): number {
  let revoked = 0;
  for (const grant of state.shareGrants) {
    const pair = (grant.ownerId === x && grant.audienceId === y) || (grant.ownerId === y && grant.audienceId === x);
    if (pair && grant.revokedAt === null) {
      grant.revokedAt = now;
      revoked += 1;
    }
  }
  void reason;
  return revoked;
}

// ---------- 日记版本裁剪（读取矩阵 4.1） ----------

// 返回调用者可见的版本：
// - 作者始终可见自己的版本（含私人草稿）；
// - 从未分享的草稿只对作者可见；
// - 共享版本：待确认/已确认时对方可见；被屏蔽或关系结束后，仅双方已确认的版本保留为只读归档；
// - 已撤回（withdrawn）的共享版本只对作者可见。
// v2.8 复测修复（N04）：ended 直接作为读取条件，覆盖 returned 等所有中间状态 ——
// 此前仅靠结束时的状态转换（awaiting→withdrawn）遮挡，漏掉 returned 版本导致退出后仍可读。
export function visibleDiaryVersions(state: V2State, doc: DiaryDoc, viewer: string): RecordVersion[] {
  const rel = state.relationships.find(r => r.id === doc.relationshipId);
  if (!rel || !rel.members.includes(viewer)) return [];
  const other = rel.members[0] === viewer ? rel.members[1] : rel.members[0];
  const blocked = blockedEitherWay(state, viewer, other);
  const ended = rel.status === "ended";
  return doc.versions.filter(version => {
    if (version.author === viewer) return true;
    if (version.visibility === "draft") return false;           // 从未分享的私人草稿
    if (version.status === "withdrawn") return false;           // 对方已撤回
    if (blocked || ended) return version.status === "confirmed"; // 屏蔽/退出后：仅共同确认归档
    return true;
  });
}

// ---------- 通知裁剪：屏蔽或关系结束后不再透出与对方未决内容相关的旧提醒 ----------

export function notificationVisible(
  state: V2State, viewer: string,
  n: { userId: string; kind: string; objectId: string },
): boolean {
  if (n.userId !== viewer) return false;
  if (n.kind === "diary_awaiting") {
    const doc = state.diaries.find(d => d.id === n.objectId);
    if (!doc) return true; // 对象已不存在，保留历史提醒本身无害（不含正文）
    const rel = state.relationships.find(r => r.id === doc.relationshipId);
    if (rel) {
      const other = rel.members[0] === viewer ? rel.members[1] : rel.members[0];
      // v2.8 复测修复（N02 关联）：屏蔽或关系已结束的待确认提醒不再透出（含归档导出口径）。
      if (blockedEitherWay(state, viewer, other) || rel.status === "ended") return false;
    }
  }
  if (n.kind === "promise_awaiting" || n.kind === "resolution_awaiting") {
    const doc = state.promises.find(p => p.id === n.objectId);
    if (doc) {
      const rel = state.relationships.find(r => r.id === doc.relationshipId);
      if (rel) {
        const other = rel.members[0] === viewer ? rel.members[1] : rel.members[0];
        if (blockedEitherWay(state, viewer, other) || rel.status === "ended") return false;
      }
    }
  }
  return true;
}

// ---------- 敏感读取留痕（脱敏：只记动作与对象 ID） ----------

export function privacyAuditRead(state: V2State, actorId: string, action: string, targetId: string, role: "user" | "admin" = "user"): void {
  pushPrivacyAudit(state, { actorId, actorRole: role, action, targetType: "safety_material", targetId });
}

// ---------- 限制（新发现/摇铃限时限制；不封锁救济操作） ----------

export function activeRestrictionOf(state: V2State, userId: string, scope: "discovery" | "ring", now: number) {
  return state.restrictions.find(r =>
    r.userId === userId && r.scope === scope && r.startsAt <= now && r.expiresAt > now) ?? null;
}
