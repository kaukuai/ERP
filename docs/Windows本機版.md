# Windows 本機版

本機版將 ERP 程式與 Node.js 執行環境一起提供，不需要另外租後端主機、安裝 Git 或安裝資料庫。預設僅供同一台 Windows 電腦以瀏覽器操作。

## 下載與啟動

1. 開啟儲存庫的 Actions，選「Verify ERP」最新成功執行紀錄。
2. 等「Windows local package」完成，在 Artifacts 下載 `ERP-Windows`。下載需要有此儲存庫存取權的帳號；成品保留 30 天，過期可重新執行 workflow。
3. 將 ZIP 完整解壓到任一程式資料夾，雙擊 `start.cmd`；不要直接在壓縮檔裡執行。
4. 瀏覽器會自動開啟 `http://127.0.0.1:4320`。首次使用自行建立公司與管理員，沒有預設帳密。

本機包標示實際 Windows 架構、程式版本與 Node 版本，附 Node 授權、元件告知與 `SHA256SUMS.txt`。實際業務資料不會包含在下載包內。

## 資料放在哪裡

新安裝預設使用 `%LOCALAPPDATA%\ERP-Local\data`，程式設定保存在 `%LOCALAPPDATA%\ERP-Local\company.json`。資料庫、公司目錄與備份和下載的程式分開，關閉視窗不會清除。

如偵測到原專案 `data/company.sqlite`，會先備份並驗證，再沿用原位置並記錄設定；**實際位置以啟動視窗顯示為準，請保留該資料夾，不要把它當作舊程式刪除。** 將程式放到另一個資料夾，仍會依既有設定找到同一份資料。

`demo.cmd` 使用另一份本機示範庫，不會取代正式帳套。線上展示、GitHub 程式碼與本機業務資料各自獨立。

## 更新與備份

先關閉舊版 ERP 的命令視窗，再下載新版並完整解壓，雙擊新版 `start.cmd`。新版沿用既有資料位置，不需要複製資料庫到新程式資料夾。

程式內容或 Node 版本改變時，啟動器會先備份根庫與所有公司庫，並在副本檢查既有欄位、資料列及帳務一致性；通過後才啟動新版。備份失敗、資料庫過新或已知資料庫遺失時會停止，不會建立空白公司庫代替。

關閉服務後，雙擊 `backup.cmd` 可手動備份。根資料夾的 `backups/local-backup-*.json` 列出這次全部帳套的備份位置與驗證結果；每個 SQLite 旁有自己的 `backups`。請將**完整資料目錄與備份清單**另存到其他磁碟，不要只複製根庫，或只複製根庫的 backups 而漏掉公司庫備份。

同一份資料只啟動一個 ERP 服務。重複啟動相同版本會開啟既有服務；不同版本或備份作業需先關閉舊服務。資料鎖由作業系統管理，程序停止後會自動釋放。

## 開發者建立本機包

使用 `.nvmrc` 指定的 Node.js 24，在目標平台執行：

```sh
npm run verify
npm run package:local
node scripts/check-local-package.mjs
```

輸出於 `artifacts/local/ERP-local`，不加入 Git。Windows CI 會使用 Windows Node 執行環境，驗證程式包中的實際執行檔、關閉重開、中文／空白程式路徑、新版備份、多公司保留及遺失資料庫拒絕後，再上傳可下載成品。

從原始碼操作可執行 `npm run local`，使用者須先安裝 Node.js 24。`npm run dev:company` 與 `npm start` 保留原開發環境路徑與啟動方式，屬開發者入口；使用者日常操作以本機包的 `start.cmd` 為準。
