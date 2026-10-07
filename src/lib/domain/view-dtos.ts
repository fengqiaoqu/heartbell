// 客户端可导入的视图 DTO（不含服务端秘密）。
import type {
  AnchorEvidence, AttachmentRef, CommitmentPlan, GoalClaim, LedgerEntry,
  RelationshipStatus, RewardChoice, RunModes, ShareGrantV2, TimelineKind,
  TrustSnapshotV2, VerificationLevel, Intention, PromiseResolutionResult, Benefit,
  Orientation, SpaceSettings, V2Profile, NotificationV2,
} from "./v2-types";

export interface ModesDto extends RunModes { virtualNow: number; realNow: number }

// v2.5：后台功能配置与公告（仅公开开关与文案，不含内部配置细节）。
export interface PublicMaintenanceDto {
  notice: string;
  radarNewEnabled: boolean;
  planNewEnabled: boolean;
  anchorSubmitEnabled: boolean;
  configVersion: number;
}

export type NotificationDto = NotificationV2;

export interface MeetDto {
  radarActive: boolean;
  radarExpiresAt: number | null;
  myTraits: { category: string; value: string }[];
  zoneLabel: string;
  blockedByRelationship: boolean;
  nearby: { userId: string; traits: { category: string; value: string }[]; bio: string }[]; // 匿名 + 一句话介绍（最小资料）
  bells: { id: string; from: string; to: string; message: string; status: string; createdAt: number; anonymous: boolean }[];
  ringRoundUsed: boolean;
  waitingEcho: boolean;
}

export interface TrustCardDto {
  status: "grantable" | "granted" | "revoked" | "expired";
  summary: (TrustSnapshotV2 & { reasonLabel: string }) | null;
}

export interface PublicProfileDto {
  nickname: string;
  avatar: string;
  ageWindow: string;
  orientation: Orientation | null;
  orientationCustom: string | null; // 选“其他”时的自由填写说明（v2.2）
  mbti: string | null;
  interests: string[];
  bio: string;
  intention: Intention;
  contacts: { label: string; value: string }[]; // 授权后单独返回，档案本身不含
}

export interface KnowConnectionDto {
  id: string;
  userId: string; // 已回响，可显示档案
  profile: PublicProfileDto | null;   // 揭晓后的资料（不含联系方式）
  intention: Intention | null;
  intentionLabel: string | null;
  appBindingStatus: "none" | "active" | "married";
  contacts: { label: string; value: string }[] | null; // 仅对方授权后返回
  trust: TrustCardDto;
  closed: boolean;
  createdAt: number;
}

export interface KnowDto {
  connections: KnowConnectionDto[];
  hasAnyEcho: boolean;
}

export interface RelationshipDto {
  id: string;
  status: RelationshipStatus;
  members: string[];
  nicknameOf: Record<string, string | undefined>;
  proposedBy: string;
  inviteExpiresAt: number;
  startedAt: number | null;
  endedAt: number | null;
  marriedAt: number | null;
  termsVersion: string;
  spaceSettings: SpaceSettings; // v2.2：空间名称/主题/天数展示
}

export interface TimelineItemDto {
  id: string;
  type: "diary" | "milestone" | "promise" | "auto-milestone";
  title: string;
  subtitle: string;
  dateLabel: string;
  sortAt: number;
  statusText: string;
  needsMyAction: boolean;
  anchor: AnchorEvidence | null;
  confirmSummary: string;
}

export interface DiaryDetailDto {
  id: string;
  currentVersion: number;
  versions: {
    version: number;
    kind: TimelineKind;
    date: string;
    title: string;
    body: string;
    attachments: AttachmentRef[];
    author: string;
    status: string;
    confirmations: Record<string, number>;
    returnedBy: string | null;
    returnedNote: string | null;
  }[];
  anchor: AnchorEvidence | null;
  anchoredVersion: number | null;
}

// v2.7：已结束关系的只读归档列表（双方共同确认过的版本；可逐条点开查看）。
export interface ArchiveSummaryDto {
  relationshipId: string;
  endedAt: number | null;
  total: number;
  items: {
    id: string;
    kind: "diary" | "milestone";
    title: string;
    date: string;
    status: string;
    versionCount: number;
    latestVersion: number;
    anchored: boolean;
  }[];
}

export interface PromiseDetailDto {
  id: string;
  content: string;
  responsibleUserIds: string[];
  dueAt: number;
  criteria: string;
  scoringOptIn: boolean;
  attachments: AttachmentRef[]; // v2.5：承诺附件（png/jpg/pdf/md/word，含内容预览）
  status: string;
  revision: number;
  confirmations: Record<string, number>;
  resolutions: Record<string, { result: PromiseResolutionResult; note: string | null; settledAt: number | null; confirmedBy: string[] }>;
  anchor: AnchorEvidence | null; // v2.2：承诺生效/结算的存证状态
}

export interface UsDto {
  relationship: RelationshipDto | null;
  incomingInvite: RelationshipDto | null;
  outgoingInvite: RelationshipDto | null;
  daysTogether: number | null;
  nextAnniversaryInDays: number | null;
  timeline: TimelineItemDto[];
  promises: PromiseDetailDto[];
  archives: { id: string; endedAt: number | null; partnerLabel: string; timelineCount: number }[];
  scoringUsage: { used: number; max: number; todayNew: number };
}

export interface PlanDto {
  plan: (CommitmentPlan & {
    members: string[];
    nicknameOf: Record<string, string | undefined>;
    claim: GoalClaim | null;
    benefit: Benefit | null;
    investedTotal: number;
    statusLabel: string;
  }) | null;
  eligible: boolean;
  blockingReason: string | null;
  rules: string[];
  myBalance: number;
  rewardPoolBalance: number;
  roseStock: number;
}

export interface MeDto {
  id: string;
  profile: V2Profile;
  adultDeclared: boolean;
  verificationLevels: VerificationLevel[];
  balance: number;
  roseTickets: number;
  grantsIssued: (ShareGrantV2 & { audienceLabel: string; scopeLabel: string; active: boolean })[];
  ledger: LedgerEntry[];
}

export interface V2StateView {
  modes: ModesDto;
  publicMaintenance: PublicMaintenanceDto; // v2.5：功能暂停与公告（后台发布）
  notifications: NotificationDto[];        // v2.5：未读站内提醒（待确认/核验结论）
  me: MeDto;
  meet: MeetDto;
  know: KnowDto;
  us: UsDto;
  future: PlanDto;
}
