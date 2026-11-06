// node test.js — obsidian を差し替えて純粋ロジックだけ検証する
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => req === 'obsidian'
  ? { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {},
      requestUrl: () => {}, arrayBufferToBase64: () => {}, base64ToArrayBuffer: () => {} }
  : load(req, ...rest);

const { decide, blobSha, makeIgnore } = require('./main.js');

const A = 'aaa', B = 'bbb', C = 'ccc';
assert.equal(decide(A, A, A), 'none', '一致');
assert.equal(decide(A, A, undefined), 'none', '初回でも一致なら何もしない');
assert.equal(decide(A, B, A), 'pull', 'リモートが進んでいる');
assert.equal(decide(B, A, A), 'push', 'ローカルが進んでいる');
assert.equal(decide(B, C, A), 'conflict', '両方更新');
assert.equal(decide(null, A, undefined), 'pull', 'リモートの新規ファイル');
assert.equal(decide(A, null, undefined), 'push', 'ローカルの新規ファイル');
assert.equal(decide(null, A, A), 'delRemote', 'ローカル削除をリモートへ');
assert.equal(decide(A, null, A), 'delLocal', 'リモート削除をローカルへ');
assert.equal(decide(null, B, A), 'pull', 'ローカル削除 vs リモート更新 → 更新を優先して復活');
assert.equal(decide(B, null, A), 'push', 'リモート削除 vs ローカル更新 → 更新を優先して復活');
assert.equal(decide(null, null, A), 'none', '両方で削除');

const ig = makeIgnore(['# コメント', '', '*.png', 'build/', '/README.md', 'a/**/b', 'tmp?.md',
                       'secret.md', '!secret.md']);
assert.ok(ig('x.png') && ig('d/x.png'), '拡張子はどの階層でも');
assert.ok(!ig('x.png.md'), '部分一致はしない');
assert.ok(ig('build/x.js') && ig('d/build/x.js') && !ig('build.js'), 'ディレクトリ指定');
assert.ok(ig('README.md') && !ig('d/README.md'), '先頭スラッシュで固定');
assert.ok(ig('a/b') && ig('a/x/y/b') && !ig('z/a/b'), '** は 0 階層以上');
assert.ok(ig('tmp1.md') && !ig('tmp12.md'), '? は 1 文字');
assert.ok(!ig('secret.md'), '! は後勝ちで打ち消す');
assert.ok(!ig('note.md'), '該当しなければ同期対象');
assert.ok(!makeIgnore(['#*.md'])('a.md'), 'コメント行は無視');

(async () => {
  // git hash-object の既知値
  assert.equal(await blobSha(new TextEncoder().encode('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(await blobSha(new Uint8Array(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  console.log('ok');
})();
