import type { Metadata } from "next";
import "./globals.css";
import "./modules.css";
export const metadata: Metadata = {
  title: "心动铃铛 · Heartbell",
  description: "从一次心动，到共同写下的未来。",
  icons: { icon: "/visuals/heartbell/app-icon.png" },
};
// v2.9 Consensus Bell 字体：标题衬线 Noto Serif + 正文 Inter（display=swap，
// 离线环境自动回退系统衬线/苹方/雅黑，不阻塞渲染）。
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN">
    <head>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Serif+SC:wght@400;500&display=swap" rel="stylesheet" />
    </head>
    <body>{children}</body>
  </html>;
}
