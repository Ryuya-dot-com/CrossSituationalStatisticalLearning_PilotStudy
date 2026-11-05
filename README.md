# Cross-Situational Statistical Learning — Pilot Study

日本語話者を対象とした、ポルトガル語12語の行動予備調査です。HTML・JavaScriptで動作します。

| 課題 | URL | 本課題の試行数 |
| --- | --- | --- |
| 学習3AFC | [learning.html](https://ryuya-dot-com.github.io/CrossSituationalStatisticalLearning_PilotStudy/learning.html) | 12語×10回＝120 |
| Picture Naming | [naming.html](https://ryuya-dot-com.github.io/CrossSituationalStatisticalLearning_PilotStudy/naming.html) | 12 |
| Picture Matching | [matching.html](https://ryuya-dot-com.github.io/CrossSituationalStatisticalLearning_PilotStudy/matching.html) | 12 |

練習を別に含みます。各URLは独立して起動でき、終了画面の「次の課題へ」では学習 → Naming → Matchingの順に、参加者番号・リスト・study_idを引き継ぎます。

## 実施

PCとヘッドホンを使い、Namingではマイクも許可してください。ブラウザ倍率は100%、画面は960×760 CSS px以上を使用します。

実施者はURLの末尾でリストを指定します。参加者画面にはリスト選択や開発用設定を表示しません。

```text
learning.html#list=7
learning.html#list=7&mode=demo
```

リストは1〜24（指定がない場合は1）。参加者間で均衡するよう実施者が割り当ててください。`mode=demo`では学習だけを12試行に短縮します。参加者番号を事前入力する場合は`&participant=P001`を追加できます。氏名は使用しないでください。

各課題は必要な画像・音声を開始前に読み込み、試行中の提示には通信を使いません。NamingではEP音声を読み込みません。次のURLを開く際には通信が必要です。マイクを要求するのはNamingだけです。

## 結果

課題終了時に`.xlsx`を自動ダウンロードします。自動保存がブラウザに制限された場合は「結果を保存」を押してください。Namingでは「録音・記録を保存」から録音を含むZIPも保存します。

- `Trials`：1試行1行の回答・正誤・RT・品質フラグ等。
- `NamingScoring`：Namingの手動評定欄。未採点は空欄。
- `Session`、`Plan`、`Events`：設定・環境・刺激ハッシュ・試行計画・出来事。

同じブラウザの[保存した結果](https://ryuya-dot-com.github.io/CrossSituationalStatisticalLearning_PilotStudy/results.html)から再ダウンロードできます。サイトデータ削除・プライベートモード・異なるブラウザでは復旧できません。途中再開は行いません。回答・録音は端末に保存し、GitHubや他のサーバーへアップロードしません。

## 測定上の範囲

学習は推定発話開始から1500 ms選択を待たせます。Matchingにはその待機を入れません。Namingは10秒上限で録音し、正誤・発話開始は手動で評定します。回答終了ボタンの時間を発話開始RTとは扱いません。音声・画面オンセットの物理的な精度、人間の発話品質は実機で確認してください。視線・瞳孔の測定は含みません。

Chromeと模擬マイクで、独立3URL・動作確認モード46試行・読み込み後のオフライン実行・3件のExcel自動保存・録音13件・保存後の再取得を検証しています。Excelは独立したリーダーでも検査しています。

## ファイルと公開

`docs/`が公開用の静的サイトです。GitHub Pagesのソースは`main`ブランチの`/docs`に設定します。`docs/manifest.json`にファイルのSHA-256を記録しています。音声と画像の[出典・ライセンス](https://ryuya-dot-com.github.io/CrossSituationalStatisticalLearning_PilotStudy/credits.html)を参照してください。

ローカルで試す場合はリポジトリのルートで`python3 -m http.server 8000 --bind 127.0.0.1`を実行し、`http://127.0.0.1:8000/docs/learning.html#mode=demo`を開きます。
