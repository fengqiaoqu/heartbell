import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { JourneyShell } from "../../../components/journey/app-shell";
import { resolveSlotFromCookieHeader, isDemoViewer } from "../../../lib/server/demo-auth";
// v2.6：/demo/a、/demo/b（双人演示）与 /demo/c（安全验证第三人）需要对应槽位的服务器会话才渲染；
// v2.8（M03）：扩展为 /demo/a–f 六个独立演示账号（活动甲：A/B/C/D；活动乙：E/F）。
// 未登录引导到对应登录页（带原栏目）；非法角色仍 404。
const allowedTabs = new Set(["meet", "know", "us", "future"]);
export default async function DemoPage({
  params, searchParams,
}: {
  params: Promise<{ user: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { user } = await params;
  const { tab } = await searchParams;
  if (!isDemoViewer(user)) notFound();
  const cookieStore = await cookies();
  const cookieHeader = [...cookieStore.getAll()].map(c => `${c.name}=${c.value}`).join("; ");
  const session = resolveSlotFromCookieHeader(cookieHeader || null, user);
  if (!session) {
    const nextTab = tab && allowedTabs.has(tab) ? tab : "meet";
    redirect(`/login?account=${user}&tab=${nextTab}`);
  }
  return <JourneyShell user={user} />;
}
