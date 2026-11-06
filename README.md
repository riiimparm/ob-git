# obgit

Obsidian の vault を GitHub API 経由でファイル単位に同期するプラグイン。git も CLI も要らず、モバイルでも動く。

## できること

- 双方向同期（ボタン / コマンド `GitHub と同期`）
- 差分判定は git の blob SHA。前回同期時の SHA を基準に pull / push / 削除を決める
- 両方で更新されたファイルは競合として `_conflict/` にリモート版を書き出し、ローカルはそのまま
- `.gitignore`（vault ルート）+ 設定の追加パターンで除外。`.` 始まりのパスは常に除外

## インストール

リリースの `main.js` と `manifest.json` を vault の `.obsidian/plugins/obgit/` に置いて、設定 → コミュニティプラグインで有効化。

## 設定

| 項目 | 内容 |
|---|---|
| GitHub トークン | `repo` スコープの Personal Access Token |
| リポジトリ | `owner/repo` |
| ブランチ | 既定 `main` |
| 端末名 | コミットメッセージの接頭辞 |
| 追加の除外パターン | `.gitignore` に加えて除外するパターン |

トークンは vault 内の `data.json` に平文で保存される。vault 自体を他人と共有しないこと。

## テスト

```
node test.js
```

## ライセンス

MIT
