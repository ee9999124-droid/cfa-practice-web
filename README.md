# Arc · CFA Practice

不需伺服器的 local-first CFA 刷題工具，可直接部署至 GitHub Pages。題庫、作答紀錄與未完成練習都保存在瀏覽器 IndexedDB。

## 題目形式

- **Vignette 題組**：Word 內有明確 `Vignette` 標記的共用情境；抽題時永遠保留完整題組。
- **獨立單題**：沒有共用情境的題目；可依目標題數逐題抽取。
- **待確認**：有疑似情境但缺少可靠標記，或是從舊版留下、尚未分類的項目。它不會被強行納入練習，可在「題庫」展開項目後手動更正，也可以重新匯入原 Word。

手動更正只更新題目形式，不改題目 ID；移除題庫也不會刪除歷史作答。備份 JSON 仍包含題庫、題目形式、歷史與草稿。

## 本機驗證

```bash
npm test
python3 -m http.server 4173
```

開啟 `http://localhost:4173`。專案只使用相對路徑與瀏覽器原生 API，沒有執行期套件或遠端 CSS import。
