// 活动服务（v2.8 / M03，MD-02/03/14）。
// 活动码只代表加入同一活动，不证明两人实际相邻；每用户最多一个有效活动身份。
// 换活动原子清理：旧成员身份、雷达、候选引用与相关待处理铃声一起处理，失败不落半成品。
import type { V2State } from "../../../repositories/demo-repo";
import { eventCodeHash, generateEventCode } from "../../../repositories/demo-repo";
import {
  EVENT_CAPACITY_DEFAULT, EVENT_CAPACITY_MAX, EVENT_CAPACITY_MIN,
  EVENT_JOIN_COOLDOWN_MS, EVENT_JOIN_FAIL_MAX,
  type EventRoom,
} from "../../../domain/meet-types";
import { ApiError, badRequest, conflict, notFound } from "../errors";

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function activeMembershipOf(state: V2State, userId: string) {
  return state.eventMemberships.find(m => m.userId === userId && m.leftAt === null) ?? null;
}

export function eventOf(state: V2State, eventId: string): EventRoom | null {
  return state.events.find(e => e.id === eventId) ?? null;
}

export function activeMemberCountOf(state: V2State, eventId: string): number {
  return state.eventMemberships.filter(m => m.eventId === eventId && m.leftAt === null).length;
}

// 入场失败限流（MD-02）：按已验证账号计数，换 viewer/重开雷达不能绕过。
function recordJoinFailure(state: V2State, userId: string, now: number): void {
  const entry = state.eventJoinFailures.find(f => f.userId === userId);
  const list = entry ? entry.failures.filter(t => now - t < EVENT_JOIN_COOLDOWN_MS) : [];
  list.push(now);
  if (entry) entry.failures = list;
  else state.eventJoinFailures.push({ userId, failures: list });
}

export function joinCooldownSeconds(state: V2State, userId: string, now: number): number {
  const entry = state.eventJoinFailures.find(f => f.userId === userId);
  if (!entry) return 0;
  const recent = entry.failures.filter(t => now - t < EVENT_JOIN_COOLDOWN_MS);
  if (recent.length < EVENT_JOIN_FAIL_MAX) return 0;
  const last = Math.max(...recent);
  return Math.max(0, Math.ceil((last + EVENT_JOIN_COOLDOWN_MS - now) / 1000));
}

// 清理某用户在指定活动的发现态：雷达、候选引用、待处理铃声（保留已接受连接与有效关系）。
export function teardownDiscoveryFor(state: V2State, userId: string, eventId: string): void {
  const radar = state.radar.get(userId);
  if (radar?.active) { radar.active = false; radar.expiresAt = null; }
  state.candidateRefs = state.candidateRefs.filter(ref =>
    !(ref.actorId === userId || ref.targetId === userId));
  for (const bell of state.bells) {
    if (bell.status === "pending" && (bell.from === userId || bell.to === userId)) {
      // 只结束与该活动相关的待处理铃声；其他活动的历史铃声不受影响。
      if (bell.eventId === eventId || bell.eventId === null) bell.status = "expired";
    }
  }
}

// 活动整体失效（暂停/关闭/到期，MD-14）：关闭活动内全部雷达、引用与 pending 铃声。
export function teardownEventDiscovery(state: V2State, eventId: string, endMemberships: boolean, now: number): void {
  state.candidateRefs = state.candidateRefs.filter(ref => ref.eventId !== eventId);
  for (const radar of state.radar.values()) {
    if (radar.eventId === eventId && radar.active) { radar.active = false; radar.expiresAt = null; }
  }
  for (const bell of state.bells) {
    if (bell.eventId === eventId && bell.status === "pending") bell.status = "expired";
  }
  if (endMemberships) {
    for (const m of state.eventMemberships) {
      if (m.eventId === eventId && m.leftAt === null) m.leftAt = now;
    }
  }
}

// 加入活动：code 归一（trim + 大写）；失败统一文案不泄露人数/成员；同活动幂等。
export function joinEvent(
  state: V2State, viewer: string, code: unknown, replaceCurrent: unknown, now: number,
): { eventId: string; eventName: string; alreadyMember: boolean } {
  if (typeof code !== "string" || !code.trim()) throw badRequest("请输入活动码");
  const normalized = code.trim().toUpperCase();
  const cooldown = joinCooldownSeconds(state, viewer, now);
  if (cooldown > 0) {
    throw new ApiError(429, "JOIN_COOLDOWN", `尝试过于频繁，请约 ${cooldown} 秒后再试。`, true);
  }
  const current = activeMembershipOf(state, viewer);
  const event = state.events.find(e =>
    e.codeHash === eventCodeHash(normalized) && e.status !== "closed" && e.startsAt <= now && e.endsAt > now);
  const joinable = !!event && activeMemberCountOf(state, event.id) < event.capacity;
  if (!joinable || !event) {
    recordJoinFailure(state, viewer, now);
    // 统一文案：不区分不存在、暂停、到期、已满（MD-02）。
    throw conflict("EVENT_JOIN_FAILED", "活动当前不可加入");
  }
  if (current && current.eventId === event.id) {
    return { eventId: event.id, eventName: event.name, alreadyMember: true }; // 幂等：不刷新雷达
  }
  if (current) {
    if (replaceCurrent !== true) {
      throw conflict("EVENT_CONFLICT", "你已在另一个活动中；换活动会关闭当前雷达和未处理的铃声，请确认后重试。");
    }
    // MD-03：原子切换 —— 先结束旧身份并清理，再写新身份。
    current.leftAt = now;
    teardownDiscoveryFor(state, viewer, current.eventId);
  }
  // 成员身份在容量校验后同步写入（单进程临界段，无 await）。
  state.eventMemberships.push({
    id: rid("mem"), eventId: event.id, userId: viewer, joinedAt: now, leftAt: null,
  });
  const failures = state.eventJoinFailures.find(f => f.userId === viewer);
  if (failures) failures.failures = [];
  return { eventId: event.id, eventName: event.name, alreadyMember: false };
}

// 退出活动：重复退出幂等成功；已接受连接、有效关系与共同记录保留。
export function leaveEvent(state: V2State, viewer: string, eventId: unknown, now: number): { ok: true } {
  const current = activeMembershipOf(state, viewer);
  if (!current) return { ok: true };
  if (typeof eventId === "string" && eventId !== current.eventId) {
    throw badRequest("只能退出你当前所在的活动");
  }
  current.leftAt = now;
  teardownDiscoveryFor(state, viewer, current.eventId);
  return { ok: true };
}

// ---------- 运营侧（ops 路由调用；权限与审计在路由层执行，不记明文活动码） ----------

export function opsListEvents(state: V2State) {
  return [...state.events]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(e => opsEventDto(state, e));
}

export function opsEventDto(state: V2State, event: EventRoom) {
  return {
    id: event.id, name: event.name, status: event.status,
    startsAt: event.startsAt, endsAt: event.endsAt,
    capacity: event.capacity, memberCount: activeMemberCountOf(state, event.id),
    revision: event.revision, createdAt: event.createdAt,
    closedReason: event.closedReason,
  };
}

export function opsCreateEvent(
  state: V2State,
  input: { name: unknown; capacity: unknown; startsAt: unknown; endsAt: unknown },
  now: number,
): { event: ReturnType<typeof opsEventDto>; code: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 24) throw badRequest("活动名称 2–24 字");
  const capacity = typeof input.capacity === "number" ? Math.floor(input.capacity) : EVENT_CAPACITY_DEFAULT;
  if (capacity < EVENT_CAPACITY_MIN || capacity > EVENT_CAPACITY_MAX) {
    throw badRequest(`活动容量 ${EVENT_CAPACITY_MIN}–${EVENT_CAPACITY_MAX}`);
  }
  const startsAt = typeof input.startsAt === "number" ? input.startsAt : Date.parse(String(input.startsAt));
  const endsAt = typeof input.endsAt === "number" ? input.endsAt : Date.parse(String(input.endsAt));
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) throw badRequest("请提供有效的开始/结束时间");
  if (startsAt >= endsAt) throw badRequest("开始时间必须早于结束时间");
  const code = generateEventCode();
  const event: EventRoom = {
    id: rid("event"), name, codeHash: eventCodeHash(code), status: "open",
    startsAt, endsAt, capacity, revision: 1, createdAt: now, closedReason: null,
  };
  state.events.push(event);
  return { event: opsEventDto(state, event), code };
}

export function opsSetEventStatus(
  state: V2State, eventId: string, next: "open" | "paused" | "closed", expectedRevision: unknown, now: number,
) {
  const event = state.events.find(e => e.id === eventId);
  if (!event) throw notFound("活动不存在");
  if (expectedRevision !== event.revision) throw conflict("EVENT_REVISION", "活动刚被其他人修改，请刷新后重试。");
  if (event.status === "closed") throw conflict("EVENT_CLOSED", "已关闭的活动不能重开");
  if (next === "closed") {
    event.status = "closed";
    event.closedReason = "admin";
    event.revision += 1;
    teardownEventDiscovery(state, event.id, true, now);
    return { event: opsEventDto(state, event) };
  }
  if (next === "paused") {
    event.status = "paused";
    event.revision += 1;
    teardownEventDiscovery(state, event.id, false, now); // 暂停保留成员，恢复后需主动再开雷达
    return { event: opsEventDto(state, event) };
  }
  // open：暂停 → 恢复
  if (event.status !== "paused") throw conflict("EVENT_STATE", "只有暂停中的活动可以恢复");
  if (event.endsAt <= now) throw conflict("EVENT_STATE", "活动已到期，不能恢复为开放");
  event.status = "open";
  event.revision += 1;
  return { event: opsEventDto(state, event) };
}

export function opsRotateEventCode(state: V2State, eventId: string, expectedRevision: unknown) {
  const event = state.events.find(e => e.id === eventId);
  if (!event) throw notFound("活动不存在");
  if (event.status === "closed") throw conflict("EVENT_CLOSED", "已关闭的活动不能换码");
  if (expectedRevision !== event.revision) throw conflict("EVENT_REVISION", "活动刚被其他人修改，请刷新后重试。");
  const code = generateEventCode();
  event.codeHash = eventCodeHash(code); // 旧码立即失效；现有成员不受影响
  event.revision += 1;
  return { event: opsEventDto(state, event), code };
}
