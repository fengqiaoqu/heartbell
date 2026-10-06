export default function Home() {
  return <main className="landing">
    <div className="brand-row">
      <img src="/visuals/heartbell/logo-primary.png" alt="心动铃铛 Logo" width={52} height={52} />
      <div><span className="eyebrow" style={{ margin: 0 }}>HEARTBELL · 心动铃铛</span></div>
    </div>
    <h1>从一次心动，<br />到共同写下的未来。</h1>
    <p>打开两个独立窗口，分别扮演 A 和 B，走完四个阶段：<strong>相遇</strong>（雷达与摇铃）、<strong>了解</strong>（意向与履约参考）、<strong>我们</strong>（共同日记与承诺）、<strong>相守</strong>（演示计划与奖励）。</p>
    <img className="cover-banner" src="/visuals/heartbell/cover-journey.png" alt="铃铛、信笺、日记与玫瑰，构成一段关系的四个章节" width={1774} height={887} />
    <div className="stage-cards">
      <div><span className="intent-badge">相遇</span><p className="muted">10 分钟雷达、临时特征、匿名摇铃、双向回响后资料揭晓。</p></div>
      <div><span className="intent-badge">了解</span><p className="muted">交往意向、应用内状态、获得授权的上一段关系履约摘要。</p></div>
      <div><span className="intent-badge">我们</span><p className="muted">共同日记、纪念时间线与重要承诺；版本可核验。</p></div>
      <div><span className="intent-badge">相守</span><p className="muted">双方投入演示点数，目标核验后领取点数或玫瑰演示券。</p></div>
    </div>
    <div className="entry-links">
      <a className="button" href="/demo/a?tab=meet" target="_blank" rel="noopener noreferrer">打开 A 的窗口 ↗</a>
      <a className="button secondary" href="/demo/b?tab=meet" target="_blank" rel="noopener noreferrer">打开 B 的窗口 ↗</a>
      <a className="button ghost" href="/admin" target="_blank" rel="noopener noreferrer">维护后台 ↗</a>
      <a className="button ghost" href="/demo/admin" target="_blank" rel="noopener noreferrer">演示审核台 ↗</a>
    </div>
    <img className="four-screens" src="/visuals/heartbell/ui-four-screens.png" alt="四阶段手机界面效果图（视觉参考，实际以窗口内页面为准）" width={1586} height={992} />
    <div className="notice">两窗口并排，宽度约 420px，A/B 状态独立（每 1.2 秒同步）。位置、身份与演示前史均为模拟；履约分仅反映应用内已记录事项；相守计划为恋爱保险概念演示（使用演示点数，不可购买/转让/提现）。默认 preview 存证模式未连接真实链：只保留本地承诺指纹，不生成模拟交易链接。</div>
    <p className="muted">服务重启会清空演示记录（内存存储）。A/B 双钱包真实上链演示请使用不同浏览器或隔离配置。</p>
  </main>;
}
