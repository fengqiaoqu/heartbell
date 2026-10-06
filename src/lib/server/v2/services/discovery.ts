// 候选发现服务（v2.8 / M03，MD-05/06/07）。
// GET 与写入共用同一资格函数；UI 隐藏不能代替服务端拒绝。
// 匿名 DTO 仅含本轮别名、临时特征、相遇留言与操作状态；不带长期 userId/昵称/头像/联系方式/分数。
import { createHash, randomBytes } from "node:crypto";
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf } from "../../../repositories/demo-repo";
import {
  CANDIDATE_REF_RENEW_LEFT_MS, CANDIDATE_REF_TTL_MS,
  aliasOfSession, type CandidateDto, type CandidateReference,
  RING_PER_PAIR_WINDOW_MS, RING_SENDER_LONG_MAX, RING_SENDER_LONG_WINDOW_MS,
  RING_SENDER_SHORT_MAX, RING_SENDER_SHORT_WINDOW_MS,
} from "../../../domain/meet-types";
import type { Trait } from "../../../domain/v2-types";
import { blockedEitherWay, activeRestrictionOf } from "../privacy-policy";
import { activeMembershipOf, eventOf } from "./events";

export interface DiscoveryContext {
  eventId: string | null;      // 查看者当前活动（来自服务端成员身份）
  radarActive: boolean;
  radarExpiresAt: number | null;
  ineligibleReason: "no_event" | "event_not_open" | "radar_off" | "relationship" | "restriction" | null;
}

// 查看者自己是否具备候选资格（MD-04 持续资格；不含 radarNewEnabled 全局开关，那个只拦新开启）。
export function discoveryContextOf(state: V2State, viewer: string, now: number): DiscoveryContext {
  const membership = activeMembershipOf(state, viewer);
  const event = membership ? eventOf(state, membership.eventId) : null;
  const radar = state.radar.get(viewer);
  const restriction = activeRestrictionOf(state, viewer, "discovery", now);
  let reason: DiscoveryContext["ineligibleReason"] = null;
  if (!membership || !event) reason = "no_event";
  else if (event.status !== "open" || event.startsAt > now || event.endsAt <= now) reason = "event_not_open";
  else if (activeRelationshipOf(state, viewer)) reason = "relationship";
  else if (restriction) reason = "restriction";
  else if (!radar?.active) reason = "radar_off";
  return {
    eventId: membership?.eventId ?? null,
    radarActive: !!radar?.active && reason === null,
    radarExpiresAt: radar?.expiresAt ?? null,
    ineligibleReason: reason,
  };
}

function radarEligible(state: V2State, userId: string, eventId: string, now: number) {
  const radar = state.radar.get(userId);
  if (!radar?.active || radar.expiresAt === null || radar.expiresAt <= now) return null;
  if (radar.eventId !== eventId) return null;
  return radar;
}

// MD-05：统一候选资格 —— 双方同活动、雷达有效、无关系、无屏蔽、无开放/关闭连接、未注销、无 discovery 限制。
export function isEligibleCandidate(state: V2State, viewer: string, candidateId: string, now: number): boolean {
  if (candidateId === viewer) return false;
  const candidate = state.users.get(candidateId);
  if (!candidate || candidate.kind !== "demo" || candidate.disabledAt !== null) return false;
  const membership = activeMembershipOf(state, viewer);
  if (!membership) return false;
  const event = eventOf(state, membership.eventId);
  if (!event || event.status !== "open" || event.startsAt > now || event.endsAt <= now) return false;
  const candidateMembership = activeMembershipOf(state, candidateId);
  if (!candidateMembership || candidateMembership.eventId !== membership.eventId) return false;
  if (!radarEligible(state, viewer, membership.eventId, now)) return false;
  if (!radarEligible(state, candidateId, membership.eventId, now)) return false;
  if (blockedEitherWay(state, viewer, candidateId)) return false;
  if (activeRelationshipOf(state, viewer) || activeRelationshipOf(state, candidateId)) return false;
  if (activeRestrictionOf(state, viewer, "discovery", now) || activeRestrictionOf(state, candidateId, "discovery", now)) return false;
  // 已有开放或关闭连接的对象不再出现（关闭过的连接不因重开雷达恢复）。
  const connected = state.connections.some(c =>
    (c.members[0] === viewer && c.members[1] === candidateId) || (c.members[0] === candidateId && c.members[1] === viewer));
  return !connected;
}

// 发送方限流（MD-08）：换活动或重开雷达不重置（按绝对时间窗计算）。
export function ringLimitOf(state: V2State, viewer: string, now: number): { limited: boolean; retryAfterSeconds?: number } {
  const sent = state.bells.filter(b => b.from === viewer && b.createdAt <= now);
  const shortWindow = sent.filter(b => now - b.createdAt < RING_SENDER_SHORT_WINDOW_MS);
  if (shortWindow.length >= RING_SENDER_SHORT_MAX) {
    const oldest = Math.min(...shortWindow.map(b => b.createdAt));
    return { limited: true, retryAfterSeconds: Math.ceil((oldest + RING_SENDER_SHORT_WINDOW_MS - now) / 1000) };
  }
  const longWindow = sent.filter(b => now - b.createdAt < RING_SENDER_LONG_WINDOW_MS);
  if (longWindow.length >= RING_SENDER_LONG_MAX) {
    const oldest = Math.min(...longWindow.map(b => b.createdAt));
    return { limited: true, retryAfterSeconds: Math.ceil((oldest + RING_SENDER_LONG_WINDOW_MS - now) / 1000) };
  }
  return { limited: false };
}

function ringStateFor(state: V2State, viewer: string, targetId: string, now: number): Pick<CandidateDto, "canRing" | "ringState" | "retryAfterSeconds"> {
  const hasPending = state.bells.some(b => b.from === viewer && b.to === targetId && b.status === "pending");
  if (hasPending) return { canRing: false, ringState: "pending" };
  const limit = ringLimitOf(state, viewer, now);
  if (limit.limited) return { canRing: false, ringState: "cooldown", retryAfterSeconds: limit.retryAfterSeconds };
  const mine = state.bells.filter(b => b.from === viewer && b.to === targetId);
  const pairUsed = mine.some(b => now - b.createdAt < RING_PER_PAIR_WINDOW_MS);
  if (pairUsed) {
    const last = Math.max(...mine.map(b => b.createdAt));
    return { canRing: false, ringState: "cooldown", retryAfterSeconds: Math.ceil((last + RING_PER_PAIR_WINDOW_MS - now) / 1000) };
  }
  return { canRing: true, ringState: "ready" };
}

// 引用上限：≤ min(120s, 双方雷达截止, 活动截止)。
function refExpiry(state: V2State, eventId: string, viewerRadar: { expiresAt: number | null }, targetRadar: { expiresAt: number | null }, now: number): number {
  const event = eventOf(state, eventId)!;
  return Math.min(now + CANDIDATE_REF_TTL_MS, viewerRadar.expiresAt ?? now, targetRadar.expiresAt ?? now, event.endsAt);
}

// 取得或续发候选引用（MD-07）：同查看者/目标/双方轮次复用未过期引用；剩余 <30s 续发，旧引用保留到原截止。
export function candidateRefFor(state: V2State, viewer: string, targetId: string, now: number): CandidateReference | null {
  const viewerRadar = state.radar.get(viewer);
  const targetRadar = state.radar.get(targetId);
  const membership = activeMembershipOf(state, viewer);
  if (!viewerRadar?.active || !targetRadar?.active || !membership) return null;
  if (!viewerRadar.sessionId || !targetRadar.sessionId) return null;
  const existing = state.candidateRefs.find(ref =>
    ref.actorId === viewer && ref.targetId === targetId && ref.eventId === membership.eventId &&
    ref.actorSessionId === viewerRadar.sessionId && ref.targetSessionId === targetRadar.sessionId &&
    ref.expiresAt > now);
  if (existing && existing.expiresAt - now > CANDIDATE_REF_RENEW_LEFT_MS) return existing;
  const expiresAt = refExpiry(state, membership.eventId, viewerRadar, targetRadar, now);
  if (expiresAt <= now) return null;
  const ref: CandidateReference = {
    token: `cr-${randomBytes(24).toString("hex")}`,
    actorId: viewer, targetId, eventId: membership.eventId,
    actorSessionId: viewerRadar.sessionId, targetSessionId: targetRadar.sessionId,
    alias: aliasOfSession(targetRadar.sessionId),
    createdAt: now, expiresAt,
  };
  state.candidateRefs.push(ref);
  return ref;
}

// 解析当前仍有效的引用（旧引用保留到原截止，过期由清扫回收；复制到别人会话/换活动/失效均返回 null）。
export function resolveCandidateRef(state: V2State, viewer: string, token: string, now: number): CandidateReference | null {
  const ref = state.candidateRefs.find(r => r.token === token && r.actorId === viewer);
  if (!ref || ref.expiresAt <= now) return null;
  const actorRadar = state.radar.get(ref.actorId);
  const targetRadar = state.radar.get(ref.targetId);
  if (!actorRadar?.active || actorRadar.sessionId !== ref.actorSessionId) return null;
  if (!targetRadar?.active || targetRadar.sessionId !== ref.targetSessionId) return null;
  const membership = activeMembershipOf(state, ref.actorId);
  if (!membership || membership.eventId !== ref.eventId) return null;
  if (!isEligibleCandidate(state, ref.actorId, ref.targetId, now)) return null;
  return ref;
}

// 候选列表（一期：一次返回全部合格候选，最多 49 张；顺序在一轮内稳定，不做排名）。
export function buildCandidates(state: V2State, viewer: string, now: number): CandidateDto[] {
  const ctx = discoveryContextOf(state, viewer, now);
  if (!ctx.radarActive || !ctx.eventId) return [];
  const candidateIds = [...state.users.keys()].filter(id => isEligibleCandidate(state, viewer, id, now));
  const dtos: CandidateDto[] = [];
  for (const id of candidateIds) {
    const ref = candidateRefFor(state, viewer, id, now);
    if (!ref) continue;
    const radar = state.radar.get(id)!;
    const traits: { category: string; value: string }[] = radar.traits.map(t => ({ category: String(t.category), value: t.value }));
    dtos.push({
      candidateRef: ref.token,
      alias: ref.alias,
      traits,
      discoveryNote: radar.discoveryNote ?? "",
      ...ringStateFor(state, viewer, id, now),
    });
  }
  // 稳定排序：按别名排序，避免轮询期间卡片乱跳。
  dtos.sort((x, y) => (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0));
  return dtos;
}

// 请求指纹（幂等比对用）：candidateRef + message。
export function ringRequestHash(candidateRef: string, message: string): string {
  return createHash("sha256").update(`heartbell-ring:${candidateRef}|${message}`).digest("hex");
}

export function parseTraitsInput(traits: unknown): Trait[] {
  const categories = ["穿着", "配饰", "手持物", "当前状态", "其他"] as const;
  if (!Array.isArray(traits) || traits.length < 2 || traits.length > 3) throw new Error("请选择两到三个临时特征");
  return traits.map((t: { category?: unknown; value?: unknown }) => {
    const category = String((t as { category?: unknown }).category);
    const value = typeof (t as { value?: unknown }).value === "string" ? ((t as { value: string }).value).trim() : "";
    if (!(categories as readonly string[]).includes(category)) throw new Error("特征类别无效");
    if (value.length < 1 || value.length > 20) throw new Error("每项特征 1–20 字");
    return { category: category as Trait["category"], value };
  });
}
