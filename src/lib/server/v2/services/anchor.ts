// 存证服务：V2 承诺登记 outbox（计划书 9.6 节）。
// preview：不生成假交易哈希/假区块，仅保留本地承诺指纹（status=unconfigured）。
// 真实链：受控 writer 提交 + 服务端回执/事件/承诺核验（需配置密钥，本轮未部署）。
import { createHash } from "node:crypto";
import type { V2State } from "../../../repositories/demo-repo";
import { buildPayload, computeCommitment, newSalt, type CommitmentPayload } from "../../../chain/commitment";
import type { AnchorEvidence, AnchorJob, RecordType } from "../../../domain/v2-types";
import { runModes } from "../registry";
import { badRequest, forbidden } from "../errors";

const globals = globalThis as typeof globalThis & { heartbellChainFault?: boolean };
export function setChainFault(active: boolean): void { globals.heartbellChainFault = active; }
export function chainFaultActive(): boolean { return globals.heartbellChainFault === true; }

export function anchorEvidenceOf(job: AnchorJob, chainMode: string): AnchorEvidence {
  return {
    jobId: job.id, commitment: job.commitment, chainStatus: job.status,
    txHash: job.txHash, blockNumber: job.blockNumber,
    networkLabel: chainMode === "preview" ? "preview（未连接真实链）" : chainMode,
    error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

// 幂等入队：同一 (recordId, version) 只产生一个任务；重试恢复同一任务，不换承诺。
export function enqueueAnchor(
  state: V2State,
  recordType: RecordType,
  recordId: string,
  contentVersion: number,
  payload: Omit<CommitmentPayload, "schema">,
  now: number,
): AnchorJob {
  const existing = state.anchorJobs.find(j => j.recordId === recordId && j.contentVersion === contentVersion);
  if (existing) return existing;
  const salt = newSalt();
  const material = computeCommitment(buildPayload(payload), salt);
  const job: AnchorJob = {
    id: `anchor-${Math.random().toString(36).slice(2, 10)}`,
    recordType, recordId, contentVersion,
    commitment: material.commitment, salt: material.salt, payloadJson: material.payloadJson,
    chainMode: "preview", status: "queued",
    txHash: null, blockNumber: null, error: null, attempts: 0,
    createdAt: now, updatedAt: now,
  };
  state.anchorJobs.push(job);
  // v2.5：后台暂停存证提交时，任务保留排队（内容与承诺不丢），恢复后由运维重试提交。
  if (!state.featureConfig.anchorSubmitEnabled) {
    job.error = "存证提交维护中：任务已排队，恢复后由运维在后台重试（内容未丢失）。";
    return job;
  }
  processJob(state, job, now);
  return job;
}

export function retryAnchor(state: V2State, viewer: string, recordId: unknown, now: number): AnchorJob {
  if (typeof recordId !== "string") throw badRequest("无效记录 ID");
  const job = state.anchorJobs.find(j => j.recordId === recordId);
  if (!job) throw badRequest("找不到存证任务");
  // 记录归属校验：payload 中 participants 必须包含当前用户（私人证据不出域）。
  const payload = JSON.parse(job.payloadJson) as CommitmentPayload;
  if (!payload.participants.includes(viewer)) throw forbidden("只有记录参与者可以重试存证");
  if (job.status === "confirmed" || job.status === "unconfigured") return job;
  processJob(state, job, now);
  return job;
}

// v2.5 后台精确重试：按 jobId + contentVersion 定位（不沿用 recordId 取第一个任务）。
// failed/reorged 可重试；queued（暂停期间排队）恢复提交；submitted 仅查询；
// confirmed 禁止重发；unconfigured 展示配置缺口，不允许“标记成功”。
export function retryAnchorJob(state: V2State, jobId: string, now: number): AnchorJob {
  const job = state.anchorJobs.find(j => j.id === jobId);
  if (!job) throw badRequest("找不到存证任务");
  if (job.status === "confirmed") throw badRequest("该任务已确认，禁止重发");
  if (job.status === "unconfigured") throw badRequest("预览模式未配置真实链：任务保留本地指纹，无需也无法重试");
  if (job.status === "submitted") return job; // 先查回执；演示环境无 worker，保持现状
  processJob(state, job, now);
  return job;
}

function processJob(state: V2State, job: AnchorJob, now: number): void {
  void state;
  job.attempts += 1;
  job.updatedAt = now;
  if (chainFaultActive()) {
    job.status = "failed";
    job.error = "模拟链故障：交易写入失败。可稍后在“查看证据”中重试，已确认的内容不受影响。";
    return;
  }
  const modes = runModes();
  job.chainMode = modes.chainMode;
  if (modes.chainMode === "preview") {
    // 诚实状态：未配置真实链。不生成假 txHash / 区块高度 / 浏览器链接。
    job.status = "unconfigured";
    job.error = "预览模式：未配置真实链，仅保存本地承诺指纹（salt 私有保存，未发送任何交易）。";
    return;
  }
  // 真实链模式：需要 writer 密钥；缺失时明确配置错误，不假成功。
  if (!process.env.CHAIN_WRITER_PRIVATE_KEY) {
    job.status = "failed";
    job.error = "CHAIN_MODE 已配置真实链，但 CHAIN_WRITER_PRIVATE_KEY 未配置：无法提交交易。";
    return;
  }
  try {
    const result = submitToRegistry(job.commitment);
    job.status = "confirmed";
    job.txHash = result.txHash;
    job.blockNumber = result.blockNumber;
    job.error = null;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "链上提交失败";
  }
}

// 真实提交路径（计划书 9.6/9.7）。本轮未部署、未发送真实交易 —— 待接入项。
// 接入时：createPublicClient(http(CHAIN_RPC_URL)) 模拟执行 record(commitment) →
// 受控 writer 发送 → waitForTransactionReceipt → 校验链 ID、回执 status、to 为
// 配置合约、事件 CommitmentRecorded(commitment) 由该合约发出、必要时 readContract
// recordedAt 对照。客户端上报的哈希不可直接采信。
function submitToRegistry(_commitment: string): { txHash: string; blockNumber: number } {
  throw new Error("真实链提交尚未接入：合约未部署（见 docs/V2-IMPLEMENTATION.md 待接入项）。");
}

// 本地核验（T13）：按同一协议重算承诺，改一字/一图/一个 salt 字节都不匹配。
export function verifyCommitmentLocally(payloadJson: string, salt: string, commitment: string): boolean {
  const digest = createHash("sha256").update(payloadJson, "utf8").digest();
  const saltBytes = Buffer.from(salt.slice(2), "hex");
  if (saltBytes.length !== 32) return false;
  const prefix = Buffer.concat([Buffer.from("HEARTBELL_V2", "utf8"), Buffer.from([0])]);
  const recomputed = "0x" + createHash("sha256").update(Buffer.concat([prefix, saltBytes, digest])).digest("hex");
  return recomputed === commitment;
}

// 证据包导出（计划书 9.8）：原 payload、salt、anchor 信息；含隐私数据，短期有效由调用方提示。
export function exportEvidence(state: V2State, viewer: string, recordId: unknown) {
  if (typeof recordId !== "string") throw badRequest("无效记录 ID");
  const job = state.anchorJobs.find(j => j.recordId === recordId);
  if (!job) throw badRequest("该记录尚未生成存证任务");
  const payload = JSON.parse(job.payloadJson) as CommitmentPayload;
  if (!payload.participants.includes(viewer)) throw forbidden("只有记录参与者可以导出证据包");
  const relation = state.relationships.find(r => r.id === payload.relationshipId);
  const memberOfRelation = relation?.members.includes(viewer) ?? false;
  const trustSnapshotExport = job.recordType === "trust_snapshot";
  if (!memberOfRelation && !trustSnapshotExport) throw forbidden("只有记录参与者可以导出证据包");
  return {
    schema: "heartbell.evidence.v2",
    record: { recordType: job.recordType, recordId: job.recordId, version: job.contentVersion },
    payload: JSON.parse(job.payloadJson),
    salt: job.salt,
    commitment: job.commitment,
    anchor: {
      chainMode: job.chainMode, status: job.status, txHash: job.txHash,
      blockNumber: job.blockNumber, contract: process.env.NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS ?? null,
      network: job.chainMode === "preview" ? "preview（未连接真实链）" : job.chainMode,
    },
    verification: {
      protocol: "SHA256(UTF8('HEARTBELL_V2\\0') || salt(32B) || SHA256(UTF8(JCS(payload))))",
      note: "包内含隐私数据（原文与 salt），仅自行保存；缺原文或 salt 将无法核验。preview 模式无链上记录。",
    },
  };
}
