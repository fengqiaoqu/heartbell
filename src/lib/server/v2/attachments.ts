// v2.5 附件解析（反馈 6）：日记/纪念日/承诺支持上传 png、jpg、pdf、md、word（doc/docx）。
// 服务端统一校验扩展名、大小与数量；指纹由内容确定性计算，进入版本比较与存证 attachmentHashes。
import { createHash } from "node:crypto";
import type { AttachmentRef } from "../../domain/v2-types";
import {
  MAX_ATTACHMENTS_PER_RECORD, MAX_UPLOAD_ATTACHMENT_CHARS, uploadAttachmentExtMime,
} from "../../domain/v2-types";
import { demoImageLibrary, demoImageSha256 } from "../../repositories/demo-repo";
import { badRequest } from "./errors";

// input.attachmentIds：保留的旧附件/演示图片 ID；input.attachments：本次新上传的 {name, dataUrl}。
// currentRefs 为该记录当前版本的附件（新版本可原样保留）。
export function resolveAttachments(input: Record<string, unknown>, currentRefs: AttachmentRef[]): AttachmentRef[] {
  const kept: AttachmentRef[] = [];
  const keepIds = Array.isArray(input.attachmentIds) ? input.attachmentIds.map(id => String(id)) : [];
  const seen = new Set<string>();
  for (const id of keepIds) {
    if (seen.has(id)) throw badRequest("附件不能重复选择");
    seen.add(id);
    const prev = currentRefs.find(a => a.id === id);
    if (prev) { kept.push(prev); continue; }
    const demo = demoImageLibrary.find(img => img.id === id);
    if (demo) { kept.push({ id: demo.id, name: demo.name, sha256: demoImageSha256(demo.id), kind: "photo" }); continue; }
    throw badRequest("包含无效的附件引用");
  }
  const uploaded = Array.isArray(input.attachments) ? input.attachments : [];
  const refs: AttachmentRef[] = [...kept];
  for (const raw of uploaded) {
    const item = raw as { name?: unknown; dataUrl?: unknown };
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 60) : "";
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    if (!name || !dataUrl) throw badRequest("附件缺少文件名或内容");
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const mime = uploadAttachmentExtMime[ext];
    if (!mime) throw badRequest(`不支持的附件格式：.${ext || "?"}（支持 png / jpg / pdf / md / word）`);
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!match || match[1] !== mime) throw badRequest(`附件「${name}」的内容与格式不一致，请重新选择文件`);
    if (dataUrl.length > MAX_UPLOAD_ATTACHMENT_CHARS) throw badRequest(`附件「${name}」过大（单个 ≤ 约 650KB）`);
    const base64 = match[2];
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw badRequest(`附件「${name}」内容无效`);
    if (refs.length >= MAX_ATTACHMENTS_PER_RECORD) throw badRequest(`每条记录最多 ${MAX_ATTACHMENTS_PER_RECORD} 个附件`);
    refs.push({
      id: `up-${Math.random().toString(36).slice(2, 12)}`,
      name, sha256: "0x" + createHash("sha256").update(dataUrl).digest("hex"),
      kind: mime.startsWith("image/") ? "photo" : "file",
      mime, size: Math.floor(base64.length * 3 / 4), dataUrl,
    });
  }
  return refs;
}
