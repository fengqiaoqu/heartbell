"use client";
// v2.5 附件上传（反馈 6）：日记/纪念日/承诺支持 png、jpg、pdf、md、word（doc/docx）。
// 客户端做格式与大小预检，服务端 resolveAttachments 再校验一遍（指纹、数量、类型）。
import { useRef, useState } from "react";
import {
  MAX_ATTACHMENTS_PER_RECORD, MAX_UPLOAD_ATTACHMENT_BYTES, uploadAttachmentAccept, uploadAttachmentExts, uploadAttachmentLabel,
} from "../lib/domain/v2-types";

export interface UploadedAttachment { name: string; dataUrl: string }

const allowedExts = new Set<string>(uploadAttachmentExts);

async function readAttachmentFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function AttachmentUploader({ files, onChange, extraCount = 0, label }: {
  files: UploadedAttachment[];
  onChange(files: UploadedAttachment[]): void;
  extraCount?: number;  // 已选择的演示图片等占位数量，合计不超过上限
  label?: string;
}) {
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = MAX_ATTACHMENTS_PER_RECORD - extraCount - files.length;

  async function addFiles(list: FileList | null) {
    setError("");
    if (!list?.length) return;
    const next: UploadedAttachment[] = [];
    for (const file of Array.from(list)) {
      const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
      if (!allowedExts.has(ext)) {
        setError(`「${file.name}」不支持的格式（支持 ${uploadAttachmentLabel}）`);
        continue;
      }
      if (file.size > MAX_UPLOAD_ATTACHMENT_BYTES) {
        setError(`「${file.name}」过大（单个 ≤ 600KB）`);
        continue;
      }
      // v2.7：remaining 已扣除已选数量（files.length + extraCount），
      // 此处只比较本次新加入数 —— 此前 files.length+next.length 与 remaining 相比，
      // 分批选择时剩余额度被重复扣减，第 4 个附件被误报“最多 6 个”。
      if (next.length >= remaining) {
        setError(`最多 ${MAX_ATTACHMENTS_PER_RECORD} 个附件（含演示图片）`);
        break;
      }
      try {
        const dataUrl = await readAttachmentFile(file);
        const mime = ext === "md" ? "text/markdown"
          : ext === "doc" ? "application/msword"
            : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : ext === "png" ? "image/png"
                : ext === "pdf" ? "application/pdf"
                  : "image/jpeg";
        next.push({ name: file.name, dataUrl: `data:${mime};base64,${dataUrl.slice(dataUrl.indexOf(",") + 1)}` });
      } catch {
        setError(`「${file.name}」读取失败`);
      }
    }
    if (next.length) onChange([...files, ...next]);
    if (inputRef.current) inputRef.current.value = "";
  }

  return <div>
    <label className="field-label">{label ?? `附件（可选，最多 ${MAX_ATTACHMENTS_PER_RECORD} 个 · ${uploadAttachmentLabel} · 单个 ≤600KB）`}</label>
    <div className="upload-row">
      <button type="button" className="text-button" onClick={() => inputRef.current?.click()} disabled={remaining <= 0}>
        {remaining <= 0 ? "附件已满" : "＋ 上传附件"}
      </button>
      <input ref={inputRef} type="file" multiple accept={uploadAttachmentAccept} style={{ display: "none" }}
        onChange={e => void addFiles(e.target.files)} />
      <span className="muted" style={{ fontSize: 10.5 }}>仅存本地演示环境，随记录一起保存与存证指纹</span>
    </div>
    {files.length > 0 && <div className="attachment-preview">
      {files.map((f, i) => (
        <span key={`${f.name}-${i}`} className="upload-chip" title={f.name}>
          {fileIcon(f.name)} {f.name.length > 18 ? f.name.slice(0, 16) + "…" : f.name}
          <button type="button" aria-label={`移除 ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
    </div>}
    {error && <p className="muted" style={{ color: "var(--danger)", fontSize: 11.5 }}>{error}</p>}
  </div>;
}

// 附件展示（查看侧）：图片缩略图可点开放大，文件提供下载。
export function AttachmentList({ attachments }: {
  attachments: { id: string; name: string; kind?: string; mime?: string | null; dataUrl?: string | null }[];
}) {
  if (!attachments.length) return null;
  return <div className="attachment-view">
    {attachments.map(a => {
      const dataUrl = a.dataUrl ?? null;
      const isImage = (a.kind ?? "photo") === "photo" && (a.mime ?? "").startsWith("image/") && !!dataUrl;
      if (isImage && dataUrl) {
        return <a key={a.id} href={dataUrl} target="_blank" rel="noopener noreferrer" title={`查看 ${a.name}`}>
          <img src={dataUrl} alt={a.name} />
        </a>;
      }
      if (dataUrl) return <a key={a.id} className="file-chip" href={dataUrl} download={a.name}>{fileIcon(a.name)} {a.name}</a>;
      return <span key={a.id} className="file-chip">🖼 {a.name}</span>;
    })}
  </div>;
}

export function fileIcon(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (["png", "jpg", "jpeg"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (ext === "md") return "📝";
  if (["doc", "docx"].includes(ext)) return "📘";
  return "📎";
}
