# 買房還是租房

手機打開就能用的買租成本試算。把財務結果和家庭生活情境整理成一段文字，複製後貼給 Claude 繼續討論。

網址：https://xiao501.github.io/rent-vs-buy/

## 功能（第一階段）

- 房貸月付試算（本息平均攤還、寬限期），買房與租房每月總支出並排比較。
- 自動帶入房貸利率與租金行情，可手動覆寫、再恢復自動值。
- 生活情境（小孩、寵物、在家工作、需要房數）＋產生給 AI 的討論訊息。
- 多組試算可命名、切換、刪除；資料只存在手機瀏覽器（localStorage）。

## 資料來源與處理

| 資料 | 來源 | 處理 |
| --- | --- | --- |
| 月租金 | [內政部實價登錄開放資料](https://plvr.land.moi.gov.tw/DownloadOpenData)（不動產租賃） | 近 4 季＋本期資料；只取「整棟(戶)出租」與「分層出租」的住家租約，含車位者扣除車位租金；依縣市＞行政區＞房數（4 = 4 房以上）彙整**最近 6 個月**（本月往前 2 個月為止，因登錄有延遲）的中位數、平均值、筆數 |
| 房貸利率 | [中央銀行・五大銀行新承做放款金額與利率](https://www.cbc.gov.tw/tw/cp-528-1079-B4682-1.html) | 從頁面找 ODS 附檔，取最新一期的購屋貸款利率 |

`scripts/update_data.py` 產生 `data/rent.json` 與 `data/rate.json`。GitHub Actions（`.github/workflows/update-and-deploy.yml`）每月 3 日自動執行並部署，也可以在 Actions 頁面按「Run workflow」手動觸發；push 到 main 只重新部署、不更新資料。

## 本機開發

```
pip install -r scripts/requirements.txt
python scripts/update_data.py data
python -m http.server 8765
```

不需要建置步驟，純 HTML／CSS／JavaScript。
