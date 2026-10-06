"use client";
// Demo 登录表单（v2.6，依据 v2.5 交付登录规格）：
// 桌面居中约 420px 卡片、360px 手机宽无横向滚动；空值本地提示、凭据错误统一文案；
// 请求期间禁用重复提交；/login?account=a|b 仅预填账号；已登录槽位显示“继续进入”与“退出”。
import { useEffect, useState } from "react";
import { HeartbellLogo } from "../ui";

// v2.8（M03）：A–F 六个独立演示账号（活动甲：A/B/C/D；活动乙：E/F）。
const accounts = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
  { id: "d", label: "D" },
  { id: "e", label: "E" },
  { id: "f", label: "F" },
] as const;

export function DemoLoginForm() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("meet");
  const [activeSession, setActiveSession] = useState<{ viewer: string; nickname: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const acc = params.get("account");
    if (/^[a-f]$/.test(acc ?? "")) setAccount(acc!);
    const t = params.get("tab");
    if (t && ["meet", "know", "us", "future"].includes(t)) setTab(t);
    // 指定账号已有有效会话：显示“继续进入/退出”，不自动跳转，也不受另一账号会话影响。
    if (/^[a-f]$/.test(acc ?? "")) {
      fetch(`/api/demo-auth/session?viewer=${acc}`, { cache: "no-store" })
        .then(r => (r.ok ? r.json() : null))
        .then(json => {
          if (json?.data) setActiveSession({ viewer: json.data.viewer, nickname: json.data.nickname });
        })
        .catch(() => { /* 会话查询失败按未登录处理 */ });
    }
  }, []);

  async function submit() {
    if (busy) return;
    if (!account.trim()) { setError("请输入账号（a–f）"); return; }
    if (!password) { setError("请输入密码"); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/demo-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: account, password, tab }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.error?.code === "FORBIDDEN" ? "此功能暂未开放。" : "账号或密码不正确");
        return;
      }
      // 跳转地址由服务器按验证出的账号构造，不信任任意外部 next/returnUrl。
      window.location.assign(json.data.redirectTo as string);
    } catch {
      setError("暂时无法连接服务，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function logoutActive() {
    if (!activeSession) return;
    setBusy(true);
    try {
      await fetch("/api/demo-auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewer: activeSession.viewer }),
      });
    } catch { /* 重复退出也成功 */ }
    setActiveSession(null);
    setBusy(false);
  }

  return <div className="login-card">
    <div className="login-logo"><HeartbellLogo size={48} /></div>
    <h1>欢迎回到心动铃铛</h1>
    <p className="muted">使用预设 Demo 账号，继续你们的故事。</p>

    {activeSession && <div className="login-active" role="status">
      <p style={{ margin: 0 }}>{activeSession.nickname} 已在本窗口登录。</p>
      <div className="login-active-actions">
        <a className="login-continue" href={`/demo/${activeSession.viewer}?tab=${tab}`}>继续以 {activeSession.viewer.toUpperCase()} 进入</a>
        <button type="button" className="text-button" disabled={busy} onClick={logoutActive}>退出此账号</button>
      </div>
    </div>}

    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="field-label" htmlFor="login-account">账号</label>
      <input id="login-account" name="username" autoComplete="username" inputMode="text"
        placeholder="a – f" maxLength={32} value={account}
        aria-invalid={!!error} onChange={e => { setAccount(e.target.value); setError(""); }} />
      <div className="login-account-hints" aria-hidden="true">
        {accounts.map(x => (
          <button key={x.id} type="button" className={`chip-button ${account.trim().toLowerCase() === x.id ? "chosen" : ""}`}
            onClick={() => setAccount(x.id)}>Demo {x.label}</button>
        ))}
      </div>

      <label className="field-label" htmlFor="login-password">密码</label>
      <div className="login-password-row">
        <input id="login-password" name="password" autoComplete="current-password"
          type={showPassword ? "text" : "password"} placeholder="输入密码" maxLength={128} value={password}
          aria-invalid={!!error} onChange={e => { setPassword(e.target.value); setError(""); }} />
        <button type="button" className="text-button" aria-label={showPassword ? "隐藏密码" : "显示密码"}
          onClick={() => setShowPassword(v => !v)}>{showPassword ? "隐藏" : "显示"}</button>
      </div>

      {error && <p className="login-error" role="alert">{error}</p>}
      <button type="submit" className="login-submit" disabled={busy}>{busy ? "登录中…" : "登录"}</button>
    </form>

    <p className="muted center" style={{ marginTop: 10 }}>仅开放预设演示账号</p>
    <p className="center" style={{ marginTop: 2 }}><a href="/">返回首页</a></p>
  </div>;
}
