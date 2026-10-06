"use client";
// 头像点开放大（v2.5 反馈 2）：任何主要头像展示位支持点开查看大图。
import { useState } from "react";
import { Avatar } from "./ui";
import { Modal } from "./modal";

export function AvatarZoom({ value, size = 64, className = "" }: { value: string | null | undefined; size?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="avatar-zoom-trigger" aria-label="点开查看大头像" title="点开查看大头像" onClick={() => setOpen(true)}>
      <Avatar value={value} size={size} className={className} />
      <i aria-hidden="true">⤢</i>
    </button>
    {open && <Modal title="头像" onClose={() => setOpen(false)}>
      <div className="avatar-zoom-stage"><Avatar value={value} size={230} /></div>
      <p className="muted center">点头像以外的区域或关闭按钮返回。</p>
    </Modal>}
  </>;
}
