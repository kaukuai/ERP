# GitHub 與跨裝置開發

原始碼儲存庫：[kaukuai/ERP](https://github.com/kaukuai/ERP)。目前版本為 v0.3 核心試行版，功能驗收清單仍記錄未完成部分。

## 在另一台電腦開發

安裝 Git 與 Node.js 24。可用 nvm 的環境執行 `nvm install`、`nvm use`，採用根目錄 `.nvmrc` 的版本。本專案沒有待安裝的 npm 依賴；條碼元件及授權已隨程式保存。

```sh
git clone https://github.com/kaukuai/ERP.git
cd ERP
npm run verify
npm run dev
```

在瀏覽器開啟 `http://127.0.0.1:4321`，按「進入示範工作空間」。示範客戶、商品與交易由程式產生，無需從舊電腦複製資料。

若要測試公司初始化流程，關閉示範程序後執行 `npm run dev:company`，開啟 `http://127.0.0.1:4320`，自行建立此開發環境的管理員。每個 checkout 的資料庫各自獨立。

Windows 仍可使用 `demo.cmd`、`start.cmd` 與 `verify.cmd`。命令列的 npm 指令支援三種作業系統。

## 只用瀏覽器開發：GitHub Codespaces

1. 開啟儲存庫，選 **Code → Codespaces → Create codespace on main**。這是使用者自行建立的 GitHub 開發環境；是否有可用額度及計費依 GitHub 帳號方案。本次移轉未建立付費資源。
2. 專案的 `.devcontainer/devcontainer.json` 使用官方 Node 24 開發映像，建立後會執行 `npm run verify`。
3. 在終端機執行 `npm run dev`。
4. 在 **Ports** 面板開啟 4321 的瀏覽器連結，並保留 **Private** 可見性。該入口提供虛構示範資料。
5. 如需測試公司初始化，另開終端機執行 `npm run dev:company` 並開啟私有 4320 連結。不要放入公司正式資料。

`scripts/dev.mjs` 只在 `CODESPACES=true` 時，從 `CODESPACE_NAME`、`GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` 及實際連接埠組出一個精確允許的主機名稱，並使用 Secure Cookie。保留原有 Host／Origin／CSRF 驗證及 loopback 綁定；不開放萬用主機或公網監聽。Codespaces 的網頁入口使用 HTTPS；Ports 面板到容器內服務仍選 HTTP。

本機 Dev Containers 亦可用 VS Code 開啟資料夾後選 **Reopen in Container**，再執行相同 npm 指令。當不是 Codespaces 時，啟動器不變更既有環境設定。

官方參考：[Node 開發容器映像](https://github.com/devcontainers/images/tree/main/src/javascript-node)、[Codespaces 預設環境變數](https://docs.github.com/en/codespaces/developing-in-a-codespace/default-environment-variables-for-your-codespace)、[連接埠轉送與可見性](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)。

## 換裝置時同步工作

開始修改前先同步，再建立功能分支：

```sh
git switch main
git pull --ff-only
git switch -c feature/your-change
```

完成一段可驗證工作後：

```sh
npm run verify
git status --short
git add src public tests docs scripts package.json
git diff --cached --stat
git commit -m "Describe the change"
git push -u origin feature/your-change
```

依實際改動選擇檔案，不要把資料庫或密鑰強制加入 Git。至 GitHub 建立 Pull Request 合併，另一台電腦即可切回 main 再 pull。尚未合併的功能也可直接 fetch／checkout 對應分支繼續。

Actions 的 **Verify ERP** 在 push／Pull Request 時，會於 Windows、macOS、Linux 使用 `.nvmrc` 版本執行語法檢查與完整測試。測試資料只存在暫存庫，流程不會接觸公司正式庫。

## 程式同步與資料保留

GitHub 同步原始碼、測試、操作文件、虛構示範截圖與元件授權。以下保留在各自環境：

- `data/` 的公司與示範 SQLite、登入及操作紀錄、備份。
- 環境變數、`.env*`、私密金鑰及憑證。
- `artifacts/` 的打包檔、研究下載及完整廠商手冊。
- npm 快取、node_modules 與測試覆蓋輸出。

停止 Codespace 通常只是停止運算；刪除 Codespace 會移除其工作檔，未提交的程式和被 Git 忽略的資料不會因 push 自動保留。程式請 commit／push；有保留需求的測試資料應使用受控備份，不要把資料庫改成可追蹤檔案。

本次 GitHub 移轉是開發環境的搬移。公司正式 ERP 的共用網址、HTTPS 伺服器、正式資料移轉、備份與維運部署仍是另一項工作；GitHub Pages 無法直接執行此 Node.js／SQLite 伺服器。公司正式資料持續保留於原工作環境。
