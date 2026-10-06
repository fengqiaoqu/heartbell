// 相遇服务（v2.8 / M03 重写）：活动内雷达、定向摇铃、回响与多连接。
// 所有门槛在服务端校验；写入路径为同步临界段（内存仓库，无 await 外部请求）。
// MD-08：POST /ring 必须携带 candidateRef 与幂等键，绝不退回“第一个候选”。
// MD-09/10：回响前重验资格；双向并发接受只建一个连接，另一条 superseded。
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf } from "../../../repositories/demo-repo";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors";
import type { Trait } from "../../../domain/v2-types";
import {
  aliasOfSession,
  BELL_MAX_MS, DISCOVERY_NOTE_MAX, MEET_IDEMPOTENCY_TTL_MS,
  RING_PER_PAIR_WINDOW_MS,
  RADAR_MAX_MS,
} from "../../../domain/meet-types";
import { activeRestrictionOf, assertPairCanInteract, revokeGrantsBetween } from "../privacy-policy";
import { activeMembershipOf, eventOf } from "./events";
import {
  discoveryContextOf, isEligibleCandidate, parseTraitsInput, resolveCandidateRef,
  ringLimitOf, ringRequestHash,
} from "./discovery";

export const bellMessages = ["想认识你。", "想和你聊一聊。", "想一起喝杯咖啡。"];

function connectionBetween(state: V2State, x: string, y: string) {
  return state.connections.find(c =>
    (c.members[0] === x && c.members[1] === y) || (c.members[0] === y && c.members[1] === x)) ?? null;
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// MD-04：开雷达需要成年声明、开放活动、可用账号、无有效关系、无 discovery 限制；
// 时长 min(10 分钟, 活动剩余)；更新特征不延长截止；活动来自服务端成员身份。
export function setRadar(
  state: V2State, viewer: string, active: boolean,
  input: { traits?: unknown; discoveryNote?: unknown }, now: number,
): void {
  const user = state.users.get(viewer)!;
  const radar = state.radar.get(viewer);
  if (!active) {
    if (radar) {
      radar.active = false;
      radar.expiresAt = null;
      // 手动关闭立即取消候选资格并使相关 pending 铃声过期（MD-04）。
      state.candidateRefs = state.candidateRefs.filter(ref => ref.actorId !== viewer && ref.targetId !== viewer);
      for (const bell of state.bells) {
        if (bell.status === "pending" && (bell.from === viewer || bell.to === viewer)) bell.status = "expired";
      }
    }
    return;
  }
  if (!user.adultDeclared) throw forbidden("请先完成成年演示声明");
  // v2.6 安全：限时发现限制期间暂停新开启（退出/撤权/举报等救济操作不受影响）。
  const restriction = activeRestrictionOf(state, viewer, "discovery", now);
  if (restriction) {
    throw forbidden(`当前无法继续此操作。（限制至 ${new Date(restriction.expiresAt).toLocaleDateString("zh-CN")}）`);
  }
  // v2.5：后台功能开关（仅拦截新的开启；已开启的雷达不受影响，可正常关闭）。
  if (!state.featureConfig.radarNewEnabled) {
    throw new ApiError(503, "MAINTENANCE", "心动雷达暂停新开启（维护公告期内），已开启的铃声不受影响。", true);
  }
  if (activeRelationshipOf(state, viewer)) {
    throw forbidden("你们的故事正在继续：已有有效关系时，陌生人恋爱雷达已停止。");
  }
  const membership = activeMembershipOf(state, viewer);
  if (!membership) throw conflict("EVENT_REQUIRED", "请先输入活动码加入活动，再开启雷达");
  const event = eventOf(state, membership.eventId);
  if (!event || event.status !== "open" || event.startsAt > now || event.endsAt <= now) {
    throw conflict("EVENT_NOT_OPEN", "当前活动不可用，雷达无法开启");
  }
  let parsed: Trait[];
  try {
    parsed = parseTraitsInput(input.traits);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : "特征无效");
  }
  const noteRaw = typeof input.discoveryNote === "string" ? input.discoveryNote.trim() : "";
  if (noteRaw.length > DISCOVERY_NOTE_MAX) throw badRequest(`相遇留言最多 ${DISCOVERY_NOTE_MAX} 字`);
  const existing = state.radar.get(viewer);
  // 重复调用不重置倒计时，只更新本轮特征与留言（v2.2 修复语义保留）。
  if (existing?.active && existing.expiresAt !== null && existing.eventId === membership.eventId) {
    existing.traits = parsed;
    existing.discoveryNote = noteRaw;
    return;
  }
  const expiresAt = Math.min(now + RADAR_MAX_MS, event.endsAt);
  state.radar.set(viewer, {
    active: true, traits: parsed, zone: "wuhan-demo-block",
    startedAt: now, expiresAt,
    sessionId: rid("radar"), eventId: membership.eventId, discoveryNote: noteRaw,
  });
}

// MD-08：定向摇铃 —— candidateRef + 幂等键；缺参数 400；失效目标统一 404（不泄露对方私有状态）。
export function ringBell(
  state: V2State, viewer: string,
  input: { candidateRef?: unknown; message?: unknown; idempotencyKey?: unknown },
  headerKey: string | null,
  now: number,
): { bellId: string; replayed: boolean } {
  const bodyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : null;
  if (headerKey !== null && bodyKey !== null && headerKey !== bodyKey) {
    throw badRequest("请求头与请求体中的幂等键不一致");
  }
  const key = headerKey ?? bodyKey;
  if (typeof input.candidateRef !== "string" || !input.candidateRef) {
    throw badRequest("缺少候选引用，请重新选择对象");
  }
  if (!key || !key.trim()) throw badRequest("缺少幂等键（Idempotency-Key）");
  const message = input.message;
  if (typeof message !== "string" || !bellMessages.includes(message)) throw badRequest("请选择预设铃声表达");

  // 发送者门槛（先于目标解析：这些错误面向调用者自身状态，不泄露目标信息）。
  const user = state.users.get(viewer)!;
  if (!user.adultDeclared) throw forbidden("请先完成成年演示声明");
  if (activeRelationshipOf(state, viewer)) throw forbidden("已有有效关系时不能向陌生人摇铃。");
  const ringRestriction = activeRestrictionOf(state, viewer, "ring", now);
  if (ringRestriction) {
    throw forbidden(`当前无法继续此操作。（限制至 ${new Date(ringRestriction.expiresAt).toLocaleDateString("zh-CN")}）`);
  }
  // 发送者限流：3 条/60 秒、10 条/10 分钟；只对成功新建计发送限额（失败请求不占额度）。
  const limit = ringLimitOf(state, viewer, now);
  if (limit.limited) {
    throw new ApiError(429, "TOO_MANY_RINGS", `摇铃太频繁了，请约 ${limit.retryAfterSeconds} 秒后再试。`, true);
  }

  const ref = resolveCandidateRef(state, viewer, input.candidateRef, now);
  if (!ref) throw notFound("此候选已不可操作，请刷新后重新选择");

  // 幂等（MD-10）：同用户同动作同键同请求 → 同一 bellId；同键不同请求 → 409。
  const requestHash = ringRequestHash(input.candidateRef, message);
  const prior = state.meetIdempotency.find(e =>
    e.actorId === viewer && e.action === "ring" && e.key === key && e.expiresAt > now);
  if (prior) {
    if (prior.requestHash === requestHash) return { bellId: prior.bellId, replayed: true };
    throw conflict("IDEMPOTENCY_CONFLICT", "同一幂等键已用于不同的请求");
  }

  // 有向用户对：10 分钟内最多一条新铃声（换活动/重开雷达不重置）。
  if (state.bells.some(b => b.from === viewer && b.to === ref.targetId && now - b.createdAt < RING_PER_PAIR_WINDOW_MS)) {
    throw conflict("ALREADY_RINGED", "10 分钟内已向 TA 摇过铃，等待回响或稍后再试");
  }


  const targetRadar = state.radar.get(ref.targetId)!;
  const myRadar = state.radar.get(viewer)!;
  const event = eventOf(state, ref.eventId)!;
  const expiresAt = Math.min(now + BELL_MAX_MS, myRadar.expiresAt ?? now + BELL_MAX_MS, targetRadar.expiresAt ?? now + BELL_MAX_MS, event.endsAt);
  const bell = {
    id: rid("bell"),
    from: viewer, to: ref.targetId, message, status: "pending" as const, createdAt: now,
    eventId: ref.eventId,
    fromSessionId: ref.actorSessionId, toSessionId: ref.targetSessionId,
    expiresAt,
    // 双方当时自愿公开的本轮快照（区分多条来铃，不携带长期资料）。
    fromTraits: myRadar.traits.map(t => ({ ...t })),
    fromNote: myRadar.discoveryNote ?? "",
    toTraits: targetRadar.traits.map(t => ({ ...t })),
    toNote: targetRadar.discoveryNote ?? "",
    toAlias: ref.alias,
    fromAlias: aliasOfSession(ref.actorSessionId), // 接收者视角下发送者的别名（本轮会话派生）
    connectionId: null,
  };
  state.bells.push(bell);
  state.meetIdempotency.push({
    actorId: viewer, action: "ring" as const, key, requestHash, bellId: bell.id,
    at: now, expiresAt: now + MEET_IDEMPOTENCY_TTL_MS,
  });
  return { bellId: bell.id, replayed: false };
}

// MD-09/10：回响 —— 只有接收者可回应；接受前重验双方资格；重复回应幂等；相反终态 409。
export function respondBell(
  state: V2State, viewer: string, bellId: unknown, status: unknown, now: number,
): { bellId: string; status: "accepted" | "dismissed"; connectionId: string | null } {
  if (typeof bellId !== "string" || !["accepted", "dismissed"].includes(String(status))) {
    throw badRequest("无效的回响请求");
  }
  const bell = state.bells.find(b => b.id === bellId && b.to === viewer);
  if (!bell) throw notFound("铃声不存在或不可回应");
  if (bell.status === "pending" && bell.expiresAt !== null && bell.expiresAt <= now) {
    bell.status = "expired";
  }
  if (bell.status !== "pending") {
    // 幂等：同接收者重复相同终态返回原结果；相反终态冲突。
    if (bell.status === "accepted" || bell.status === "dismissed") {
      const requested = String(status);
      if (requested === bell.status) {
        return { bellId: bell.id, status: bell.status as "accepted" | "dismissed", connectionId: bell.connectionId };
      }
      throw conflict("BELL_STATE", "这条铃声已处理，不能改为另一种结果");
    }
    // MD-10：并发双回响 —— 首条接受后本条已被标记 superseded；
    // 接收者几乎同时点的“接受”幂等返回同一连接（界面显示“已通过另一条铃声建立连接”）。
    if (bell.status === "superseded") {
      if (String(status) === "accepted") {
        return { bellId: bell.id, status: "accepted", connectionId: bell.connectionId };
      }
      throw conflict("BELL_STATE", "已通过另一条铃声建立连接，这条铃声不能再忽略");
    }
    throw conflict("BELL_NOT_PENDING", "铃声不存在或已经处理");
  }
  if (String(status) === "dismissed") {
    bell.status = "dismissed";
    return { bellId: bell.id, status: "dismissed", connectionId: null };
  }
  // 接受前重验：屏蔽、注销、任一方已有关系、连接已存在/关闭（掩护性错误统一 404）。
  if (!isEligiblePairForAccept(state, bell, now)) {
    bell.status = "expired";
    throw notFound("此候选已不可操作，请刷新后重新选择");
  }
  // 用户对唯一连接：另一条铃声已先建立连接 → 本条 superseded，不重复建连接。
  const existingConn = connectionBetween(state, bell.from, bell.to);
  if (existingConn) {
    if (existingConn.closed) {
      bell.status = "expired";
      throw notFound("此候选已不可操作，请刷新后重新选择");
    }
    bell.status = "superseded";
    bell.connectionId = existingConn.id;
    return { bellId: bell.id, status: "accepted", connectionId: existingConn.id };
  }
  assertPairCanInteract(state, bell.from, bell.to); // 防御性重验（isEligiblePairForAccept 已覆盖）
  const conn = {
    id: rid("conn"),
    members: [bell.from, bell.to] as [string, string], bellMessage: bell.message,
    createdAt: now, closed: false, closedAt: null, closedBy: null,
  };
  state.connections.push(conn);
  bell.status = "accepted";
  bell.connectionId = conn.id;
  // 对向 pending 铃声终结为 superseded（双方互相摇铃只建一个连接）。
  for (const other of state.bells) {
    if (other.status === "pending" && other.from === bell.to && other.to === bell.from) {
      other.status = "superseded";
      other.connectionId = conn.id;
    }
  }
  return { bellId: bell.id, status: "accepted", connectionId: conn.id };
}

function isEligiblePairForAccept(state: V2State, bell: { from: string; to: string }, now: number): boolean {
  const from = state.users.get(bell.from);
  const to = state.users.get(bell.to);
  if (!from || !to || from.disabledAt !== null || to.disabledAt !== null) return false;
  if (activeRelationshipOf(state, bell.from) || activeRelationshipOf(state, bell.to)) return false;
  // 屏蔽期间不接受回响建立新连接（已有关系/救济路径不受影响）。
  try { assertPairCanInteract(state, bell.from, bell.to); } catch { return false; }
  void now;
  return true;
}

// MEET-07：任一方可关闭连接；关闭后不再出现在彼此雷达，也不返回对方档案。
// v2.6：关闭连接同时撤销双方资料授权（关闭 ≠ 屏蔽，但旧授权随连接失效）。
// v2.8：关闭后双方候选引用失效，待处理铃声过期。
export function closeConnection(state: V2State, viewer: string, connectionId: unknown, now: number): void {
  const conn = state.connections.find(c => c.id === connectionId);
  if (!conn || !conn.members.includes(viewer)) throw forbidden("连接不存在");
  if (conn.closed) return;
  conn.closed = true; conn.closedAt = now; conn.closedBy = viewer;
  revokeGrantsBetween(state, conn.members[0], conn.members[1], now, "connection_closed");
  const [x, y] = conn.members;
  state.candidateRefs = state.candidateRefs.filter(ref =>
    !((ref.actorId === x && ref.targetId === y) || (ref.actorId === y && ref.targetId === x)));
  for (const bell of state.bells) {
    if (bell.status === "pending" && ((bell.from === x && bell.to === y) || (bell.from === y && bell.to === x))) {
      bell.status = "expired";
    }
  }
}

// 供视图装配复用：查看者候选上下文。
export { discoveryContextOf } from "./discovery";
