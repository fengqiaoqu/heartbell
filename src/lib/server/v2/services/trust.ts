// 履约摘要服务（计划书 4.2/4.5 节）：受众绑定、版本化、撤销状态每次读取时校验。
import type { V2State } from "../../../repositories/demo-repo";
import { currentTrustSnapshot, latestEndedRelationship, refreshTrustSnapshot } from "../../../repositories/demo-repo";
import { computeTrust, trustReasonLabels } from "../../../domain/score";
import { forbidden } from "../errors";
import { canReadShared } from "../privacy-policy";
import type { TrustSnapshotV2 } from "../../../domain/v2-types";

// 受众读取：有效授权 + 未关闭连接 + 未被屏蔽；否则 FORBIDDEN（不泄露是否存在历史）。
export function readTrustForAudience(state: V2State, subjectId: string, audienceId: string, now: number): TrustSnapshotV2 {
  if (!canReadShared(state, subjectId, audienceId, "trust_summary", now)) {
    throw forbidden("目前未开放参考记录（未授权或授权已失效）");
  }
  const snapshot = currentTrustSnapshot(state, subjectId);
  if (!snapshot || snapshot.revokedAt) throw forbidden("目前未开放参考记录");
  return snapshot;
}

// 重新计算并生成新版本（结算/申诉变化后调用；旧版本撤销）。
export function refreshFor(state: V2State, subjectId: string, now: number): TrustSnapshotV2 {
  return refreshTrustSnapshot(state, subjectId, now);
}

// 摘要计算必须锁定"最近一段已结束关系"，不回退更早的高分关系。
export function previewTrust(state: V2State, subjectId: string, now: number) {
  const source = latestEndedRelationship(state, subjectId);
  return computeTrust(subjectId, source?.id ?? null, state.promises, now);
}

export { trustReasonLabels };
