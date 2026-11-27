using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Kagibako;

/// <summary>
/// PC版のファイルの読み書き。ブラウザ（WebView2）の保存場所は使わず、Kagibako 自身が普通のファイルとして読み書きする。
/// ・端末内データ（設定・最近使ったファイル・端末内の控え・下書き）: data\store\&lt;種類&gt;\&lt;キーのハッシュ&gt;.json
/// ・.kagi の開く・上書き保存・名前を付けて保存: Windows のファイルの画面と直接の読み書き（一時ファイルを作らない）
/// 画面側の呼び方は Android 版と同じ（openFile / readUri / writeUri / createFile。uri はファイルのフルパス）
/// </summary>
internal sealed class HostFiles(string dataDir, IWin32Window owner)
{
    private static readonly string[] Stores = ["known", "handles", "drafts", "settings"];
    private readonly string _storeDir = Path.Combine(dataDir, "store");
    // この起動中に、利用者がファイルの画面で選んだファイル（新しく作るファイルも、ここにあれば書ける）
    private readonly HashSet<string> _picked = new(StringComparer.OrdinalIgnoreCase);

    // ================= 端末内データ =================
    public object Store(JsonElement m)
    {
        var op = Str(m, "op");
        // アプリの設定などを初期化：data\store をまるごと data\store-old-日時 に退けて、空から始める（消さないので戻せる）
        if (op == "reset")
        {
            if (!Directory.Exists(_storeDir)) return new { movedTo = (string?)null };
            var old = Path.Combine(Path.GetDirectoryName(_storeDir)!, $"store-old-{DateTime.Now:yyyyMMdd-HHmmss}");
            Directory.Move(_storeDir, old);
            return new { movedTo = old };
        }
        var store = Str(m, "store");
        if (!Stores.Contains(store)) throw new InvalidOperationException("不明な保存先です");
        var dir = Path.Combine(_storeDir, store);
        var broken = new List<string>();
        if (op == "all")
        {
            var list = new List<object>();
            if (Directory.Exists(dir))
                foreach (var f in Directory.GetFiles(dir, "*.json"))
                {
                    var e = ReadEntry(store, f, broken);
                    if (e is { } entry) list.Add(new { key = entry.Key, value = entry.Value });
                }
            return new { items = list, broken };
        }
        var key = m.TryGetProperty("key", out var k) ? k.ToString() : throw new InvalidOperationException("キーがありません");
        var path = Path.Combine(dir, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant() + ".json");
        switch (op)
        {
            case "get":
                return ReadEntry(store, path, broken) is { } hit
                    ? new { found = true, value = (JsonElement?)hit.Value, broken }
                    : new { found = false, value = (JsonElement?)null, broken };
            case "put":
                Directory.CreateDirectory(dir);
                var raw = m.TryGetProperty("value", out var v) ? v.GetRawText() : "null";
                WriteReplace(path, Encoding.UTF8.GetBytes($"{{\"key\":{JsonSerializer.Serialize(key)},\"value\":{raw}}}"));
                return new { };
            case "del":
                if (File.Exists(path)) File.Delete(path);
                return new { };
            default:
                throw new InvalidOperationException("不明な操作です");
        }
    }

    /// <summary>
    /// 1件読む。壊れていて読めないファイルは data\store\broken へ移し（消さない）、無いものとして扱う。移したものは broken に足す
    /// </summary>
    private (string Key, JsonElement Value)? ReadEntry(string store, string path, List<string> broken)
    {
        if (!File.Exists(path)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            return (doc.RootElement.GetProperty("key").GetString() ?? "", doc.RootElement.GetProperty("value").Clone());
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            var dest = Path.Combine(_storeDir, "broken", $"{store}_{DateTime.Now:yyyyMMdd-HHmmss}_{Path.GetFileName(path)}");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Move(path, dest, true);
                broken.Add(dest);
            }
            catch { broken.Add(path); } // 移せなくても、無いものとして進む
            return null;
        }
    }

    /// <summary>Kagibako の data フォルダの中のファイル：書き終わってから差し替える（途中で落ちても前の内容が残る）</summary>
    private static void WriteReplace(string path, byte[] data)
    {
        var tmp = path + ".writing";
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            fs.Write(data);
            fs.Flush(true);
        }
        File.Move(tmp, path, true);
    }

    // ================= .kagi の読み書き =================
    public object OpenFile()
    {
        using var dlg = new OpenFileDialog
        {
            Title = "ファイルを開く",
            Filter = "Kagibako のファイル (*.kagi;*.idm)|*.kagi;*.idm;*.kagi.txt;*.idm.txt|CSV (*.csv)|*.csv|すべてのファイル (*.*)|*.*",
            CheckFileExists = true,
        };
        if (dlg.ShowDialog(owner) != DialogResult.OK) return new { cancelled = true };
        _picked.Add(dlg.FileName);
        return FileResult(dlg.FileName);
    }

    /// <summary>開いたことのある .kagi / .idm を読み直す（上書き前の確認・最近使ったファイル）</summary>
    public object ReadUri(JsonElement m)
    {
        var path = FullPath(Str(m, "uri"));
        if (!IsVaultFile(path, allowIdm: true)) throw new InvalidOperationException("Kagibako のファイルではありません");
        if (!File.Exists(path)) throw new FileNotFoundException("ファイルが見つかりません（移動・削除されていないか確かめてください）");
        return FileResult(path);
    }

    /// <summary>上書き保存。すでにある .kagi か、この起動中に画面で選んだファイルだけ。一時ファイルは作らない</summary>
    public object WriteUri(JsonElement m)
    {
        var path = FullPath(Str(m, "uri"));
        if (!IsVaultFile(path, allowIdm: false)) throw new InvalidOperationException("上書きできるのは .kagi ファイルだけです");
        if (!File.Exists(path) && !_picked.Contains(path)) throw new FileNotFoundException("保存先のファイルが見つかりません（移動・削除されていないか確かめてください）");
        WriteDirect(path, Convert.FromBase64String(Str(m, "base64")));
        return new { };
    }

    /// <summary>名前を付けて保存（CSV の書き出しにも使う）。保存先は利用者が Windows の画面で選ぶ</summary>
    public object CreateFile(JsonElement m)
    {
        var name = Path.GetFileName(Str(m, "name"));
        var ext = Path.GetExtension(name).ToLowerInvariant();
        using var dlg = new SaveFileDialog
        {
            Title = "名前を付けて保存",
            FileName = name,
            Filter = ext == ".csv" ? "CSV (*.csv)|*.csv" : "Kagibako のファイル (*.kagi)|*.kagi",
            DefaultExt = ext.TrimStart('.'),
            AddExtension = true,
            OverwritePrompt = true,
        };
        if (dlg.ShowDialog(owner) != DialogResult.OK) return new { cancelled = true };
        _picked.Add(dlg.FileName);
        WriteDirect(dlg.FileName, Convert.FromBase64String(Str(m, "base64")));
        return new { uri = dlg.FileName, name = Path.GetFileName(dlg.FileName) };
    }

    /// <summary>利用者のファイルへの書き込み：一時ファイルを作らず、その場で書いて長さをそろえる（書いたあと画面側で読み直して確かめる）</summary>
    private static void WriteDirect(string path, byte[] data)
    {
        using var fs = new FileStream(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        fs.Write(data);
        fs.SetLength(data.Length);
        fs.Flush(true);
    }

    private static object FileResult(string path)
    {
        var bytes = File.ReadAllBytes(path);
        return new
        {
            uri = path,
            name = Path.GetFileName(path),
            base64 = Convert.ToBase64String(bytes),
            lastModified = new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds(),
        };
    }

    private static string FullPath(string p)
    {
        if (string.IsNullOrWhiteSpace(p) || !Path.IsPathFullyQualified(p)) throw new InvalidOperationException("ファイルの場所が正しくありません");
        return Path.GetFullPath(p);
    }

    private static bool IsVaultFile(string path, bool allowIdm)
    {
        var n = path.ToLowerInvariant();
        if (n.EndsWith(".txt")) n = n[..^4]; // 受け渡しで .txt が付いたもの（x.kagi.txt）
        return n.EndsWith(".kagi") || (allowIdm && n.EndsWith(".idm"));
    }

    private static string Str(JsonElement m, string name) =>
        m.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
}
