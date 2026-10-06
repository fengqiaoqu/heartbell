// 我们：日记版本、双方确认与承诺履约（计划书第 5 节 / 4.3 节）。
// v2.5：日记/纪念日/承诺支持附件上传（png/jpg/pdf/md/word）；待确认事项向对方发送站内提醒。
import type { V2State } from "../../../repositories/demo-repo";
import { activeRelationshipOf, latestEndedRelationship, pushNotification } from "../../../repositories/demo-repo";
import { badRequest, conflict, forbidden, notFound, versionConflict } from "../errors";
import { MAX_SCORING_PER_DAY, MAX_SCORING_PROMISES } from "../../../domain/score";
import { enqueueAnchor } from "./anchor";
import { resolveAttachments } from "../attachments";
import { assertPairCanInteract, visibleDiaryVersions } from "../privacy-policy";
import { refreshFor } from "./trust";
import type { AnchorEvidence, AnchorJob, DiaryDoc, PromiseDoc, PromiseResolutionResult, RecordVersion } from "../../../domain/v2-types";
import { RELATIONSHIP_TERMS_VERSION } from "../../../domain/relationship";

const HOUR = 3_600_000;

function anchorEvidenceFromJob(job: AnchorJob): AnchorEvidence {
  return {
    jobId: job.id, commitment: job.commitment, chainStatus: job.status,
    txHash: job.txHash, blockNumber: job.blockNumber,
    networkLabel: job.chainMode === "preview" ? "preview（未连接真实链）" : job.chainMode,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

// v2.2 需求 8：承诺履约全部结算（完成/失败/豁免）后，为结算结果生成存证任务（版本 2）。
// 幂等：同一承诺同一版本只锚定一次；争议复核改写结果后锚定版本 3，保留原版本依据。
export function maybeAnchorPromiseSettlement(state: V2State, doc: PromiseDoc, now: number, contentVersion = 2): void {
  if (doc.status !== "active") return;
  const settled = doc.responsibleUserIds.every(uid => {
    const r = doc.resolutions[uid];
    return !!r && ["fulfilled", "unfulfilled", "waived"].includes(r.result) && r.settledAt !== null;
  });
  if (!settled) return;
  const rel = state.relationships.find(r => r.id === doc.relationshipId);
  if (!rel) return;
  const previousCommitment = doc.anchor?.commitment ?? null;
  const job = enqueueAnchor(state, "promise", doc.id, contentVersion, {
    recordType: "promise", recordId: doc.id, version: contentVersion,
    relationshipId: doc.relationshipId,
    businessOccurredAt: new Date(now).toISOString(),
    previousVersionCommitment: previousCommitment,
    participants: [...rel.members],
    content: {
      phase: contentVersion >= 3 ? "settled_after_review" : "settled",
      content: doc.content,
      results: Object.fromEntries(doc.responsibleUserIds.map(uid => [
        uid,
        {
          result: doc.resolutions[uid].result,
          note: doc.resolutions[uid].note,
          settledAt: doc.resolutions[uid].settledAt ? new Date(doc.resolutions[uid].settledAt!).toISOString() : null,
          confirmedBy: [...doc.resolutions[uid].confirmedBy],
        },
      ])),
    },
    attachmentHashes: [], rulesVersion: RELATIONSHIP_TERMS_VERSION,
  }, now);
  doc.previousVersionCommitment = previousCommitment;
  doc.anchor = anchorEvidenceFromJob(job);
}

function memberRelationship(state: V2State, viewer: string, relationshipId: unknown) {
  const rel = state.relationships.find(r => r.id === relationshipId && r.members.includes(viewer));
  if (!rel) throw forbidden("只有关系成员可以操作关系空间");
  return rel;
}

function findDiary(state: V2State, viewer: string, diaryId: unknown): DiaryDoc {
  if (typeof diaryId !== "string") throw badRequest("无效日记 ID");
  const diary = state.diaries.find(d => d.id === diaryId);
  if (!diary) throw notFound("日记不存在");
  memberRelationship(state, viewer, diary.relationshipId);
  return diary;
}

export function currentVersion(doc: DiaryDoc): RecordVersion {
  return doc.versions[doc.versions.length - 1];
}

function parseDateNotFuture(value: unknown, now: number): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest("日期格式应为 YYYY-MM-DD");
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) throw badRequest("日期无效");
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  if (time > today.getTime()) throw badRequest("历史事件的日期不能晚于今天");
  return value;
}

// v2.5：附件 = 演示图片库选择 + 本地上传（png/jpg/pdf/md/word），统一走 resolveAttachments 校验。

// 创建日记：私人草稿仅作者可见；shared 需对方确认同一版本。
export function createDiary(state: V2State, viewer: string, input: Record<string, unknown>, now: number): string {
  const rel = activeRelationshipOf(state, viewer);
  if (!rel) throw forbidden("确认关系后才能共同写日记");
  assertPairCanInteract(state, rel.members[0], rel.members[1]); // v2.6：屏蔽期间冻结新的共享写入
  const kind = input.kind === "milestone" ? "milestone" : "diary";
  const date = parseDateNotFuture(input.date, now);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (title.length < 1 || title.length > 40) throw badRequest("标题 1–40 字");
  if (body.length < 1 || body.length > 3000) throw badRequest("正文 1–3000 字");
  const attachments = resolveAttachments(input, []);
  const visibility = input.visibility === "draft" ? "draft" : "shared";
  const doc: DiaryDoc = {
    id: `diary-${Math.random().toString(36).slice(2, 10)}`,
    relationshipId: rel.id, createdAt: now,
    versions: [{
      version: 1, kind, date, title, body, attachments,
      author: viewer, createdAt: now, visibility,
      status: visibility === "draft" ? "draft" : "awaiting",
      confirmations: visibility === "draft" ? {} : { [viewer]: { at: now } },
      returnedBy: null, returnedNote: null,
    }],
    anchor: null, anchoredVersion: null,
  };
  state.diaries.push(doc);
  if (visibility === "shared") notifyAwaitingDiary(state, rel.members, viewer, doc, now);
  return doc.id;
}

// v2.5（反馈 4）：出现“等待对方确认”的日记时向对方发送站内提醒。
function notifyAwaitingDiary(state: V2State, members: readonly string[], author: string, doc: DiaryDoc, now: number): void {
  const version = currentVersion(doc);
  for (const uid of members) {
    if (uid === author) continue;
    pushNotification(state, {
      userId: uid, kind: "diary_awaiting", objectId: doc.id,
      title: "有一页日记等你确认",
      body: `「${version.title}」已写下，确认后这一版才会共同生效。`,
    }, now);
  }
}

// 修改生成新版本并重新确认；旧确认不复用。expectedVersion 乐观并发。
export function addDiaryVersion(state: V2State, viewer: string, input: Record<string, unknown>, now: number): number {
  const doc = findDiary(state, viewer, input.diaryId);
  if (input.expectedVersion !== doc.versions.length) {
    throw versionConflict("对方刚刚修改了这一页，请重新阅读最新版本后再修改。");
  }
  const prev = currentVersion(doc);
  // 旧版本保留为历史；当前版本 = 最后一个，旧确认不复用。
  const date = parseDateNotFuture(input.date, now);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (title.length < 1 || title.length > 40) throw badRequest("标题 1–40 字");
  if (body.length < 1 || body.length > 3000) throw badRequest("正文 1–3000 字");
  const attachments = resolveAttachments(input, prev.attachments);
  const visibility = input.visibility === "draft" ? "draft" : "shared";
  doc.versions.push({
    version: doc.versions.length + 1, kind: prev.kind, date, title, body, attachments,
    author: viewer, createdAt: now, visibility,
    status: visibility === "draft" ? "draft" : "awaiting",
    confirmations: visibility === "draft" ? {} : { [viewer]: { at: now } },
    returnedBy: null, returnedNote: null,
  });
  if (visibility === "shared") {
    const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
    notifyAwaitingDiary(state, rel.members, viewer, doc, now);
  }
  return doc.versions.length;
}

// 把草稿发给对方（进入 awaiting，作者自动确认这一版本）。
export function shareDraft(state: V2State, viewer: string, diaryId: unknown, now: number): void {
  const doc = findDiary(state, viewer, diaryId);
  const version = currentVersion(doc);
  if (version.author !== viewer) throw forbidden("只有作者可以发送草稿");
  if (version.visibility !== "draft") throw conflict("VERSION_STATE", "这一页不在草稿状态");
  version.visibility = "shared";
  version.status = "awaiting";
  version.confirmations[viewer] = { at: now };
  const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
  notifyAwaitingDiary(state, rel.members, viewer, doc, now);
}

// 确认绑定具体版本：只对当前版本有效。
export function confirmDiaryVersion(state: V2State, viewer: string, diaryId: unknown, now: number): void {
  const doc = findDiary(state, viewer, diaryId);
  const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
  assertPairCanInteract(state, rel.members[0], rel.members[1]); // v2.6：屏蔽期间冻结确认
  const version = currentVersion(doc);
  if (version.visibility === "draft") throw forbidden("私人草稿不需要对方确认");
  if (version.status !== "awaiting") throw conflict("VERSION_STATE", "这一页当前状态不可确认");
  if (version.confirmations[viewer]) throw conflict("ALREADY_CONFIRMED", "你已经确认过这一版本");
  version.confirmations[viewer] = { at: now };
  if (Object.keys(version.confirmations).length >= 2) version.status = "confirmed";
}

export function returnDiaryVersion(state: V2State, viewer: string, diaryId: unknown, note: unknown): void {
  const doc = findDiary(state, viewer, diaryId);
  const version = currentVersion(doc);
  if (version.status !== "awaiting") throw conflict("VERSION_STATE", "只有待确认的版本可以退回");
  version.status = "returned";
  version.returnedBy = viewer;
  version.returnedNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 120) : null;
}

export function withdrawDiary(state: V2State, viewer: string, diaryId: unknown): void {
  const doc = findDiary(state, viewer, diaryId);
  const version = currentVersion(doc);
  if (version.status !== "awaiting") throw conflict("VERSION_STATE", "只有待确认的版本可以撤回");
  if (version.author !== viewer) throw forbidden("只有作者可以撤回");
  version.status = "withdrawn";
}

// 存证：需要双方确认同一版本；commitment 服务端生成，不接受客户端指定。
export function anchorDiary(state: V2State, viewer: string, diaryId: unknown, now: number): void {
  const doc = findDiary(state, viewer, diaryId);
  const version = currentVersion(doc);
  if (version.status !== "confirmed") throw conflict("CONSENT_REQUIRED", "需要双方确认这一版本后才能存证");
  const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
  const job = enqueueAnchor(state, "diary", doc.id, version.version, {
    recordType: "diary",
    recordId: doc.id,
    version: version.version,
    relationshipId: doc.relationshipId,
    businessOccurredAt: new Date(version.createdAt).toISOString(),
    previousVersionCommitment: doc.anchor?.commitment ?? null,
    participants: [...rel.members],
    content: { kind: version.kind, date: version.date, title: version.title, body: version.body },
    attachmentHashes: version.attachments.map(a => a.sha256),
    rulesVersion: RELATIONSHIP_TERMS_VERSION,
  }, now);
  doc.anchor = {
    jobId: job.id, commitment: job.commitment, chainStatus: job.status,
    txHash: job.txHash, blockNumber: job.blockNumber,
    networkLabel: job.chainMode === "preview" ? "preview（未连接真实链）" : job.chainMode,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
  doc.anchoredVersion = version.version;
}

// v2.6：详情按版本裁剪 —— 私人草稿、对方撤回的版本、屏蔽/结束后未共同确认的共享版本
// 不再返回（读取矩阵 4.1；DTO 不携带原始 doc）。存证信息绑定已确认版本，双方归档可读。
export function getDiaryDetail(state: V2State, viewer: string, diaryId: unknown) {
  const doc = findDiary(state, viewer, diaryId);
  const versions = visibleDiaryVersions(state, doc, viewer);
  return {
    id: doc.id,
    currentVersion: versions.length ? versions[versions.length - 1].version : 0,
    versions: versions.map(v => ({
      version: v.version, kind: v.kind, date: v.date, title: v.title, body: v.body,
      attachments: v.attachments, author: v.author, status: v.status,
      confirmations: v.confirmations, returnedBy: v.returnedBy, returnedNote: v.returnedNote,
    })),
    anchor: doc.anchor,
    anchoredVersion: doc.anchoredVersion,
  };
}

// ---------- 承诺 ----------

const forbiddenPromisePatterns = ["永不分手", "不许分手", "不能分手", "密码", "定位", "借钱", "发生关系", "亲密行为", "性行为"];

export function createPromise(state: V2State, viewer: string, input: Record<string, unknown>, now: number): string {
  const rel = activeRelationshipOf(state, viewer);
  if (!rel) throw forbidden("确认关系后才能共同立下承诺");
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const criteria = typeof input.criteria === "string" ? input.criteria.trim() : "";
  if (content.length < 4 || content.length > 80) throw badRequest("承诺内容 4–80 字");
  if (criteria.length < 2 || criteria.length > 60) throw badRequest("验收方式 2–60 字");
  for (const pattern of forbiddenPromisePatterns) {
    if (content.includes(pattern)) throw badRequest("该承诺限制人身选择或难以客观判定，不能立下（如涉及分手自由、隐私、金钱或亲密行为）");
  }
  const dueAt = typeof input.dueAt === "number" ? input.dueAt : Date.parse(String(input.dueAt));
  if (!Number.isFinite(dueAt)) throw badRequest("请选择截止日期");
  if (dueAt <= now) throw badRequest("截止日期必须在未来");
  const responsible = input.responsible === "both" ? [...rel.members] : [viewer];
  const scoringOptIn = input.scoringOptIn === true;
  if (scoringOptIn) {
    if (dueAt - now < 24 * HOUR) throw badRequest("计分承诺必须在截止前至少 24 小时创建");
    const scoring = state.promises.filter(p => p.relationshipId === rel.id && p.scoringOptIn && p.status !== "returned");
    if (scoring.length >= MAX_SCORING_PROMISES) throw badRequest(`每段关系最多 ${MAX_SCORING_PROMISES} 项计分承诺`);
    const todayKey = new Date(now).toISOString().slice(0, 10);
    const todayCount = scoring.filter(p => new Date(p.createdAt).toISOString().slice(0, 10) === todayKey).length;
    if (todayCount >= MAX_SCORING_PER_DAY) throw badRequest("每个自然日最多新增 1 项计分承诺");
  }
  const doc: PromiseDoc = {
    id: `promise-${Math.random().toString(36).slice(2, 10)}`,
    relationshipId: rel.id, revision: 1, content,
    responsibleUserIds: responsible, dueAt, criteria, scoringOptIn,
    attachments: resolveAttachments(input, []), // v2.5：承诺附件（png/jpg/pdf/md/word）
    createdAt: now, status: "proposed", confirmations: { [viewer]: now },
    returnedBy: null,
    resolutions: Object.fromEntries(responsible.map(uid => [uid, { result: "pending", note: null, settledAt: null, confirmedBy: [] }])),
    anchor: null, previousVersionCommitment: null,
  };
  state.promises.push(doc);
  // v2.5（反馈 4）：承诺提案向待确认方发送提醒。
  for (const uid of rel.members) {
    if (uid === viewer) continue;
    pushNotification(state, {
      userId: uid, kind: "promise_awaiting", objectId: doc.id,
      title: "有一个承诺等你确认",
      body: `「${content.slice(0, 24)}」等待你的确认，确认后承诺生效。`,
    }, now);
  }
  return doc.id;
}

function findPromise(state: V2State, viewer: string, promiseId: unknown): PromiseDoc {
  if (typeof promiseId !== "string") throw badRequest("无效承诺 ID");
  const doc = state.promises.find(p => p.id === promiseId);
  if (!doc) throw notFound("承诺不存在");
  memberRelationship(state, viewer, doc.relationshipId);
  return doc;
}

export function confirmPromise(state: V2State, viewer: string, promiseId: unknown, expectedRevision: unknown, now: number): void {
  const doc = findPromise(state, viewer, promiseId);
  if (expectedRevision !== doc.revision) throw versionConflict("承诺已更新，请重新阅读。");
  if (doc.status !== "proposed") throw conflict("PROMISE_STATE", "承诺当前状态不可确认");
  doc.confirmations[viewer] = now;
  const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
  if (rel.members.every(m => doc.confirmations[m])) {
    doc.status = "active";
    // v2.2：承诺经双方确认生效（“立下”）即生成存证任务，与关系建立/计划条款同轨。
    const job = enqueueAnchor(state, "promise", doc.id, 1, {
      recordType: "promise", recordId: doc.id, version: 1,
      relationshipId: doc.relationshipId,
      businessOccurredAt: new Date(now).toISOString(),
      previousVersionCommitment: null,
      participants: [...rel.members],
      content: {
        phase: "activated",
        content: doc.content, criteria: doc.criteria,
        dueAt: new Date(doc.dueAt).toISOString(),
        responsibleUserIds: [...doc.responsibleUserIds], scoringOptIn: doc.scoringOptIn,
        confirmedAt: { ...doc.confirmations },
      },
      attachmentHashes: doc.attachments.map(a => a.sha256), rulesVersion: RELATIONSHIP_TERMS_VERSION,
    }, now);
    doc.anchor = anchorEvidenceFromJob(job);
    doc.previousVersionCommitment = null;
  }
}

export function returnPromise(state: V2State, viewer: string, promiseId: unknown): void {
  const doc = findPromise(state, viewer, promiseId);
  if (doc.status !== "proposed") throw conflict("PROMISE_STATE", "只有提案中的承诺可以退回");
  doc.status = "returned";
  doc.returnedBy = viewer;
}

// 责任人提交履约结果（fulfilled 需对方对同一证据确认；unfulfilled 本人确认即成立）。
export function recordResolution(state: V2State, viewer: string, promiseId: unknown, input: Record<string, unknown>, now: number): void {
  const doc = findPromise(state, viewer, promiseId);
  if (doc.status !== "active") throw conflict("PROMISE_STATE", "承诺需要双方确认生效后才能记录结果");
  if (!doc.responsibleUserIds.includes(viewer)) throw forbidden("只有承诺责任人可以记录履约");
  const result = input.result === "fulfilled" ? "fulfilled" : input.result === "unfulfilled" ? "unfulfilled" : null;
  if (!result) throw badRequest("结果只能为已完成或未完成");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 120) : null;
  if (result === "fulfilled" && !note) throw badRequest("请填写履约证据说明（双方将对同一证据确认）");
  if (result === "unfulfilled") {
    // 本人确认未完成：立即进入计算。
    doc.resolutions[viewer] = { result: "unfulfilled", note, settledAt: now, confirmedBy: [viewer] };
    maybeAnchorPromiseSettlement(state, doc, now);
    maybeRefreshTrust(state, doc.relationshipId, now);
  } else {
    doc.resolutions[viewer] = { result: "pending", note, settledAt: null, confirmedBy: [viewer] };
    // v2.5（反馈 4）：提交履约证据后提醒对方确认。
    const rel = state.relationships.find(r => r.id === doc.relationshipId)!;
    for (const uid of rel.members) {
      if (uid === viewer) continue;
      pushNotification(state, {
        userId: uid, kind: "resolution_awaiting", objectId: doc.id,
        title: "有一份履约证据等你确认",
        body: `「${doc.content.slice(0, 24)}」的履约证据已提交，等待你的确认。`,
      }, now);
    }
  }
}

// 对方确认履约证据（fulfilled）或共同豁免（waived）。
export function confirmResolution(state: V2State, viewer: string, promiseId: unknown, subjectUserId: unknown, outcome: unknown, now: number): void {
  const doc = findPromise(state, viewer, promiseId);
  if (doc.status !== "active") throw conflict("PROMISE_STATE", "承诺未生效");
  if (typeof subjectUserId !== "string" || !doc.resolutions[subjectUserId]) throw badRequest("无效的责任对象");
  if (subjectUserId === viewer) throw badRequest("不能确认自己提交的证据");
  const resolution = doc.resolutions[subjectUserId];
  if (outcome === "waived") {
    // 双方同意撤回：所有责任人项从有效总数排除，保留版本依据。
    for (const uid of doc.responsibleUserIds) {
      doc.resolutions[uid] = { result: "waived", note: resolution.note, settledAt: now, confirmedBy: [...doc.responsibleUserIds] };
    }
    maybeAnchorPromiseSettlement(state, doc, now);
    maybeRefreshTrust(state, doc.relationshipId, now);
    return;
  }
  if (resolution.result !== "pending") throw conflict("RESOLUTION_STATE", "该履约记录当前不可确认");
  if ((resolution.confirmedBy?.length ?? 0) === 0) {
    throw conflict("RESOLUTION_STATE", "责任人尚未提交履约证据，暂不能确认");
  }
  if (outcome !== "fulfilled") throw badRequest("确认结果无效");
  resolution.result = "fulfilled";
  resolution.settledAt = now;
  resolution.confirmedBy.push(viewer);
  maybeAnchorPromiseSettlement(state, doc, now);
  maybeRefreshTrust(state, doc.relationshipId, now);
}

// 争议：单方指控不能直接扣分；进入 disputed，冻结分数并等待复核。
// v2.5：trust 争议必须指向单一责任人（subjectUserId），复核按责任人定向裁定。
export function disputePromiseResolution(state: V2State, viewer: string, promiseId: unknown, subjectUserId: unknown, now: number): void {
  const doc = findPromise(state, viewer, promiseId);
  if (typeof subjectUserId !== "string" || !doc.resolutions[subjectUserId]) throw badRequest("无效的责任对象");
  const resolution = doc.resolutions[subjectUserId];
  if (!["fulfilled", "unfulfilled"].includes(resolution.result)) throw conflict("RESOLUTION_STATE", "只有已结算的结果可以申诉");
  resolution.result = "disputed";
  resolution.settledAt = null;
  state.disputes.push({
    id: `dispute-${Math.random().toString(36).slice(2, 10)}`,
    targetType: "trust", targetId: doc.id, raisedBy: viewer,
    note: `承诺「${doc.content.slice(0, 20)}」的履约结果存在争议`, createdAt: now,
    resolvedAt: null, resolution: null, subjectUserId,
  });
  maybeRefreshTrust(state, doc.relationshipId, now);
}

// 已结束关系的结算变化 → 摘要生成新版本并撤销旧版本。
function maybeRefreshTrust(state: V2State, relationshipId: string, now: number): void {
  const rel = state.relationships.find(r => r.id === relationshipId);
  if (!rel || rel.status !== "ended") return;
  for (const member of rel.members) {
    const latest = latestEndedRelationship(state, member);
    if (latest?.id === relationshipId) refreshFor(state, member, now);
  }
}

// v2.5 定向复核（衔接缺口 2）：以 disputeId + subjectUserId 裁定单一责任人，
// 不再批量改写双方结果；复核后仅刷新受影响用户的摘要版本。
export function resolveTrustDisputeControlled(
  state: V2State,
  actor: string,
  disputeId: string,
  subjectUserId: string | null,
  finalResult: string,
  reason: string | null,
  now: number,
): { subject: string; result: string } {
  const dispute = state.disputes.find(d => d.id === disputeId && d.targetType === "trust" && !d.resolvedAt);
  if (!dispute) throw notFound("争议不存在或已处理");
  const doc = state.promises.find(p => p.id === dispute.targetId);
  if (!doc) throw notFound("承诺不存在");
  const subject = subjectUserId ?? dispute.subjectUserId;
  if (!subject || !doc.resolutions[subject]) throw badRequest("该争议未绑定有效责任人，不能裁定");
  if (!["fulfilled", "unfulfilled", "waived"].includes(finalResult)) throw badRequest("无效复核结论");
  doc.resolutions[subject] = {
    result: finalResult as "fulfilled",
    note: reason ?? doc.resolutions[subject]?.note ?? null,
    settledAt: now,
    confirmedBy: [actor],
  };
  doc.revision += 1;
  dispute.resolvedAt = now;
  dispute.resolution = `${finalResult}（责任人 ${subject}）`;
  // 复核结论改变结算结果 → 锚定新版本存证（版本 3，保留原结算版本）。
  maybeAnchorPromiseSettlement(state, doc, now, 3);
  const rel = state.relationships.find(r => r.id === doc.relationshipId);
  if (rel) refreshFor(state, subject, now); // 仅刷新受影响用户
  pushNotification(state, {
    userId: subject, kind: "claim_decision", objectId: doc.id,
    title: "履约争议复核完成",
    body: `「${doc.content.slice(0, 20)}」的复核结论：${finalResult === "fulfilled" ? "已履行" : finalResult === "unfulfilled" ? "未履行" : "双方豁免"}。`,
  }, now);
  return { subject, result: finalResult };
}
