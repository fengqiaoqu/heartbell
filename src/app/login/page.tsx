import type { Metadata } from "next";
import { DemoLoginForm } from "../../components/auth/demo-login-form";
import "./login.css";

export const metadata: Metadata = { title: "登录 · 心动铃铛" };

// v2.6 登录页：/login?account=a|b&tab=meet|know|us|future（account 仅预填，不代替密码验证）。
export default function LoginPage() {
  return <main className="login-page">
    <DemoLoginForm />
  </main>;
}
