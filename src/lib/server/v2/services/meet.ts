// 相遇服务：雷达、摇铃、回响（计划书第 3 节）。所有门槛在服务端校验。
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf } from "../../../repositories/demo-repo";
import { ApiError, badRequest, conflict, forbidden } from "../errors";
import type { Trait } from "../../../domain/v2-types";
import { activeRestrictionOf, assertPairCanInteract, blockedEitherWay, revokeGrantsBetween } from "../privacy-policy";

const categories = ["穿着", "配饰", "手持物", "当前状态", "其他"] as const;
export const bellMessages = ["想认识你。", "想和你聊一聊。", "想一起喝杯咖啡。"];

function connectionClosedBetween(state: V2State, x: string, y: string): boolean {
  return state.connections.some(c =>
    (c.members[0] === x && c.members[1] === y) || (c.members[0] === y && c.members[1] === x));
}

// MEET-06：已有有效关系时，服务端拦截开启恋爱雷达。
export function setRadar(state: V2State, viewer: string, active: boolean, traits: unknown, now: number): void {
  if (!active) {
    const radar = state.radar.get(viewer);
    if (radar) { radar.active = false; radar.expiresAt = null; }
    return;
  }
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
  if (!Array.isArray(traits) || traits.length < 2 || traits.length > 3) {
    throw badRequest("请选择两到三个临时特征");
  }
  const parsed: Trait[] = traits.map((t: { category?: unknown; value?: unknown }) => {
    const category = String((t as { category?: unknown }).category);
    const value = typeof (t as { value?: unknown }).value === "string" ? ((t as { value: string }).value).trim() : "";
    if (!(categories as readonly string[]).includes(category)) throw badRequest("特征类别无效");
    if (value.length < 1 || value.length > 20) throw badRequest("每项特征 1–20 字");
    return { category: category as Trait["category"], value };
  });
  const existing = state.radar.get(viewer);
  // v2.2 修复：雷达已在开启状态时重复调用不再重置 10 分钟倒计时（本轮剩余时间保持不变），
  // 只更新临时特征；到期/关闭后重新开启才从新的 10 分钟起算（sweep 已把过期雷达置为关闭）。
  if (existing?.active && existing.expiresAt !== null) {
    existing.traits = parsed;
    return;
  }
  state.radar.set(viewer, {
    active: true, traits: parsed, zone: "wuhan-demo-block",
    startedAt: now, expiresAt: now + 600_000,
  });
}

// MEET-03：同轮次同对象最多摇一次，重复调用接口也拒绝（服务端计算轮次）。
export function ringBell(state: V2State, viewer: string, message: unknown, now: number): string {
  const user = state.users.get(viewer)!;
  if (!user.adultDeclared) throw forbidden("请先完成成年演示声明");
  if (activeRelationshipOf(state, viewer)) {
    throw forbidden("已有有效关系时不能向陌生人摇铃。");
  }
  // v2.6 安全：限时摇铃限制期间拒绝新铃声（救济操作不受影响）。
  const restriction = activeRestrictionOf(state, viewer, "ring", now);
  if (restriction) {
    throw forbidden(`当前无法继续此操作。（限制至 ${new Date(restriction.expiresAt).toLocaleDateString("zh-CN")}）`);
  }
  const radar = state.radar.get(viewer);
  if (!radar?.active || !radar.expiresAt) throw conflict("RADAR_REQUIRED", "需要先开启心动雷达");
  // v2.6：被屏蔽的双方从候选中互相不可见。
  const targets = [...state.users.keys()].filter(id => {
    if (id === viewer || state.users.get(id)?.kind !== "demo") return false;
    if (blockedEitherWay(state, viewer, id)) return false;
    const other = state.radar.get(id);
    return !!other?.active;
  });
  if (targets.length === 0) throw conflict("NO_NEARBY", "附近还没有开启雷达的铃铛");
  const target = targets[0];
  if (connectionClosedBetween(state, viewer, target)) {
    throw forbidden("该连接已关闭，不再接收新铃声。");
  }
  if (typeof message !== "string" || !bellMessages.includes(message)) throw badRequest("请选择预设铃声表达");
  const roundStart = radar.expiresAt - 600_000;
  if (state.bells.some(b => b.from === viewer && b.to === target && b.createdAt >= roundStart)) {
    throw conflict("ALREADY_RINGED", "本轮已经向 TA 摇过铃了");
  }
  const bell = {
    id: `bell-${Math.random().toString(36).slice(2, 10)}`,
    from: viewer, to: target, message, status: "pending" as const, createdAt: now,
  };
  state.bells.push(bell);
  return bell.id;
}

// MEET-04：回响后同时揭晓双方资料；未回响时接口不返回对方档案（见 view 装配）。
export function respondBell(state: V2State, viewer: string, bellId: unknown, status: unknown, now: number): void {
  if (typeof bellId !== "string" || !["accepted", "dismissed"].includes(String(status))) {
    throw badRequest("无效的回响请求");
  }
  const bell = state.bells.find(b => b.id === bellId && b.to === viewer && b.status === "pending");
  if (!bell) throw conflict("BELL_NOT_PENDING", "铃声不存在或已经处理");
  bell.status = status === "accepted" ? "accepted" : "dismissed";
  // v2.6：屏蔽期间不接受回响建立新连接（已有关系/救济路径不受影响）。
  if (bell.status === "accepted" && !connectionClosedBetween(state, bell.from, bell.to)) {
    assertPairCanInteract(state, bell.from, bell.to);
    state.connections.push({
      id: `conn-${Math.random().toString(36).slice(2, 10)}`,
      members: [bell.from, bell.to], bellMessage: bell.message,
      createdAt: now, closed: false, closedAt: null, closedBy: null,
    });
  }
}

// MEET-07：任一方可关闭连接；关闭后不再出现在彼此雷达，也不返回对方档案。
// v2.6：关闭连接同时撤销双方资料授权（关闭 ≠ 屏蔽，但旧授权随连接失效）。
export function closeConnection(state: V2State, viewer: string, connectionId: unknown, now: number): void {
  const conn = state.connections.find(c => c.id === connectionId);
  if (!conn || !conn.members.includes(viewer)) throw forbidden("连接不存在");
  if (conn.closed) return;
  conn.closed = true; conn.closedAt = now; conn.closedBy = viewer;
  revokeGrantsBetween(state, conn.members[0], conn.members[1], now, "connection_closed");
}
