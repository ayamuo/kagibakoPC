using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Kagibako;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // --profile <フォルダ> で端末内データの保存先を変えられる（動作確認用。普段は指定しない）
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kagibako");
        for (var i = 0; i < args.Length - 1; i++)
            if (args[i] == "--profile") dataDir = Path.GetFullPath(args[i + 1]);

        // 二重起動の防止：2つ目は、すでに開いている Kagibako を前面に出して終わる
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dataDir.ToLowerInvariant())))[..16];
        using var mutex = new Mutex(true, $"Local\\Kagibako-{id}", out var createdNew);
        var activateName = $"Local\\Kagibako-activate-{id}";
        if (!createdNew)
        {
            try { using var ev = EventWaitHandle.OpenExisting(activateName); ev.Set(); } catch { /* 先に起動した方が終了中 */ }
            return;
        }
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, activateName);

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(dataDir, activate));
        GC.KeepAlive(mutex);
    }
}
