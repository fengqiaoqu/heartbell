import type { ButtonHTMLAttributes, ReactNode } from "react";
import { avatarKind, officialAvatarOf } from "../lib/domain/avatars";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`button ${props.className ?? ""}`} />;
}
// 头像渲染（v2.2）：官方头像 SVG / 自由上传图片 / 历史表情符号三种形态统一入口。
export function Avatar({ value, size = 64, className = "" }: { value: string | null | undefined; size?: number; className?: string }) {
  const kind = avatarKind(value);
  const style = { width: size, height: size };
  if (kind === "image" && value) {
    return <span className={`hb-avatar ${className}`} style={style}><img src={value} alt="头像" /></span>;
  }
  if (kind === "official" && value) {
    const found = officialAvatarOf(value);
    if (found) return <span className={`hb-avatar ${className}`} style={style} dangerouslySetInnerHTML={{ __html: found.svg }} role="img" aria-label={found.label} />;
  }
  const emoji = value || "♡";
  return <span className={`hb-avatar emoji ${className}`} style={{ ...style, fontSize: Math.round(size * 0.5) }}>{emoji}</span>;
}
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className ?? ""}`}>{children}</section>;
}
export function PhoneFrame({ children }: { children: ReactNode }) {
  return <main className="phone"><div className="notch" />{children}</main>;
}
export function Chip({ tone, children }: { tone?: "brand" | "success" | "warning" | "danger" | "outline"; children: ReactNode }) {
  return <span className={`chip ${tone ?? ""}`}>{children}</span>;
}
export function EmptyState({ title, hint, action, compact }: { title: string; hint?: string; action?: ReactNode; compact?: boolean }) {
  return <div className={compact ? "empty-state compact" : "empty-state"}>{title}{hint && <span>{hint}</span>}{action && <div style={{ marginTop: 14 }}>{action}</div>}</div>;
}
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div role="alert" className="error-banner"><span>{message}</span><button className="text-button" onClick={onDismiss}>收起</button></div>;
}

// 插画与 Logo（视觉资产包 public/visuals/heartbell/；演示用 <img> 避免 image optimizer 依赖）。
export function HeartbellLogo({ size = 34, className = "" }: { size?: number; className?: string }) {
  return <img src="/visuals/heartbell/logo-primary.png" alt="心动铃铛" width={size} height={size} className={`hb-logo ${className}`} />;
}
export function StageArt({ stage, className = "" }: { stage: "meet" | "know" | "us" | "future"; className?: string }) {
  const art = {
    meet: "hero-meet.png",
    know: "hero-know.png",
    us: "hero-us.png",
    future: "hero-future.png",
  }[stage];
  return <img src={`/visuals/heartbell/${art}`} alt="" aria-hidden="true" width={1254} height={1254} className={`hb-art ${className}`} />;
}

// 统一线性图标（视觉资产包 icons/*.svg，stroke=currentColor）。
function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}
export function BellIcon() {
  return <Icon><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /><path d="M12 2V1" /></Icon>;
}
export function ChatIcon() {
  return <Icon><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z" /><path d="M7 8h10M7 12h7" /></Icon>;
}
export function BookIcon() {
  return <Icon><path d="M12 5c-3-2-7-2-10-1v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v16" /><path d="M5 8h3M16 8h3" /></Icon>;
}
export function GiftIcon() {
  return <Icon><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v9h14v-9M12 8v13" /><path d="M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z" /></Icon>;
}
export function RoseIcon() {
  return <Icon><path d="M12 15v7M12 19c-4 0-6-2-7-4M12 20c4 0 6-2 7-4" /><path d="M12 15c-5-1-8-5-6-10l3 2 3-5 3 5 3-2c2 5-1 9-6 10Z" /></Icon>;
}
export function RingIcon() {
  return <Icon><circle cx="12" cy="14" r="6" /><circle cx="12" cy="14" r="2.5" /><path d="M9 8l3-5 3 5" /></Icon>;
}
export function HeartIcon() {
  return <Icon><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></Icon>;
}
export function CheckIcon() {
  return <Icon><path d="m5 12 4 4L19 6" /></Icon>;
}
export function ClockIcon() {
  return <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
}

// 三维度状态（计划书 7.5）：业务 / 存证 / 来源 分开呈现，不用一个对勾包办。
export function anchorStatusChip(status: string | undefined): { tone: "brand" | "success" | "warning" | "danger" | "outline"; label: string } {
  switch (status) {
    case "confirmed": return { tone: "success", label: "链上已核验" };
    case "submitted": case "queued": return { tone: "warning", label: "已提交待确认" };
    case "failed": case "reorged": return { tone: "danger", label: "写入失败" };
    case "unconfigured": return { tone: "outline", label: "预览 · 本地指纹" };
    default: return { tone: "outline", label: "未存证" };
  }
}
export function zhDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
export function countdownText(msLeft: number): string {
  if (msLeft <= 0) return "已到期";
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `剩余 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  return `剩余 ${Math.floor(hours / 24)} 天`;
}
