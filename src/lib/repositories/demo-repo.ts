// V2 演示仓库：内存实现，重启清空（P0 明确标注的本地演示）。
// 语义对齐计划书 10.1 数据对象；P1 由 Postgres 实现同一接口语义。
import { createHash, randomBytes } from "node:crypto";
import type {
  AnchorJob, BellV2, Benefit, CommitmentPlan, ConnectionV2, DiaryDoc,
  DisputeV2, GoalClaim, LedgerEntry, PromiseDoc, RadarStateV2,
  RelationshipStatus, RewardReservation, ShareGrantV2, TrustSnapshotV2, V2Relationship, V2User,
  NotificationV2, FeatureConfigV2, ApprovalRequest, NotificationKind,
} from "../domain/v2-types";
import type {
  UserBlock, SafetyReport, SafetyTargetRef, AccountRestriction, PrivacyAuditEntry,
  DataExportJob, AccountDeletion,
} from "../domain/safety-types";
import type {
  CandidateReference, EventJoinFailure, EventMembership, EventRoom, MeetIdempotencyRecord,
} from "../domain/meet-types";
import { EVENT_CAPACITY_DEFAULT, EVENT_CODE_ALPHABET, EVENT_SEED_LIFETIME_MS } from "../domain/meet-types";
import { defaultFeatureConfig, defaultSpaceSettings } from "../domain/v2-types";
import { INVEST_PER_USER, PLAN_TERMS_VERSION, REWARD_POOL_START } from "../domain/plan-rules";
import { RELATIONSHIP_TERMS_VERSION } from "../domain/relationship";
import { computeTrust } from "../domain/score";
import { demoUserSeeds, demoUserIds } from "../domain/demo-users";
import { demoImageLibrary } from "./demo-images";
export { demoImageLibrary };

export interface V2State {
  users: Map<string, V2User>;
  radar: Map<string, RadarStateV2>;          // userId -> 雷达
  bells: BellV2[];
  connections: ConnectionV2[];
  shareGrants: ShareGrantV2[];
  relationships: V2Relationship[];
  diaries: DiaryDoc[];
  promises: PromiseDoc[];
  trustSnapshots: TrustSnapshotV2[];          // subjectId -> 当前摘要（保留历史版本）
  plans: CommitmentPlan[];
  ledger: LedgerEntry[];
  reservations: RewardReservation[];
  claims: GoalClaim[];
  benefits: Benefit[];
  anchorJobs: AnchorJob[];
  disputes: DisputeV2[];
  notifications: NotificationV2[];            // v2.5：站内通知（读取时仍按权限校验）
  featureConfig: FeatureConfigV2;             // v2.5：功能暂停与公告
  approvals: ApprovalRequest[];               // v2.5：双人审批队列
  lastSweepAt: number | null;                 // v2.5：最近一次状态清扫（运行状态展示）
  // v2.6 安全与隐私（内存演示仓库；P1 持久化适配器需同步建表）
  blocks: UserBlock[];
  safetyReports: SafetyReport[];
  safetyTargetRefs: SafetyTargetRef[];
  restrictions: AccountRestriction[];
  privacyAudits: PrivacyAuditEntry[];
  dataExports: DataExportJob[];
  deletions: AccountDeletion[];
  // v2.7：写入幂等缓存（Idempotency-Key → 已创建记录），网络重试不再产生重复日记/承诺
  idempotency: IdempotencyRecord[];
  virtualOffsetMs: number;
  // v2.8（M03）：活动、成员、候选引用、相遇幂等与入场失败限流
  events: EventRoom[];
  eventMemberships: EventMembership[];
  candidateRefs: CandidateReference[];
  meetIdempotency: MeetIdempotencyRecord[];
  eventJoinFailures: EventJoinFailure[];
}

// v2.7→v2.8：同 viewer + 同 key 的创建请求返回同一条记录。
// v2.8 复测修复（旧问题 09）：缓存改为 24 小时时间窗口淘汰 + 硬上限兜底，
// 其他用户的高频流量不再把未过期的重试保护挤出去。
export interface IdempotencyRecord {
  viewer: string;
  key: string;
  kind: "diary" | "promise";
  recordId: string;
  at: number;
}

export const IDEMPOTENCY_TTL_MS = 24 * 86_400_000;
export const IDEMPOTENCY_CACHE_LIMIT = 2000; // 硬上限兜底（防内存无限增长）

export function findIdempotentRecord(state: V2State, viewer: string, key: string): IdempotencyRecord | null {
  return state.idempotency.find(e => e.viewer === viewer && e.key === key) ?? null;
}

export function rememberIdempotentRecord(state: V2State, entry: IdempotencyRecord): void {
  state.idempotency.push(entry);
  // v2.8 复测修复（旧问题 09）：先按 24 小时窗口淘汰，再按硬上限兜底；
  // 淘汰只影响已过期条目，其他用户的流量不再使未过期的重试保护提前失效。
  if (state.idempotency.length > IDEMPOTENCY_CACHE_LIMIT) {
    state.idempotency = state.idempotency.filter(e => entry.at - e.at < IDEMPOTENCY_TTL_MS);
  }
  if (state.idempotency.length > IDEMPOTENCY_CACHE_LIMIT) {
    state.idempotency = state.idempotency.slice(-IDEMPOTENCY_CACHE_LIMIT);
  }
}

export const DEMO_USER_IDS = demoUserIds;
// 演示图片库常量在 demo-images.ts（客户端安全），此处复用。
export function demoImageSha256(id: string): string {
  return "0x" + createHash("sha256").update(`heartbell-demo-photo:${id}`).digest("hex");
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

// 种子演示活动码（固定值，README 同步列出；动态创建的活动码仅创建/换码时返回一次）。
export const SEED_EVENT_ALPHA_CODE = "HEARTS26";
export const SEED_EVENT_BETA_CODE = "BELLTK26";

export function eventCodeHash(code: string): string {
  return createHash("sha256").update(`heartbell-event-code:${code.toUpperCase()}`).digest("hex");
}

export function generateEventCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += EVENT_CODE_ALPHABET[bytes[i] % EVENT_CODE_ALPHABET.length];
  return code;
}

export function createDemoState(now: number): V2State {
  const state: V2State = {
    users: new Map(), radar: new Map(), bells: [], connections: [], shareGrants: [],
    relationships: [], diaries: [], promises: [], trustSnapshots: [], plans: [],
    ledger: [], reservations: [], claims: [], benefits: [], anchorJobs: [], disputes: [],
    notifications: [], featureConfig: { ...defaultFeatureConfig }, approvals: [],
    lastSweepAt: null,
    blocks: [], safetyReports: [], safetyTargetRefs: [], restrictions: [],
    privacyAudits: [], dataExports: [], deletions: [],
    idempotency: [],
    virtualOffsetMs: 0,
    events: [], eventMemberships: [], candidateRefs: [], meetIdempotency: [], eventJoinFailures: [],
  };
  // v2.8（M03 MD-01）：A–F 统一注册表创建演示用户；资料与凭据分离，凭证仅服务端。
  for (const id of demoUserIds) {
    const seed = demoUserSeeds[id];
    state.users.set(id, {
      id, kind: "demo", adultDeclared: seed.adultDeclared, disabledAt: null,
      profile: {
        nickname: seed.nickname, avatar: seed.avatar, ageWindow: seed.ageWindow,
        orientation: seed.orientation, orientationCustom: null, mbti: seed.mbti,
        interests: [...seed.interests], intention: seed.intention, bio: seed.bio,
        contacts: seed.contacts.map((c, i) => ({ id: `c-${id}-${i}`, label: c.label, value: c.value })),
      },
      verificationLevels: id === "a" || id === "b"
        ? [{ label: "钱包控制权已验证", verified: false }, { label: "真人/身份核验", verified: false }]
        : [],
    });
  }
  // 演示前史：b 的上一段已结束关系（虚构对象，卡片持续标注演示数据）。
  const exId = "fx-ex-of-b";
  state.users.set(exId, {
    id: exId, kind: "fixture", adultDeclared: true, disabledAt: null,
    profile: {
      nickname: "演示前史对象", avatar: "🕯️", ageWindow: "", orientation: null, orientationCustom: null, mbti: null,
      interests: [], intention: "open",
      bio: "虚构演示数据，用于展示履约参考的计算方式。", contacts: [],
    },
    verificationLevels: [],
  });
  const relStart = now - 300 * DAY;
  const relEnd = now - 110 * DAY;
  const fxRel: V2Relationship = {
    id: "fx-rel-b", members: ["b", exId], status: "ended",
    proposedBy: "b", consents: { b: true, [exId]: true },
    proposedAt: relStart, inviteExpiresAt: relStart + 72 * HOUR,
    startedAt: relStart, endedAt: relEnd, endedBy: "b", marriedAt: null,
    termsVersion: RELATIONSHIP_TERMS_VERSION, archiveReason: "演示前史（虚构）",
    spaceSettings: { ...defaultSpaceSettings },
  };
  state.relationships.push(fxRel);
  // v2.6 安全与隐私：第三个演示用户 C 已并入上面的统一注册表（负面权限测试）。
  // 5 项计分承诺：4 fulfilled + 1 unfulfilled => s=4 f=1 n=5 => 71 分。
  const fxPromises: [string, string, boolean][] = [
    ["每周至少一次一起做一顿饭", "fulfilled", false],
    ["生日当天见面并交换手写卡片", "fulfilled", false],
    ["一起完成一次两天短途旅行", "fulfilled", false],
    ["约定节日期间互相陪伴", "fulfilled", false],
    ["向家人正式介绍对方", "unfulfilled", false],
  ];
  for (const [content, result, waived] of fxPromises) {
    const createdAt = relStart + 3 * DAY;
    const dueAt = relEnd - 5 * DAY;
    state.promises.push({
      id: `fx-p-${content.length}-${result}`, relationshipId: fxRel.id, revision: 1,
      content, responsibleUserIds: ["b"], dueAt, criteria: "双方对同一履约证据确认",
      scoringOptIn: !waived, createdAt, status: "active", confirmations: { b: createdAt, [exId]: createdAt },
      returnedBy: null, attachments: [],
      resolutions: {
        b: { result: result as "fulfilled" | "unfulfilled", note: null, settledAt: relEnd + 2 * DAY, confirmedBy: ["b", exId] },
        [exId]: { result: "waived", note: null, settledAt: relEnd + 2 * DAY, confirmedBy: ["b", exId] },
      },
      anchor: null, previousVersionCommitment: null,
    });
  }
  // 初始演示点数：系统发放，账本可追溯（v2.8：A–F 全部演示账号）。
  for (const uid of [...demoUserIds]) {
    state.ledger.push({
      id: `ledger-initial-${uid}`, from: "system:mint", to: `user:${uid}`,
      amount: 1000, unit: "demo-point", businessKey: `initial-grant:${uid}`,
      type: "grant", note: "演示点数初始发放（不可购买/转让/提现）", createdAt: now,
    });
  }
  // v2.8（M03）：两个种子活动（开放、默认 24 小时有效）；A–F 初始均未入场，
  // 测试和演示通过正常入口（活动码）加入。活动码不出现在任何公开目录接口中。
  state.events.push({
    id: "event-alpha", name: "十月咖啡角 · 演示活动甲",
    codeHash: eventCodeHash(SEED_EVENT_ALPHA_CODE), status: "open",
    startsAt: now, endsAt: now + EVENT_SEED_LIFETIME_MS,
    capacity: EVENT_CAPACITY_DEFAULT, revision: 1, createdAt: now, closedReason: null,
  });
  state.events.push({
    id: "event-beta", name: "周末书展 · 演示活动乙",
    codeHash: eventCodeHash(SEED_EVENT_BETA_CODE), status: "open",
    startsAt: now, endsAt: now + EVENT_SEED_LIFETIME_MS,
    capacity: EVENT_CAPACITY_DEFAULT, revision: 1, createdAt: now, closedReason: null,
  });
  state.ledger.push({
    id: "ledger-pool-seed", from: "system:mint", to: "pool:reward",
    amount: REWARD_POOL_START, unit: "demo-point", businessKey: "reward-pool-seed",
    type: "grant", note: "演示奖励预算（独立预算，不依赖用户投入）", createdAt: now,
  });
  state.ledger.push({
    id: "ledger-rose-seed", from: "system:mint", to: "pool:reward",
    amount: 20, unit: "rose-ticket", businessKey: "rose-stock-seed",
    type: "grant", note: "演示玫瑰券库存", createdAt: now,
  });
  void INVEST_PER_USER; void PLAN_TERMS_VERSION;
  // 预生成履约摘要版本：b=71（演示前史），a=无记录（null 分）。
  refreshTrustSnapshot(state, "b", now);
  refreshTrustSnapshot(state, "a", now);
  return state;
}

// 账本余额：同 unit 分账户求和；余额不得为负由记账顺序保证。
export function balanceOf(state: V2State, account: string, unit: "demo-point" | "rose-ticket"): number {
  let sum = 0;
  for (const entry of state.ledger) {
    if (entry.unit !== unit) continue;
    if (entry.from === account) sum -= entry.amount;
    if (entry.to === account) sum += entry.amount;
  }
  return sum;
}

export function postLedger(state: V2State, entry: Omit<LedgerEntry, "id" | "createdAt">, now: number): LedgerEntry {
  if (!Number.isInteger(entry.amount) || entry.amount <= 0) throw new Error("账本金额必须为正整数");
  if (state.ledger.some(e => e.businessKey === entry.businessKey)) {
    return state.ledger.find(e => e.businessKey === entry.businessKey)!; // 幂等：同业务键返回原记录
  }
  const full: LedgerEntry = { ...entry, id: `ledger-${state.ledger.length + 1}-${Math.random().toString(36).slice(2, 8)}`, createdAt: now };
  state.ledger.push(full);
  return full;
}

// 最近一段已结束且属于本人的正式关系（endedAt 降序，不可自选高分旧关系）。
export function latestEndedRelationship(state: V2State, subjectId: string): V2Relationship | null {
  const ended = state.relationships
    .filter(r => r.members.includes(subjectId) && r.status === "ended" && r.endedAt !== null)
    .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
  return ended[0] ?? null;
}

// 当前有效绑定（active/married），每人至多一段。
export function activeRelationshipOf(state: V2State, userId: string): V2Relationship | null {
  return state.relationships.find(r =>
    r.members.includes(userId) && (r.status === "active" || r.status === "married")) ?? null;
}

export function pendingInviteFor(state: V2State, userId: string): V2Relationship | null {
  return state.relationships.find(r =>
    r.status === "proposed" && r.members.includes(userId)) ?? null;
}

// 计算并固化某人的履约摘要版本（结算/申诉变化时生成新版本并撤销旧摘要）。
export function refreshTrustSnapshot(state: V2State, subjectId: string, now: number): TrustSnapshotV2 {
  const source = latestEndedRelationship(state, subjectId);
  const computation = computeTrust(subjectId, source?.id ?? null, state.promises, now);
  const existing = state.trustSnapshots.find(t => t.subjectId === subjectId);
  const origin: "demo" | "user" = subjectId === "b" ? "demo" : "user";
  if (existing) {
    existing.revokedAt = existing.revokedAt ?? now; // 旧版本撤销，历史版本保留
    const next: TrustSnapshotV2 = {
      ...computation, id: `trust-${subjectId}-${existing.version + 1}`,
      version: existing.version + 1, revokedAt: null, origin,
    };
    state.trustSnapshots = state.trustSnapshots.filter(t => t.subjectId !== subjectId).concat([existing, next]);
    return next;
  }
  const snapshot: TrustSnapshotV2 = {
    ...computation, id: `trust-${subjectId}-1`, version: 1, revokedAt: null, origin,
  };
  state.trustSnapshots.push(snapshot);
  return snapshot;
}

export function currentTrustSnapshot(state: V2State, subjectId: string): TrustSnapshotV2 | null {
  const list = state.trustSnapshots.filter(t => t.subjectId === subjectId && !t.revokedAt);
  return list[list.length - 1] ?? null;
}

// v2.5：站内通知与业务变化同事务写入；新通知只带事件与对象 ID，读取仍按权限校验。
// 幂等：同一 objectId+userId+kind+body 只保留一条，避免轮询重复打扰。
export function pushNotification(
  state: V2State,
  entry: { userId: string; kind: NotificationKind; objectId: string; title: string; body: string },
  now: number,
): NotificationV2 {
  const existing = state.notifications.find(n =>
    n.userId === entry.userId && n.kind === entry.kind && n.objectId === entry.objectId && n.body === entry.body && n.readAt === null);
  if (existing) return existing;
  const notification: NotificationV2 = {
    id: `notice-${Math.random().toString(36).slice(2, 10)}`,
    userId: entry.userId, kind: entry.kind, objectId: entry.objectId,
    title: entry.title, body: entry.body, createdAt: now, readAt: null,
  };
  state.notifications.push(notification);
  return notification;
}

export function unreadNotificationsOf(state: V2State, userId: string): NotificationV2[] {
  return state.notifications.filter(n => n.userId === userId && n.readAt === null);
}

// v2.6：脱敏审计（不写联系方式、日记/举报原文、salt 或令牌）。
export function pushPrivacyAudit(
  state: V2State,
  entry: { actorId: string; actorRole: "user" | "admin"; action: string; targetType: string; targetId: string; result?: "ok" | "rejected" },
): void {
  state.privacyAudits.push({
    id: `paudit-${Math.random().toString(36).slice(2, 10)}`,
    actorId: entry.actorId, actorRole: entry.actorRole,
    action: entry.action, targetType: entry.targetType, targetId: entry.targetId,
    result: entry.result ?? "ok", at: Date.now(),
  });
  if (state.privacyAudits.length > 500) state.privacyAudits.splice(0, state.privacyAudits.length - 500);
}

export function relationshipStatusOf(state: V2State, userId: string): RelationshipStatus | "none" {
  const rel = activeRelationshipOf(state, userId);
  return rel ? rel.status : "none";
}
