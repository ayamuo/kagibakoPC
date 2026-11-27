using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Kagibako;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // 作るものは、すべて Kagibako のフォルダ（exe のあるフォルダ）の中だけにする（AppData・ドキュメントには作らない）
        //   data   : 画面の部品（WebView2）の作業フォルダ（設定・最近使ったファイル・端末内の控え・下書き）と窓の位置
        //   backup : 自動バックアップの既定の置き場所（MainForm.DefaultBackupDir）
        // --profile <フォルダ> で data の場所を変えられる（動作確認用。普段は指定しない）
        var appDir = AppContext.BaseDirectory;
        var dataDir = Path.Combine(appDir, "data");
        var custom = false;
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i] == "--profile") { dataDir = Path.GetFullPath(args[i + 1]); custom = true; }

        if (!custom && !CheckAppFolder(appDir)) return;

        // 二重起動の防止：2つ目は、すでに開いている Kagibako を前面に出して終わる
        using var mutex = new Mutex(true, MutexName(dataDir), out var createdNew);
        var activateName = MutexName(dataDir).Replace("Kagibako-", "Kagibako-activate-");
        if (!createdNew)
        {
            try { using var ev = EventWaitHandle.OpenExisting(activateName); ev.Set(); } catch { /* 先に起動した方が終了中 */ }
            return;
        }
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, activateName);

        if (!custom && !MigrateFromOldPlaces(dataDir, Path.Combine(appDir, "backup"))) return;

        Application.Run(new MainForm(dataDir, activate));
        GC.KeepAlive(mutex);
    }

    private static string MutexName(string dataDir) =>
        $"Local\\Kagibako-{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dataDir.ToLowerInvariant())))[..16]}";

    /// <summary>
    /// Kagibako のフォルダに書き込めるか確かめる。zip を展開せずに開いた・Program Files に置いた などは、理由を伝えて起動しない
    /// </summary>
    private static bool CheckAppFolder(string appDir)
    {
        var full = Path.GetFullPath(appDir);
        if (full.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
        {
            Tell("zip の中から直接起動しているようです。\n\nこのままだと、設定やバックアップが一時フォルダに作られ、消えてしまいます。\nzip を右クリック →「すべて展開」で好きな場所（例: C:\\Tools\\Kagibako）に展開してから、その中の Kagibako.exe を起動してください。");
            return false;
        }
        try
        {
            var probe = Path.Combine(full, $".write-test-{Environment.ProcessId}");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch
        {
            Tell($"このフォルダには書き込めないため、起動できません。\n{full}\n\nKagibako は、設定・端末内の控え・バックアップを、Kagibako のフォルダの中（data・backup）に作ります。\nKagibako のフォルダごと、書き込める場所（例: C:\\Tools\\Kagibako）に移してから起動してください。");
            return false;
        }
    }

    /// <summary>
    /// 前の版（0.9.3 まで）は、AppData とドキュメントに作っていた。data がまだ無いときだけ、Kagibako のフォルダの中へ写す（消さない）
    /// </summary>
    private static bool MigrateFromOldPlaces(string dataDir, string backupDir)
    {
        if (Directory.Exists(dataDir)) return true;
        var oldData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kagibako");
        var oldBackup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Kagibako", "backup");
        var copyData = Directory.Exists(oldData);
        var copyBackup = Directory.Exists(oldBackup) && !Directory.Exists(backupDir);
        if (!copyData && !copyBackup) return true;

        // 前の版が起動中だと、使用中のファイルを写せない
        if (copyData && Mutex.TryOpenExisting(MutexName(oldData), out var running))
        {
            running.Dispose();
            Tell("前の版の Kagibako が起動しています。\n\n設定や端末内の控えを新しい場所へ写すため、前の版を終了してから（タスクトレイに残っていればそこからも終了）、もう一度起動してください。");
            return false;
        }
        try
        {
            if (copyData) CopyDir(oldData, dataDir);
            if (copyBackup) CopyDir(oldBackup, backupDir);
        }
        catch (Exception ex)
        {
            // 途中まで写したものは消す（次の起動でもう一度写す）。前の場所のものはそのまま
            try { if (copyData && Directory.Exists(dataDir)) Directory.Delete(dataDir, true); } catch { /* 次の起動で */ }
            try { if (copyBackup && Directory.Exists(backupDir)) Directory.Delete(backupDir, true); } catch { /* 次の起動で */ }
            Tell($"設定や端末内の控えを新しい場所へ写せませんでした（{ex.Message}）。\n前の場所のものは、そのまま残っています。\n\nほかのアプリが使っていないか確かめてから、もう一度起動してください。");
            return false;
        }
        var moved = new List<string>();
        if (copyData) moved.Add($"・{oldData}\n　→ {dataDir}");
        if (copyBackup) moved.Add($"・{oldBackup}\n　→ {backupDir}");
        Tell("この版から、Kagibako が作るもの（設定・端末内の控え・自動バックアップ）は、すべて Kagibako のフォルダの中に置きます。\n前の場所から写しました。\n\n" +
             string.Join("\n", moved) +
             "\n\n写す前の場所のフォルダは、もう使いません。いつもどおり動くのを確かめてから、消してかまいません。" +
             "\n\n今後 Kagibako を更新するときは、フォルダごと置き換えずに、新しい中身を上書きコピーしてください（data・backup フォルダを残すため）。", MessageBoxIcon.Information);
        return true;
    }

    private static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(to, Path.GetRelativePath(from, dir)));
        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(to, Path.GetRelativePath(from, file)), false);
    }

    private static void Tell(string text, MessageBoxIcon icon = MessageBoxIcon.Warning) =>
        MessageBox.Show(text, "Kagibako", MessageBoxButtons.OK, icon);
}
