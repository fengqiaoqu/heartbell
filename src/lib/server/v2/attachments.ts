// v2.5 附件解析（反馈 6）：日记/纪念日/承诺支持上传 png、jpg、pdf、md、word（doc/docx）。
// 服务端统一校验扩展名、大小与数量；指纹由内容确定性计算，进入版本比较与存证 attachmentHashes。
// v2.7：按解码后的字节数校验大小（与前端 file.size 同口径）；校验真实文件魔数，
// 纯文本冒充 png/pdf/word 直接拒绝（实测：text 以 image/png data URL 发送曾被接受）。
import { createHash } from "node:crypto";
import type { AttachmentRef } from "../../domain/v2-types";
import {
  MAX_ATTACHMENTS_PER_RECORD, MAX_UPLOAD_ATTACHMENT_BYTES, uploadAttachmentExtMime,
} from "../../domain/v2-types";
import { demoImageLibrary, demoImageSha256 } from "../../repositories/demo-repo";
import { badRequest } from "./errors";

// 各格式真实文件的起始字节（magic numbers）。md 为纯文本，校验 UTF-8 可解码。
const MAGIC_BYTES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE2
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    [0x50, 0x4b, 0x03, 0x04], // zip（PK..）
    [0x50, 0x4b, 0x05, 0x06], // 空归档
    [0x50, 0x4b, 0x07, 0x08], // 分卷归档
  ],
};

function matchesMagic(bytes: Uint8Array, candidates: number[][]): boolean {
  return candidates.some(sig => sig.every((byte, i) => bytes[i] === byte));
}

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
    const base64 = match[2];
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw badRequest(`附件「${name}」内容无效`);
    const bytes = Buffer.from(base64, "base64");
    // v2.7：解码后字节数为准（此前按 dataUrl 字符串长度估算，与前端 600KB 口径不一致）。
    if (bytes.length === 0) throw badRequest(`附件「${name}」内容为空`);
    if (bytes.length > MAX_UPLOAD_ATTACHMENT_BYTES) throw badRequest(`附件「${name}」过大（单个 ≤ 600KB）`);
    // v2.7：真实文件类型校验 —— 魔数不符或文本无法按 UTF-8 解码即拒绝。
    const magic = MAGIC_BYTES[mime];
    if (magic && !matchesMagic(bytes, magic)) {
      throw badRequest(`附件「${name}」的实际内容与 ${ext.toUpperCase()} 格式不符，请重新选择文件`);
    }
    if (mime === "text/markdown") {
      // 文本格式无魔数：校验可按 UTF-8 完整解码（无效字节序列会被替换为 U+FFFD）。
      const decoded = bytes.toString("utf8");
      if (decoded.includes("\uFFFD")) throw badRequest(`附件「${name}」不是有效的文本文件`);
    }
    if (refs.length >= MAX_ATTACHMENTS_PER_RECORD) throw badRequest(`每条记录最多 ${MAX_ATTACHMENTS_PER_RECORD} 个附件`);
    refs.push({
      id: `up-${Math.random().toString(36).slice(2, 12)}`,
      name, sha256: "0x" + createHash("sha256").update(bytes).digest("hex"),
      kind: mime.startsWith("image/") ? "photo" : "file",
      mime, size: bytes.length, dataUrl,
    });
  }
  return refs;
}
