// V2 领域类型：全链条恋爱产品的核心数据契约。
// 与 src/lib/types.ts 中的旧演示类型并行存在；旧类型服务于 /api/demo，不改动其含义。
// 领域层使用通用不透明用户 ID（string），"a"/"b" 仅供演示会话。

// ---------- 用户与档案 ----------

export type Intention = "serious" | "open" | "not_now"; // 认真恋爱 / 先认识再决定 / 暂不寻求稳定关系
export const intentionLabels: Record<Intention, string> = {
  serious: "认真恋爱",
  open: "先认识再决定",
  not_now: "暂不寻求稳定关系",
};

export type Orientation = "women" | "men" | "everyone" | "other" | "not_say";
export const orientationLabels: Record<Orientation, string> = {
  women: "喜欢女生",
  men: "喜欢男生",
  everyone: "都喜欢",
  other: "其他（自由填写）",
  not_say: "暂不说明",
};
// 性取向展示：选“其他”时拼接本人自由填写的说明（v2.2）。
export function orientationDisplay(orientation: Orientation | null, custom: string | null): string {
  if (!orientation) return "";
  if (orientation === "other") return custom?.trim() ? `其他：${custom.trim()}` : "其他";
  return orientationLabels[orientation];
}
export const mbtiOptions = ["INFP", "INFJ", "INTP", "INTJ", "ISFP", "ISFJ", "ISTP", "ISTJ", "ENFP", "ENFJ", "ENTP", "ENTJ", "ESFP", "ESFJ", "ESTP", "ESTJ"] as const;

// 出生年代（v2.2 起年龄窗口改为年代选择，不再填写具体年龄区间）。
export const ageCohorts = ["70后", "75后", "80后", "85后", "90后", "95后", "00后", "05后"] as const;
export type AgeCohort = (typeof ageCohorts)[number];

export interface ContactEntry {
  id: string;
  label: string; // 微信 / 手机号 / 自定义（≤5 栏）
  value: string;
}

export interface V2Profile {
  nickname: string;       // 称呼
  avatar: string;         // 头像：官方头像 id（def:xxx）/ 自由上传图片（data:image...）/ 历史表情符号
  ageWindow: string;      // 出生年代，如 "95后"（v2.2 起为年代选项，不再是年龄区间）
  orientation: Orientation | null; // 性取向（本人主动填写）
  orientationCustom: string | null; // 性取向选“其他”时的自由填写说明（≤12 字）
  mbti: string | null;
  interests: string[];    // 爱好标签
  bio: string;            // 一句话介绍（响铃阶段的最小资料）
  intention: Intention;
  contacts: ContactEntry[]; // 联系方式（默认微信/手机号，可添加），仅授权后对特定连接可见
}

export interface VerificationLevel { label: string; verified: boolean }

export interface V2User {
  id: string;
  kind: "demo" | "fixture"; // fixture = 演示前史虚构对象，不冒充真人
  profile: V2Profile;
  adultDeclared: boolean;
  verificationLevels: VerificationLevel[];
}

// ---------- 相遇 ----------

export type TraitCategory = "穿着" | "配饰" | "手持物" | "当前状态" | "其他";
export interface Trait { category: TraitCategory; value: string }

export interface RadarStateV2 {
  active: boolean;
  traits: Trait[];
  zone: string; // 演示街区标识，不是真实定位
  startedAt: number | null;
  expiresAt: number | null;
}

export type BellStatusV2 = "pending" | "accepted" | "dismissed" | "expired";
export interface BellV2 {
  id: string;
  from: string;
  to: string;
  message: string;
  status: BellStatusV2;
  createdAt: number;
}

export interface ConnectionV2 {
  id: string;
  members: [string, string];
  bellMessage: string;
  createdAt: number;
  closed: boolean;
  closedAt: number | null;
  closedBy: string | null;
}

// ---------- 授权 ----------

export type ShareScope = "profile_contact" | "trust_summary";
export const shareScopeLabels: Record<ShareScope, string> = {
  profile_contact: "交换联系方式",
  trust_summary: "查看履约摘要",
};

export interface ShareGrantV2 {
  id: string;
  ownerId: string;
  audienceId: string; // 受众必须是已回响连接的对方
  scope: ShareScope;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

// ---------- 关系 ----------

export type RelationshipStatus =
  | "proposed" | "active" | "married" | "ended"
  | "declined" | "cancelled" | "expired";

export const relationshipStatusLabels: Record<RelationshipStatus, string> = {
  proposed: "等待对方确认",
  active: "在一起",
  married: "已婚（应用内标记）",
  ended: "已结束",
  declined: "已婉拒",
  cancelled: "已取消",
  expired: "邀请已过期",
};

// 空间自定义（v2.2）：仅开放外观与展示项；计分规则、存证条款、对方资料不可自定义。
export type SpaceTheme = "peach" | "sakura" | "mint" | "amber" | "moon";
export const spaceThemeLabels: Record<SpaceTheme, string> = {
  peach: "蜜桃粉",
  sakura: "晚樱紫",
  mint: "薄荷绿",
  amber: "琥珀橙",
  moon: "月夜蓝",
};
export interface SpaceSettings {
  name: string;        // 空间名称（≤16 字，默认“我们的空间”）
  theme: SpaceTheme;   // 空间主题色
  showDays: boolean;   // 是否显示“在一起第 N 天”与纪念日倒计时
}
export const defaultSpaceSettings: SpaceSettings = { name: "我们的空间", theme: "peach", showDays: true };

export interface V2Relationship {
  id: string;
  members: [string, string];
  status: RelationshipStatus;
  proposedBy: string;
  consents: Record<string, boolean>;
  proposedAt: number;
  inviteExpiresAt: number;
  startedAt: number | null; // 双方接受时间
  endedAt: number | null;
  endedBy: string | null;
  marriedAt: number | null;
  termsVersion: string;
  archiveReason: string | null;
  spaceSettings: SpaceSettings; // v2.2：空间名称/主题/天数展示，双方可见，任一成员可改
}

// ---------- 日记与承诺（我们） ----------

export type TimelineKind = "diary" | "milestone";
export type AttachmentKind = "photo";

export interface AttachmentRef {
  id: string;       // 演示图片库中的固定 ID
  name: string;
  sha256: string;   // 演示库预置指纹（确定性，用于版本比较）
}

export type RecordVersionStatus = "draft" | "awaiting" | "confirmed" | "returned" | "withdrawn";

export interface RecordVersion {
  version: number;
  kind: TimelineKind;
  date: string; // YYYY-MM-DD，历史事件不得晚于今天
  title: string;
  body: string;
  attachments: AttachmentRef[];
  author: string;
  createdAt: number;
  visibility: "draft" | "shared";
  status: RecordVersionStatus;
  confirmations: Record<string, { at: number }>; // 成员 -> 确认时间；确认绑定具体版本
  returnedBy: string | null;
  returnedNote: string | null;
}

export interface AnchorEvidence {
  jobId: string;
  commitment: string;   // 0x + 64 hex，SHA-256(salt || JCS digest) 域分隔
  chainStatus: AnchorStatus;
  txHash: string | null;
  blockNumber: number | null;
  networkLabel: string; // 展示用网络名称或 "preview"
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AnchorStatus =
  | "not_requested" | "queued" | "submitted" | "confirmed"
  | "failed" | "reorged" | "unconfigured";

export interface DiaryDoc {
  id: string;
  relationshipId: string;
  createdAt: number;
  versions: RecordVersion[]; // 版本只追加；currentVersion = 最后一个
  anchor: AnchorEvidence | null; // 存证绑定已确认版本
  anchoredVersion: number | null;
}

export type PromiseResolutionResult = "pending" | "fulfilled" | "unfulfilled" | "disputed" | "waived";
export type PromiseStatus = "proposed" | "active" | "returned";

export interface PromiseDoc {
  id: string;
  relationshipId: string;
  revision: number; // 乐观并发版本
  content: string;
  responsibleUserIds: string[]; // 一方或双方
  dueAt: number;                // 截止时间（可在未来）
  criteria: string;             // 验收方式
  scoringOptIn: boolean;        // 是否计入履约参考
  createdAt: number;
  status: PromiseStatus;
  confirmations: Record<string, number>; // 成员 -> 确认时间
  returnedBy: string | null;
  resolutions: Record<string, { result: PromiseResolutionResult; note: string | null; settledAt: number | null; confirmedBy: string[] }>;
  anchor: AnchorEvidence | null;
  previousVersionCommitment: string | null;
}

// ---------- 履约摘要（了解） ----------

export interface TrustComputation {
  subjectId: string;
  sourceRelationId: string | null;
  s: number;          // fulfilled
  f: number;          // unfulfilled
  pending: number;    // pending + disputed 计入待结算
  disputed: number;
  waived: number;
  eligible: number;   // s + f + pending（waived 排除）
  settled: number;    // n = s + f
  coverage: number;   // settled / eligible
  score: number | null;
  reason: "ok" | "no_history" | "insufficient_sample" | "low_coverage" | "disputed_pending" | "active_only";
  algorithmVersion: string;
  asOf: number;
}

export interface TrustSnapshotV2 extends TrustComputation {
  id: string;
  version: number;
  revokedAt: number | null;
  origin: "demo" | "user"; // 演示 fixture 前史必须标注
}

// ---------- 相守计划 ----------

export type PlanStatus =
  | "draft" | "awaiting_partner" | "active" | "claim_review"
  | "approved" | "redeemable" | "settled"
  | "forfeit_pending" | "exception_review" | "cancelled" | "forfeited";

export const planStatusLabels: Record<PlanStatus, string> = {
  draft: "草稿",
  awaiting_partner: "等待对方加入",
  active: "进行中",
  claim_review: "达成核验中",
  approved: "已通过待争议期",
  redeemable: "可领取",
  settled: "已结算",
  forfeit_pending: "失效异议期",
  exception_review: "例外复核",
  cancelled: "已取消",
  forfeited: "已失效",
};

export type RewardChoice = "A" | "B"; // A=各50点奖励；B=共同99朵玫瑰演示券

export interface CommitmentPlan {
  id: string;
  relationshipId: string;
  status: PlanStatus;
  targetType: "marriage" | "anniversary";
  investPerUser: number;      // 演示点数，固定 100
  rewardChoice: RewardChoice;
  beneficiary: string | null; // 奖励 B 的领取人
  termsVersion: string;
  proposedBy: string;
  partnerConsent: boolean;
  invitedAt: number;
  inviteExpiresAt: number;
  activatedAt: number | null;
  coolingUntil: number | null;    // 激活后 24h
  expiresAt: number | null;       // 激活后 365d
  graceUntil: number | null;      // 到期后 30d 宽限
  revision: number;               // 乐观并发
  reservationId: string | null;
  forfeitWindowUntil: number | null; // 普通结束 7 天异议窗口
  endedReason: "cooling_cancel" | "normal_end" | "expired" | "exception" | null;
  anchor: AnchorEvidence | null;
}

export interface LedgerEntry {
  id: string;
  from: string;
  to: string;
  amount: number;             // 正整数
  unit: "demo-point" | "rose-ticket";
  businessKey: string;        // 幂等键：同一业务键唯一
  type: "grant" | "invest" | "refund" | "reward" | "forfeit" | "redeem";
  note: string;
  createdAt: number;
}

export interface RewardReservation {
  id: string;
  planId: string;
  kind: "points" | "rose_ticket";
  amount: number; // points=100 或 rose=1
  status: "reserved" | "consumed" | "released";
  createdAt: number;
}

export type ClaimStatus = "submitted" | "need_more" | "rejected" | "approved" | "frozen";

export interface GoalClaim {
  id: string;
  planId: string;
  submittedBy: string;
  targetOccurredAt: number;
  evidenceNote: string;
  isDemoMaterial: true; // P0 全部为演示材料
  status: ClaimStatus;
  submittedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  appealUntil: number | null;   // 审核通过后 7 天争议期
  dedupeToken: string;          // 同一计划去重
  reviewDeadlineAt: number | null; // 审核 7 天 / 补正 14 天
}

export interface Benefit {
  id: string;
  planId: string;
  kind: "points_each" | "rose_ticket";
  recipients: string[];   // points_each=双方；rose_ticket=[领取人]
  status: "redeemable" | "settled";
  createdAt: number;
  redeemedAt: number | null;
  idempotencyKey: string;
}

// ---------- 存证任务 ----------

export type RecordType =
  | "relationship_started" | "relationship_ended" | "diary"
  | "promise" | "trust_snapshot" | "plan_terms" | "claim_result" | "settlement";

export interface AnchorJob {
  id: string;
  recordType: RecordType;
  recordId: string;
  contentVersion: number;
  commitment: string;
  salt: string;      // 32 字节 hex，私有保存，不上链
  payloadJson: string; // 私有证据：JCS 规范化 payload
  chainMode: "preview" | "bot_testnet" | "bot_mainnet";
  status: AnchorStatus;
  txHash: string | null;
  blockNumber: number | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

// ---------- 申诉 ----------

export interface DisputeV2 {
  id: string;
  targetType: "plan" | "claim" | "trust";
  targetId: string;
  raisedBy: string;
  note: string;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

// ---------- 运行模式 ----------

export interface RunModes {
  appMode: "demo" | "live";
  chainMode: "preview" | "bot_testnet" | "bot_mainnet";
  rewardMode: "demo" | "partner";
  claimVerifierMode: "demo" | "manual" | "provider";
}

// ---------- 统一 API 响应 ----------

export interface ApiOk<T> { data: T; requestId: string; mode: RunModes }
export interface ApiErr { error: { code: string; message: string; retryable: boolean }; requestId: string }
export type ApiResult<T> = ApiOk<T> | ApiErr;
