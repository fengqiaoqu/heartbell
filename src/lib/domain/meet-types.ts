// 多人相遇与候选发现领域类型（v2.8 / M03，依据《多人相遇与候选发现开发计划书》第 3/4 节）。
// 活动码只代表加入同一活动，不证明两人实际相邻；内存存储与演示账号不等于正式多人上线能力。
// 数值为产品默认值，集中定义，不散落在前后端。

import type { Trait } from "./v2-types";

// ---------- 常量（MD-02/04/07/08/09/10） ----------

export const RADAR_MAX_MS = 600_000;                 // 雷达单轮上限 10 分钟
export const CANDIDATE_REF_TTL_MS = 120_000;         // 候选引用最长 120 秒
export const CANDIDATE_REF_RENEW_LEFT_MS = 30_000;   // 剩余不足 30 秒可续发（旧引用保留到原截止）
export const BELL_MAX_MS = 600_000;                  // 铃声时效上限 10 分钟（受雷达/活动截止约束）
export const RING_PER_PAIR_WINDOW_MS = 600_000;      // 有向用户对：10 分钟内最多 1 条新铃声
export const RING_SENDER_SHORT_MAX = 3;              // 同发送者 60 秒内最多 3 条
export const RING_SENDER_SHORT_WINDOW_MS = 60_000;
export const RING_SENDER_LONG_MAX = 10;              // 同发送者 10 分钟内最多 10 条
export const RING_SENDER_LONG_WINDOW_MS = 600_000;
export const MEET_IDEMPOTENCY_TTL_MS = 24 * 86_400_000; // 相遇幂等记录保留 24 小时
export const EVENT_JOIN_FAIL_MAX = 5;                // 连续 5 次入场失败
export const EVENT_JOIN_COOLDOWN_MS = 300_000;       // 失败后冷却 5 分钟
export const EVENT_CAPACITY_DEFAULT = 50;
export const EVENT_CAPACITY_MIN = 2;
export const EVENT_CAPACITY_MAX = 50;
export const EVENT_SEED_LIFETIME_MS = 24 * 86_400_000; // 种子活动默认有效 24 小时
export const DISCOVERY_NOTE_MAX = 60;                // 相遇留言最多 60 字
export const EVENT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去除易混淆字符（I/L/O/0/1）

// ---------- 活动（MD-02/03/14） ----------

export type EventStatus = "open" | "paused" | "closed";

export interface EventRoom {
  id: string;
  name: string;
  codeHash: string;        // 服务端只存摘要；明文码仅创建/换码时返回一次（种子演示码除外，见 README）
  status: EventStatus;     // closed 不能重开；自然到期按关闭处理
  startsAt: number;
  endsAt: number;
  capacity: number;        // 2–50，默认 50
  revision: number;        // 管理端乐观并发
  createdAt: number;
  closedReason: "admin" | "expired" | null;
}

export interface EventMembership {
  id: string;
  eventId: string;
  userId: string;
  joinedAt: number;
  leftAt: number | null;   // null = 有效成员；每用户最多一条未结束记录
}

// ---------- 候选引用（MD-07） ----------

export interface CandidateReference {
  token: string;           // 密码学随机（node:crypto randomBytes(24)），不携带可解码目标
  actorId: string;         // 查看者
  targetId: string;        // 服务端私有
  eventId: string;
  actorSessionId: string;
  targetSessionId: string;
  alias: string;           // 目标本轮匿名别名（查看者上下文稳定）
  createdAt: number;
  expiresAt: number;       // ≤ min(120s, 双方雷达截止, 活动截止)
}

// ---------- 相遇幂等（MD-10；独立于 v2.7 日记/承诺缓存） ----------

export interface MeetIdempotencyRecord {
  actorId: string;
  action: "ring";
  key: string;
  requestHash: string;     // sha256(candidateRef + message)
  bellId: string;
  at: number;
  expiresAt: number;
}

// ---------- 入场失败限流（MD-02） ----------

export interface EventJoinFailure {
  userId: string;
  failures: number[];      // 失败时间戳（滑动窗口）
}

// ---------- 候选 DTO（客户端可见的最少字段，MD-06） ----------

export interface CandidateDto {
  candidateRef: string;
  alias: string;
  traits: { category: string; value: string }[];
  discoveryNote: string;
  canRing: boolean;
  ringState: "ready" | "pending" | "cooldown";
  retryAfterSeconds?: number;
}

// ---------- 铃声 DTO（不含内部 from/to，MD-06/计划书第 5 节） ----------

export interface BellDto {
  id: string;
  direction: "incoming" | "outgoing";
  counterpartyAlias: string;
  counterpartyTraits: { category: string; value: string }[];
  counterpartyNote: string;
  message: string;
  status: "pending" | "accepted" | "dismissed" | "expired" | "superseded";
  createdAt: number;
  expiresAt: number | null;
  connectionId?: string | null;
}

// ---------- 活动上下文 DTO（GET /meet/context；无全体成员名单与活动码） ----------

export interface MeetEventContextDto {
  joined: {
    eventId: string;
    eventName: string;
    status: EventStatus;
    endsAt: number;
    memberLabel: string;   // “同一活动”标识，不显示人数明细
  } | null;
  radar: {
    active: boolean;
    expiresAt: number | null;
    traits: Trait[];
    discoveryNote: string;
  };
  joinCooldownSeconds: number; // >0 表示失败冷却中
}

// 匿名别名：从雷达会话派生（同一轮次对所有查看者一致且稳定，不承载身份信息）。
export function aliasOfSession(sessionId: string): string {
  let hash = 0;
  for (const ch of sessionId) hash = (hash * 31 + ch.charCodeAt(0)) % 46656;
  return `铃铛·${hash.toString(36).toUpperCase().padStart(3, "0")}`;
}
