import { writeFileSync } from 'node:fs';
import { capabilityAudit } from '../src/capabilities.mjs';
const a=capabilityAudit(),labels=a.statusLabels,cell=s=>String(s).replaceAll('|','／');
const lines=['# 功能對標與驗收','',`更新：2026-11-03 · 本系統 ${a.version} · 共 ${a.rows.length} 項需求。`,'',
'依原廠公開 418 頁手冊八大章整理，另標出原廠現行官網擴充與本公司強化。各列狀態只涵蓋該列驗收行為，不代表整個模組或正式上線已完成。這是獨立功能歸納，不複製廠商程式及版面。','',
`來源：[使用者指定手冊](${a.source.reference})、[原廠公開 PDF](${a.source.url})、[原廠現行功能](https://www.hotzsoft.com/Article?d=028&g=S00029)。手冊示例主要為 2021 年，正式發票與外部 API 須依當期官方介面驗證。`,'',
'## 最新比對結果','','| 狀態 | 項目數 |','| --- | ---: |',...Object.entries(a.summary).map(([k,n])=>`| ${labels[k]} | ${n} |`),'',
'v0.5 另補齊 24 項原部分具備的軟體驗收範圍。剩餘 6 項部分具備包含真實異地復原、複合來源月成本、正式發票規格與回執、正式部署／長時間負載、真實資料移轉及 POS 實機／串接；另 14 項外部整合保留原條件。','',
'## 本輪完成的可操作驗收項目','',
...a.rows.filter(r=>r.evidence?.includes('completion-workflows.test.mjs')||['B02','B10','B13','B28','P05','S02','S03','S04','S07','E02','E03','F02','F03','F09','F11','T06','T07','C02','X08','X09'].includes(r.id)).map(r=>`- ${r.id} ${r.name}：${r.acceptance}`),'',
'最新操作、權限及升級見 [v0.5 操作與權限](v0.5操作與權限.md)，原流程另見 v0.4、v0.3 與 v0.2 歷史文件。','',
'## 本輪仍待補齊或外部驗證','',...a.rows.filter(r=>r.status==='partial').map(r=>`- ${r.id} ${r.name}：${r.acceptance}`),'',
'## 其餘待建置','',...(a.rows.some(r=>r.status==='missing')?a.rows.filter(r=>r.status==='missing').map(r=>`- ${r.id} ${r.name}：${r.acceptance}`):['原待建項目已有上述軟體流程；仍需逐列看部分具備及需外部整合的驗收差距。']),'',
'## 重要邊界','',
'逐次與月結政策會在每次出入庫凍結。月結政策先記待立帳科目，截止後才合成應收／應付帳單；合併出入庫另有獨立合併單號與來源明細，並不等於合併開立正式發票。','',
'混合稅別及整單折扣是管理系統的計算行為，電子發票仍需選定服務、授權、測試帳號及真實回執。平台與物流未串接，不能用模擬成功替代正式整合。','',
'新版折讓保存逐列分配，後續實物退貨扣除已折讓部分；舊整筆折讓須先核對。已有退款的收付沖銷需確認抵減現金，不刪原紀錄。採購折讓可選損益或存貨，費用分攤仍由使用者核對實際剩餘庫存。含未兌現票據、已核准呆帳或背書時先完成相關流程。','',
'盤點及成本匯入的 CSV／XLSX 範圍在各列明確標示。實體紙張、掃描器、印表機、手機及真實長時間 20 人負載仍待驗收。所有 GUI 寫入測試僅使用虛構示範資料。','',
'流水重建先預覽與自動備份，再核對來源快照與總帳；不能重寫歷史流水或補平衡分錄掩蓋錯誤。公司資料庫未執行測試重建或測試交易。','',
'## 全項驗收清單',''];
for(const group of new Set(a.rows.map(r=>r.group))){lines.push('### '+group,'','| ID | 功能 | 來源頁次 | 本系統現況 | 驗收條件／差距 | 證據或優先序 |','| --- | --- | --- | --- | --- | --- |');for(const r of a.rows.filter(r=>r.group===group))lines.push('| '+[r.id,r.name,r.pages,labels[r.status],r.acceptance,r.evidence||r.priority].map(cell).join(' | ')+' |');lines.push('');}
writeFileSync(new URL('../docs/功能對標與驗收.md',import.meta.url),lines.join('\n'));
writeFileSync(new URL('../docs/功能驗收清單.json',import.meta.url),JSON.stringify(a,null,2));
console.log(JSON.stringify({items:a.rows.length,...a.summary}));
