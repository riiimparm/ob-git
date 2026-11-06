const { Plugin, PluginSettingTab, Setting, Notice, requestUrl,
        arrayBufferToBase64, base64ToArrayBuffer } = require('obsidian');

const CONFLICT_DIR = '_conflict';
const IGNORE_FILE = '.gitignore';
const DEFAULT_IGNORE = `# obgit: 同期から除外するパターン (.gitignore 互換)
# ドット始まりのパス (.obsidian/ など) と ${CONFLICT_DIR}/ は常に除外されます
`;

function hostname() {
  try { return require('os').hostname(); } catch (e) { return 'obsidian'; }
}

// git の blob SHA を計算する。GitHub の tree API が返す sha と同じ値になるので、
// 余計な状態を持たずにローカル/リモートの内容を比較できる。
async function blobSha(data) {
  const bytes = new Uint8Array(data);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

// ls/rs: ローカル/リモートの blob sha (無ければ null)、base: 前回同期時の sha
function decide(ls, rs, base) {
  if (ls === rs) return 'none';
  if (!ls) return base === rs ? 'delRemote' : 'pull';  // ローカルで削除。相手も変えていれば残す
  if (!rs) return base === ls ? 'delLocal' : 'push';   // リモートで削除。こちらが変えていれば残す
  if (ls === base) return 'pull';
  if (rs === base) return 'push';
  return 'conflict';
}

// gitignore パターンを正規表現へ。文字クラス [a-z] とバックスラッシュのエスケープは未対応。
// ponytail: 足りなくなったら ignore パッケージ + バンドル導入
function toRegExp(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');   // スラッシュを含むパターンは vault ルート起点
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*';
    } else if (p[i] === '*') re += '[^/]*';
    else if (p[i] === '?') re += '[^/]';
    else re += p[i].replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp('^' + (anchored ? '' : '(?:.*/)?') + re + (dirOnly ? '/' : '(?:/|$)'));
}

// 後勝ち。! 始まりは除外の打ち消し。
function makeIgnore(lines) {
  const rules = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    rules.push({ negate, re: toRegExp(negate ? line.slice(1) : line) });
  }
  return path => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}

const DEFAULT_SETTINGS = { token: '', repo: '', branch: 'main', device: hostname(), exclude: '', base: {} };

class ObGitPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.status = this.addStatusBarItem();
    this.status.setText('obgit: 未同期');
    this.addRibbonIcon('refresh-cw', 'GitHub と同期', () => this.sync());
    this.addCommand({ id: 'sync', name: 'GitHub と同期', callback: () => this.sync() });
    this.addSettingTab(new ObGitSettingTab(this.app, this));
  }

  async api(method, path, body) {
    const headers = { Authorization: `Bearer ${this.settings.token}`, Accept: 'application/vnd.github+json' };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await requestUrl({
      url: 'https://api.github.com' + path, method, headers,
      body: body ? JSON.stringify(body) : undefined, throw: false,
    });
    if (r.status >= 400) {
      const msg = (r.json && r.json.message) || r.text || '';
      const e = new Error(`GitHub ${r.status}: ${msg}`);
      e.status = r.status;
      throw e;
    }
    return r.json;
  }

  encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  async remoteTree() {
    const { repo, branch } = this.settings;
    let t;
    try {
      t = await this.api('GET', `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    } catch (e) {
      if (e.status === 404) return new Map();  // 空リポジトリ or ブランチ未作成
      throw e;
    }
    if (t.truncated) new Notice('obgit: リポジトリが大きすぎて一部のファイルしか取得できませんでした');
    return new Map(t.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
  }

  async blob(sha) {
    const b = await this.api('GET', `/repos/${this.settings.repo}/git/blobs/${sha}`);
    return base64ToArrayBuffer(b.content.replace(/\s/g, ''));
  }

  async write(path, buf) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) return this.app.vault.modifyBinary(existing, buf);
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    }
    return this.app.vault.createBinary(path, buf);
  }

  async push(path, file, remoteSha) {
    const body = {
      message: `${this.settings.device}: ${path}`,
      content: arrayBufferToBase64(await this.app.vault.readBinary(file)),
      branch: this.settings.branch,
    };
    if (remoteSha) body.sha = remoteSha;
    const r = await this.api('PUT', `/repos/${this.settings.repo}/contents/${this.encodePath(path)}`, body);
    return r.content.sha;
  }

  // .gitignore (無ければ作る) と設定の追加パターンを合わせたマッチャ
  async ignoreMatcher() {
    const a = this.app.vault.adapter;
    if (!(await a.exists(IGNORE_FILE))) {
      await a.write(IGNORE_FILE, DEFAULT_IGNORE);
      new Notice(`obgit: ${IGNORE_FILE} を作成しました`);
    }
    const text = await a.read(IGNORE_FILE);
    return makeIgnore([...text.split('\n'), ...this.settings.exclude.split('\n')]);
  }

  async remove(path, remoteSha) {
    await this.api('DELETE', `/repos/${this.settings.repo}/contents/${this.encodePath(path)}`, {
      message: `${this.settings.device}: delete ${path}`,
      sha: remoteSha,
      branch: this.settings.branch,
    });
  }

  async sync() {
    if (this.syncing) return;
    const { token, repo } = this.settings;
    if (!token || !repo) { new Notice('obgit: 設定でトークンとリポジトリを指定してください'); return; }
    this.syncing = true;
    this.status.setText('obgit: 同期中…');
    const n = { pull: 0, push: 0, del: 0, conflict: 0 };
    try {
      const ignore = await this.ignoreMatcher();
      const remote = await this.remoteTree();
      const locals = new Map(this.app.vault.getFiles().map(f => [f.path, f]));
      const paths = [...new Set([...remote.keys(), ...locals.keys()])]
        .filter(p => !p.startsWith('.') && !p.startsWith(CONFLICT_DIR + '/') && !ignore(p))
        .sort();

      for (const p of paths) {
        const file = locals.get(p);
        const ls = file ? await blobSha(await this.app.vault.readBinary(file)) : null;
        const rs = remote.get(p) || null;
        const base = this.settings.base[p];
        switch (decide(ls, rs, base)) {
          case 'none':
            if (ls && ls === rs) this.settings.base[p] = ls;
            break;
          case 'pull':
            await this.write(p, await this.blob(rs));
            this.settings.base[p] = rs;
            n.pull++;
            break;
          case 'push':
            this.settings.base[p] = await this.push(p, file, rs);
            n.push++;
            break;
          case 'delRemote':
            await this.remove(p, rs);
            delete this.settings.base[p];
            n.del++;
            break;
          case 'delLocal':
            await this.app.fileManager.trashFile(file);
            delete this.settings.base[p];
            n.del++;
            break;
          case 'conflict':
            await this.write(`${CONFLICT_DIR}/${p}`, await this.blob(rs));
            n.conflict++;
            break;
        }
      }
      // 両方で消えたパスの記録を捨てる
      for (const p of Object.keys(this.settings.base)) {
        if (!remote.has(p) && !locals.has(p)) delete this.settings.base[p];
      }
      await this.saveData(this.settings);
      const msg = `↓${n.pull} ↑${n.push} ✕${n.del} ⚠${n.conflict}`;
      this.status.setText(`obgit: ${msg}`);
      new Notice(`obgit: 同期完了 ${msg}` + (n.conflict ? `\n競合は ${CONFLICT_DIR}/ にリモート版を書き出しました` : ''));
    } catch (e) {
      await this.saveData(this.settings);  // 途中まで進んだ分は残す
      this.status.setText('obgit: エラー');
      new Notice('obgit: ' + e.message);
    } finally {
      this.syncing = false;
    }
  }
}

class ObGitSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  field(name, desc, key, password) {
    new Setting(this.containerEl).setName(name).setDesc(desc).addText(t => {
      if (password) t.inputEl.type = 'password';
      t.setValue(this.plugin.settings[key]).onChange(async v => {
        this.plugin.settings[key] = v.trim();
        await this.plugin.saveData(this.plugin.settings);
      });
      if (key === 'token' || key === 'repo') t.inputEl.addEventListener('blur', () => this.check());
    });
  }

  display() {
    this.containerEl.empty();
    this.field('GitHub トークン', 'repo スコープの Personal Access Token。入力欄を離れると疎通確認します', 'token', true);
    this.field('リポジトリ', 'owner/repo の形式', 'repo');
    this.field('ブランチ', '', 'branch');
    this.field('端末名', 'コミットメッセージに使います', 'device');
    new Setting(this.containerEl).setName('追加の除外パターン')
      .setDesc(`${IGNORE_FILE} に加えて除外するパターン。1行に1つ`)
      .addTextArea(t => t.setValue(this.plugin.settings.exclude).onChange(async v => {
        this.plugin.settings.exclude = v;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl).setName('接続確認').addButton(b => b.setButtonText('確認').onClick(() => this.check()));
    this.result = this.containerEl.createDiv({ cls: 'setting-item-description' });
    if (this.plugin.settings.token && this.plugin.settings.repo) this.check();
  }

  async check() {
    const { token, repo } = this.plugin.settings;
    if (!token || !repo) { this.result.setText('トークンとリポジトリを入力してください'); this.result.style.color = ''; return; }
    this.result.setText('確認中…');
    try {
      const r = await this.plugin.api('GET', `/repos/${repo}`);
      if (r.permissions && !r.permissions.push) throw new Error('このリポジトリへの書き込み権限がありません');
      this.result.setText(`✓ ${r.full_name} に接続できました`);
      this.result.style.color = 'var(--text-success)';
    } catch (e) {
      this.result.setText(`⚠ ${e.message}`);
      this.result.style.color = 'var(--text-error)';
      new Notice('obgit: トークンまたはリポジトリが無効です — ' + e.message);
    }
  }
}

module.exports = ObGitPlugin;
module.exports.decide = decide;
module.exports.blobSha = blobSha;
module.exports.makeIgnore = makeIgnore;
