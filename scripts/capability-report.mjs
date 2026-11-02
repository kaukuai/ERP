import { writeFileSync } from 'node:fs';
import { capabilityAudit } from '../src/capabilities.mjs';
const a=capabilityAudit(),labels=a.statusLabels,cell=s=>String(s).replaceAll('|','／');
const lines=['# 數碼一號功能對標與驗收','',`更新：2026-11-02 · 本系統 ${a.version} · 共 ${a.rows.length} 項需求。`,'',
'依原廠公開 418 頁手冊八大章整理，另標出原廠現行官網擴充與本公司強化。各列狀態只涵蓋該列驗收行為，不代表整個模組或正式上線已完成。這是獨立功能歸納，不複製廠商程式及版面。','',
`來源：[使用者指定手冊](${a.source.reference})、[原廠公開 PDF](${a.source.url})、[原廠現行功能](https://www.hotzsoft.com/Article?d=028&g=S00029)。手冊示例主要為 2021 年，正式發票與外部 API 須依當期官方介面驗證。`,'',
'## 最新比對結果','','| 狀態 | 項目數 |','| --- | ---: |',...Object.entries(a.summary).map(([k,n])=>`| ${labels[k]} | ${n} |`),'',
'v0.2 為 36 可操作、30 部分、35 待建、14 外部。本輪有 15 項由待建／部分提升為可操作；批次揀貨、盤點匯入與成本重估亦完成部分範圍。尚未全功能對等，項目權重不同，不能計算工程完成百分比。','',
'## 本輪完成的可操作驗收項目','',
...a.rows.filter(r=>['B04','B14','B19','B20','B21','B23','B30','P04','P09','S06','S08','S09','S10','I08','T05'].includes(r.id)).map(r=>`- ${r.id} ${r.name}：${r.acceptance}`),'',
'操作入口與限制見 [v0.3 操作與升級](v0.3操作與升級.md)。原有預收付、退款、票據、費用等說明見 [v0.2 操作與升級](v0.2操作與升級.md)。','',
'## 仍待建置的項目','',...a.rows.filter(r=>r.status==='missing').map(r=>`- ${r.id} ${r.name}：${r.acceptance}`),'',
'## 重要邊界','',
'批次收付款與批次掃碼出貨都不等於月底合併立帳。本版仍於每筆出入庫立即立帳；同批揀貨會保留多張來源及出庫單，尚不合併成一張銷貨或發票。','',
'混合稅別及整單折扣是管理系統的計算行為，電子發票仍需選定服務、授權、測試帳號及真實回執。平台與物流未串接，不能用模擬成功替代正式整合。','',
'折讓後的再次實物退貨仍待逐列分攤；有未兌現票據須先處理票據再折退。已有退貨／折讓的收付款，不能直接反向沖銷。採購金額折讓目前記存貨調整損益，進銷費用成本分攤未完成。','',
'盤點及成本匯入的 CSV／XLSX 範圍在各列明確標示。實體紙張、掃描器、印表機、手機及真實長時間 20 人負載仍待驗收。所有 GUI 寫入測試僅使用虛構示範資料。','',
'流水重建先預覽與自動備份，再核對來源快照與總帳；不能重寫歷史流水或補平衡分錄掩蓋錯誤。公司資料庫未執行測試重建或測試交易。','',
'## 全項驗收清單',''];
for(const group of new Set(a.rows.map(r=>r.group))){lines.push('### '+group,'','| ID | 功能 | 來源頁次 | 本系統現況 | 驗收條件／差距 | 證據或優先序 |','| --- | --- | --- | --- | --- | --- |');for(const r of a.rows.filter(r=>r.group===group))lines.push('| '+[r.id,r.name,r.pages,labels[r.status],r.acceptance,r.evidence||r.priority].map(cell).join(' | ')+' |');lines.push('');}
writeFileSync(new URL('../docs/數碼一號功能對標與驗收.md',import.meta.url),lines.join('\n'));
writeFileSync(new URL('../docs/功能驗收清單.json',import.meta.url),JSON.stringify(a,null,2));
console.log(JSON.stringify({items:a.rows.length,...a.summary}));
