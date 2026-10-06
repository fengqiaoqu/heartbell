// V2 演示仓库：内存实现，重启清空（P0 明确标注的本地演示）。
// 语义对齐计划书 10.1 数据对象；P1 由 Postgres 实现同一接口语义。
import { createHash } from "node:crypto";
import type {
  AnchorJob, BellV2, Benefit, CommitmentPlan, ConnectionV2, DiaryDoc,
  DisputeV2, GoalClaim, LedgerEntry, PromiseDoc, RadarStateV2,
  RelationshipStatus, RewardReservation, ShareGrantV2, TrustSnapshotV2, V2Relationship, V2User,
} from "../domain/v2-types";
import { INVEST_PER_USER, PLAN_TERMS_VERSION, REWARD_POOL_START } from "../domain/plan-rules";
import { RELATIONSHIP_TERMS_VERSION } from "../domain/relationship";
import { defaultSpaceSettings } from "../domain/v2-types";
import { computeTrust } from "../domain/score";
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
  virtualOffsetMs: number;
}

export const DEMO_USER_IDS = ["a", "b"] as const;
// 演示图片库常量在 demo-images.ts（客户端安全），此处复用。
export function demoImageSha256(id: string): string {
  return "0x" + createHash("sha256").update(`heartbell-demo-photo:${id}`).digest("hex");
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function createDemoState(now: number): V2State {
  const state: V2State = {
    users: new Map(), radar: new Map(), bells: [], connections: [], shareGrants: [],
    relationships: [], diaries: [], promises: [], trustSnapshots: [], plans: [],
    ledger: [], reservations: [], claims: [], benefits: [], anchorJobs: [], disputes: [],
    virtualOffsetMs: 0,
  };
  state.users.set("a", {
    id: "a", kind: "demo", adultDeclared: false,
    profile: {
      nickname: "小铃", avatar: "def:coffee", ageWindow: "00后", orientation: "not_say", orientationCustom: null, mbti: "INFP",
      interests: ["咖啡", "音乐", "散步"], intention: "open",
      bio: "想认识一个愿意一起慢慢走的人。",
      contacts: [
        { id: "c-wechat", label: "微信", value: "demo-xiaoling" },
        { id: "c-phone", label: "手机号", value: "138****0001（演示）" },
      ],
    },
    verificationLevels: [
      { label: "钱包控制权已验证", verified: false },
      { label: "真人/身份核验", verified: false },
    ],
  });
  state.users.set("b", {
    id: "b", kind: "demo", adultDeclared: false,
    profile: {
      nickname: "阿响", avatar: "def:cat", ageWindow: "95后", orientation: "men", orientationCustom: null, mbti: "ISFJ",
      interests: ["猫咪", "音乐", "展览"], intention: "serious",
      bio: "慢热，但认真。想认真认识一个人。",
      contacts: [
        { id: "c-wechat", label: "微信", value: "demo-axiang" },
        { id: "c-phone", label: "手机号", value: "139****0002（演示）" },
      ],
    },
    verificationLevels: [
      { label: "钱包控制权已验证", verified: false },
      { label: "真人/身份核验", verified: false },
    ],
  });
  // 演示前史：b 的上一段已结束关系（虚构对象，卡片持续标注演示数据）。
  const exId = "fx-ex-of-b";
  state.users.set(exId, {
    id: exId, kind: "fixture", adultDeclared: true,
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
      returnedBy: null,
      resolutions: {
        b: { result: result as "fulfilled" | "unfulfilled", note: null, settledAt: relEnd + 2 * DAY, confirmedBy: ["b", exId] },
        [exId]: { result: "waived", note: null, settledAt: relEnd + 2 * DAY, confirmedBy: ["b", exId] },
      },
      anchor: null, previousVersionCommitment: null,
    });
  }
  // 初始演示点数：系统发放，账本可追溯。
  for (const uid of DEMO_USER_IDS) {
    state.ledger.push({
      id: `ledger-initial-${uid}`, from: "system:mint", to: `user:${uid}`,
      amount: 1000, unit: "demo-point", businessKey: `initial-grant:${uid}`,
      type: "grant", note: "演示点数初始发放（不可购买/转让/提现）", createdAt: now,
    });
  }
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

export function relationshipStatusOf(state: V2State, userId: string): RelationshipStatus | "none" {
  const rel = activeRelationshipOf(state, userId);
  return rel ? rel.status : "none";
}
