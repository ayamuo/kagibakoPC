using System.Diagnostics;
using System.Text;
using System.Windows.Automation;
using static Kagibako.Native;

namespace Kagibako;

/// <summary>
/// ブラウザのアドレスバーから、いま表示しているページの URL を読み取る（偽サイト対策のドメイン照合用）。
/// ページの中身（Document 要素の下）は一切たどらない。偽サイトが「アドレスバーに見せかけた入力欄」を
/// ページ内に置いても読み取られないようにするため。
///
/// ブラウザの見分け方は2段構え：
///  1. よく知られたブラウザ（プロセス名）
///  2. 名前を知らない派生ブラウザも、エンジンで見分ける。
///     Chromium 系（ウィンドウクラス Chrome_WidgetWin_1）・Firefox 系（MozillaWindowClass）の窓で、
///     本物のアドレスバー（ページの外にある部品）が見つかればブラウザとして扱う。
///     見つからない Chromium 系の窓は、Electron 製のアプリ（Slack・VS Code など）とみなして照合しない。
///     ただし全画面のときはアドレスバーが隠れているだけかもしれないので、ブラウザとして扱う（＝入力を止める）。
/// </summary>
internal static class BrowserUrl
{
    private enum Engine { Chromium, Gecko }

    // プロセス名 → 表示名・エンジン
    private static readonly Dictionary<string, (string Name, Engine Engine)> Known = new(StringComparer.OrdinalIgnoreCase)
    {
        // Chromium 系
        ["chrome"] = ("Chrome", Engine.Chromium), ["msedge"] = ("Edge", Engine.Chromium), ["brave"] = ("Brave", Engine.Chromium),
        ["vivaldi"] = ("Vivaldi", Engine.Chromium), ["opera"] = ("Opera", Engine.Chromium), ["opera_gx"] = ("Opera GX", Engine.Chromium),
        ["chromium"] = ("Chromium", Engine.Chromium), ["thorium"] = ("Thorium", Engine.Chromium), ["whale"] = ("NAVER Whale", Engine.Chromium),
        ["sleipnir"] = ("Sleipnir", Engine.Chromium), ["arc"] = ("Arc", Engine.Chromium), ["comet"] = ("Comet", Engine.Chromium),
        ["dragon"] = ("Comodo Dragon", Engine.Chromium), ["epic"] = ("Epic", Engine.Chromium), ["maxthon"] = ("Maxthon", Engine.Chromium),
        ["avastbrowser"] = ("Avast Secure Browser", Engine.Chromium), ["avgbrowser"] = ("AVG Secure Browser", Engine.Chromium),
        ["ccleanerbrowser"] = ("CCleaner Browser", Engine.Chromium), ["nortonbrowser"] = ("Norton Private Browser", Engine.Chromium),
        ["iridium"] = ("Iridium", Engine.Chromium), ["supermium"] = ("Supermium", Engine.Chromium), ["catsxp"] = ("Catsxp", Engine.Chromium),
        ["yandex"] = ("Yandex", Engine.Chromium),
        // Firefox 系
        ["firefox"] = ("Firefox", Engine.Gecko), ["floorp"] = ("Floorp", Engine.Gecko), ["librewolf"] = ("LibreWolf", Engine.Gecko),
        ["waterfox"] = ("Waterfox", Engine.Gecko), ["zen"] = ("Zen", Engine.Gecko), ["mullvadbrowser"] = ("Mullvad Browser", Engine.Gecko),
        ["tor"] = ("Tor Browser", Engine.Gecko), ["palemoon"] = ("Pale Moon", Engine.Gecko), ["basilisk"] = ("Basilisk", Engine.Gecko),
        ["seamonkey"] = ("SeaMonkey", Engine.Gecko), ["mercury"] = ("Mercury", Engine.Gecko),
    };

    public sealed record Result(bool IsBrowser, string Browser, string? Url);

    public static Task<Result> ReadAsync(IntPtr hwnd) => Task.Run(() => Read(hwnd));

    private static Result Read(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return new Result(false, "", null);
        GetWindowThreadProcessId(hwnd, out var pid);
        Process proc;
        try { proc = Process.GetProcessById((int)pid); } catch { return new Result(false, "", null); }
        var procName = proc.ProcessName;

        var cls = WindowClass(hwnd);
        Engine? engine = cls == "Chrome_WidgetWin_1" ? Engine.Chromium : cls == "MozillaWindowClass" ? Engine.Gecko : null;
        var known = Known.TryGetValue(procName, out var k);
        if (known) engine ??= k.Engine;
        if (engine is null) return new Result(false, "", null); // ブラウザのエンジンではない（メモ帳など）

        var name = known ? k.Name : ProductName(proc) ?? procName;
        string? url = null;
        // ブラウザによっては、外から最初に問い合わせたときに部品の一覧を作り始める（Vivaldi など）。
        // よく知られたブラウザで読めなかったときだけ、少し待って読み直す（Electron 製アプリでは待たない）
        for (var attempt = 0; attempt < (known ? 3 : 1) && url is null; attempt++)
        {
            if (attempt > 0) Thread.Sleep(600);
            try { url = FindAddressBar(AutomationElement.FromHandle(hwnd), engine.Value); } catch { /* 読めない */ }
            url = string.IsNullOrWhiteSpace(url) ? null : url.Trim();
        }

        if (known || url is not null) return new Result(true, name, url);
        // 名前を知らない Chromium / Firefox 系で、アドレスバーが見つからない
        return IsFullscreen(hwnd) ? new Result(true, name, null) : new Result(false, "", null);
    }

    /// <summary>
    /// 「ブラウザの読み取りテスト」用：判定結果と、ページの外にある入力欄の部品名を返す。
    /// 入力欄に入っている値（検索語など）は返さない。アドレスバーが読めたときだけ、その URL を返す。
    /// </summary>
    public static Task<object> ProbeAsync(IntPtr hwnd) => Task.Run<object>(() =>
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return new { ok = false };
        var r = Read(hwnd);
        GetWindowThreadProcessId(hwnd, out var pid);
        string procName = "", product = "";
        try { var p = Process.GetProcessById((int)pid); procName = p.ProcessName; product = ProductName(p) ?? ""; } catch { /* 無視 */ }
        var edits = new List<object>();
        var documents = 0;
        try
        {
            var walker = TreeWalker.ControlViewWalker;
            var queue = new Queue<(AutomationElement el, int depth)>();
            queue.Enqueue((AutomationElement.FromHandle(hwnd), 0));
            var visited = 0;
            while (queue.Count > 0 && visited < 4000 && edits.Count < 30)
            {
                var (el, depth) = queue.Dequeue();
                visited++;
                AutomationElement.AutomationElementInformation info;
                try { info = el.Current; } catch { continue; }
                if (info.ControlType == ControlType.Document) { documents++; continue; }
                if (info.ControlType == ControlType.Edit || info.ControlType == ControlType.ComboBox)
                    edits.Add(new { type = info.ControlType.ProgrammaticName.Replace("ControlType.", ""), cls = info.ClassName, aid = info.AutomationId, name = info.Name, fw = info.FrameworkId, depth });
                if (depth >= 25) continue;
                AutomationElement? child;
                try { child = walker.GetFirstChild(el); } catch { continue; }
                while (child is not null)
                {
                    queue.Enqueue((child, depth + 1));
                    try { child = walker.GetNextSibling(child); } catch { break; }
                }
            }
        }
        catch { /* 無視 */ }
        return new
        {
            ok = true, isBrowser = r.IsBrowser, browser = r.Browser, url = r.Url,
            process = procName, product, windowClass = WindowClass(hwnd), fullscreen = IsFullscreen(hwnd),
            documents, edits,
        };
    });

    private static string WindowClass(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        return GetClassName(hwnd, sb, sb.Capacity) > 0 ? sb.ToString() : "";
    }

    private static string? ProductName(Process p)
    {
        try
        {
            var path = p.MainModule?.FileName;
            if (path is null) return null;
            var v = FileVersionInfo.GetVersionInfo(path);
            return string.IsNullOrWhiteSpace(v.ProductName) ? null : v.ProductName.Trim();
        }
        catch { return null; }
    }

    /// <summary>本物のアドレスバーか（ページの外＝ブラウザ自身の部品であることは、Document の下をたどらないことで保証する）</summary>
    private static bool IsAddressBar(AutomationElement.AutomationElementInformation info, Engine engine) => engine switch
    {
        // Chrome / Edge は "OmniboxViewViews"、Brave は "BraveOmniboxViewViews" など、派生ブラウザは名前の前に独自の語が付く。
        // Opera は独自の "AddressTextfieldView"
        Engine.Chromium => (info.ClassName ?? "").EndsWith("OmniboxViewViews", StringComparison.Ordinal) || info.ClassName == "AddressTextfieldView",
        // Firefox とその派生（Floorp・LibreWolf・Zen など）は "urlbar-input"、古い系統（Pale Moon など）は "urlbar"
        _ => info.AutomationId is "urlbar-input" or "urlbar",
    };

    /// <summary>
    /// Vivaldi の画面（タブ・アドレスバーなど）は、Vivaldi 自身の拡張機能のページとして作られている。
    /// このページのアドレス（chrome-extension://＜Vivaldi の ID＞/）は Vivaldi 以外には名乗れない。
    /// その中だけはたどるが、中に入れ子になったページ（表示中の Web サイト）はたどらない。
    /// </summary>
    private const string VivaldiUiOrigin = "chrome-extension://mpognobbkildjkofajifpdfhcoklimli/";

    private static bool IsVivaldiUi(AutomationElement doc)
    {
        try { return doc.TryGetCurrentPattern(ValuePattern.Pattern, out var p) && ((ValuePattern)p).Current.Value.StartsWith(VivaldiUiOrigin, StringComparison.Ordinal); }
        catch { return false; }
    }

    private static string? FindAddressBar(AutomationElement root, Engine engine)
    {
        var walker = TreeWalker.ControlViewWalker;
        var queue = new Queue<(AutomationElement el, int depth, bool inVivaldiUi)>();
        queue.Enqueue((root, 0, false));
        var visited = 0;
        while (queue.Count > 0 && visited < 4000)
        {
            var (el, depth, inVivaldiUi) = queue.Dequeue();
            visited++;
            AutomationElement.AutomationElementInformation info;
            try { info = el.Current; } catch { continue; }
            var enterVivaldiUi = false;
            if (info.ControlType == ControlType.Document)
            {
                // ページの中身は見ない。例外は、いちばん外側にある Vivaldi 自身の画面だけ
                if (engine != Engine.Chromium || inVivaldiUi || !IsVivaldiUi(el)) continue;
                enterVivaldiUi = true;
            }
            // Firefox のアドレスバーは Edit ではなく ComboBox（候補の一覧付き）として見える
            if ((info.ControlType == ControlType.Edit || info.ControlType == ControlType.ComboBox)
                && (inVivaldiUi ? info.AutomationId == "urlFieldInput" : IsAddressBar(info, engine))
                && el.TryGetCurrentPattern(ValuePattern.Pattern, out var p))
                return ((ValuePattern)p).Current.Value;
            if (depth >= 25) continue;
            AutomationElement? child;
            try { child = walker.GetFirstChild(el); } catch { continue; }
            while (child is not null)
            {
                queue.Enqueue((child, depth + 1, inVivaldiUi || enterVivaldiUi));
                try { child = walker.GetNextSibling(child); } catch { break; }
            }
        }
        return null;
    }
}
