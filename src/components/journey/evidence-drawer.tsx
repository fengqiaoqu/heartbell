"use client";
// 查看证据抽屉（计划书 7.5）：交易哈希、合约、网络与签名细节放这里，主流程用日常语言。
import { useState } from "react";
import { Modal } from "../modal";
import { Button, Chip, anchorStatusChip } from "../ui";
import type { AnchorEvidence } from "../../lib/domain/v2-types";

export function EvidenceDrawer({
  open, onClose, anchor, businessStatus, sourceLabel, extraRows, onRetry, onExport,
}: {
  open: boolean; onClose: () => void;
  anchor: AnchorEvidence | null;
  businessStatus: string;
  sourceLabel: string;
  extraRows?: [string, string][];
  onRetry?: () => void;
  onExport?: () => void;
}) {
  const chip = anchorStatusChip(anchor?.chainStatus);
  if (!open) return null;
  return <Modal title="查看证据" onClose={onClose}>
    <div className="status-line">
      <Chip tone="brand">业务状态：{businessStatus}</Chip>
      <Chip tone={chip.tone}>存证状态：{chip.label}</Chip>
      <Chip tone="outline">来源：{sourceLabel}</Chip>
    </div>
    <div className="evidence-rows">
      <div className="row"><b>承诺指纹</b><span className="mono">{anchor?.commitment ?? "尚未生成（未申请存证）"}</span></div>
      <div className="row"><b>网络</b><span>{anchor?.networkLabel ?? "—"}</span></div>
      <div className="row"><b>交易哈希</b><span className="mono">{anchor?.txHash ?? "无（未发送真实交易）"}</span></div>
      <div className="row"><b>区块高度</b><span>{anchor?.blockNumber ?? "—"}</span></div>
      {extraRows?.map(([k, v]) => <div className="row" key={k}><b>{k}</b><span>{v}</span></div>)}
      <div className="row"><b>登记时间</b><span>{anchor ? new Date(anchor.createdAt).toLocaleString("zh-CN") : "—"}</span></div>
    </div>
    {anchor?.error && <p className="muted" style={{ marginTop: 8 }}>{anchor.error}</p>}
    <p className="muted" style={{ marginTop: 8 }}>链上登记的是带独立随机秘密的内容承诺（commitment），不含日记正文、证件、参与者钱包或普通签名。preview 模式未连接真实链，不会生成模拟交易链接。</p>
    {onRetry && anchor?.chainStatus === "failed" && <Button className="secondary" onClick={onRetry}>重试存证（恢复同一任务）</Button>}
    {onExport && anchor && <Button className="ink" onClick={onExport}>导出证据包（含隐私数据，仅自行保存）</Button>}
  </Modal>;
}

export interface EvidenceTarget {
  anchor: AnchorEvidence | null;
  business: string;
  source: string;
  extra?: [string, string][];
  recordId?: string;
}
export function useEvidence(): { target: EvidenceTarget | null; open: (t: EvidenceTarget) => void; close: () => void } {
  const [target, setTarget] = useState<EvidenceTarget | null>(null);
  return { target, open: setTarget, close: () => setTarget(null) };
}
