using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using static Kagibako.Native;

namespace Kagibako;

/// <summary>
/// Kagibako（鍵箱）のデスクトップ版。スマホ版と同じ app フォルダの画面を WebView2 で表示する。
/// ・アプリ内は https://kagibako.example/ という端末内だけの仮想ホストで提供（ネットワークには出ない）
/// ・外部サイトへの移動は禁止し、URL を開く操作は既定のブラウザに渡す
/// ・PC版だけの機能（自動入力・ホットキー・タスクトレイ・自動バックアップ）は、画面からのメッセージで実行する
/// ・端末内データ（暗号化済みの控え等）は %LOCALAPPDATA%\Kagibako に保存
/// </summary>
public sealed class MainForm : Form
{
    private const string Host = "kagibako.example";
    private static readonly string Origin = $"https://{Host}/";
    private static readonly string StartUrl = $"{Origin}index.html";
    private const int HotkeyId = 1;

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly string _dataDir;
    private readonly RegisteredWaitHandle? _activateWait;
    private int _clipToken;
    private bool _typing;
    private TaskCompletionSource<string>? _closeWait;
    private static readonly string DefaultBackupDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Kagibako", "backup");

    private const int DefaultWidth = 720, DefaultHeight = 520;
    private readonly NotifyIcon _tray = new();
    private readonly uint _myPid = (uint)Environment.ProcessId;
    private WinEventProc? _winEventProc; // GC されないよう保持
    private IntPtr _winEventHook;
    private IntPtr _lastExternal;        // 最後に前面だった「他のアプリ」のウィンドウ
    private IntPtr _hotkeyTarget;        // ホットキーを押したときに前面だったウィンドウ
    private bool _hotkeyRegistered;
    private bool _closeToTray;
    private bool _minimizeToTray;      // 最小化したらタスクバーから消して、タスクトレイにしまう
    private FormWindowState _lastShownState = FormWindowState.Normal; // トレイから戻すときの状態（最大化など）
    private bool _trayNoticeShown;
    private bool _allowClose;
    private bool _exitRequested;

    public MainForm(string dataDir, EventWaitHandle activate)
    {
        _dataDir = dataDir;
        // 起動直前まで使っていたウィンドウ（ログイン画面を開いたブラウザ等）を、自動入力の入力先にしておく
        _lastExternal = FindPreviousWindow();
        // 2つ目の起動が来たら前面に出る
        _activateWait = ThreadPool.RegisterWaitForSingleObject(activate, (_, _) =>
        {
            try { BeginInvoke(BringToFront_); } catch { /* 終了中 */ }
        }, null, -1, false);
        Text = "Kagibako";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        // 小さめの大きさ。画面の拡大率に合わせて大きさを変える
        MinimumSize = new Size(LogicalToDeviceUnits(360), LogicalToDeviceUnits(320));
        Size = new Size(LogicalToDeviceUnits(DefaultWidth), LogicalToDeviceUnits(DefaultHeight));
        StartPosition = FormStartPosition.CenterScreen;
        RestoreBounds_();
        Controls.Add(_web);
        SetupTray();
        Load += async (_, _) => await InitAsync();
        Resize += (_, _) =>
        {
            if (WindowState != FormWindowState.Minimized) { _lastShownState = WindowState; return; }
            if (!_typing) Emit("minimized", new { });
            if (_minimizeToTray && Visible) BeginInvoke(HideToTray);
        };
        FormClosing += OnFormClosing;
        FormClosed += (_, _) => Cleanup();
    }

    // ================= WebView2 =================
    private async Task InitAsync()
    {
        try
        {
            Directory.CreateDirectory(_dataDir);
            var options = new CoreWebView2EnvironmentOptions { Language = "ja" };
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "WebView2"), options);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Microsoft Edge WebView2 ランタイムが見つかりません。\nMicrosoft の配布ページからインストールしてください。",
                "Kagibako", MessageBoxButtons.OK, MessageBoxIcon.Error);
            OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/");
            _allowClose = true;
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        var s = core.Settings;
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = false;
#endif
        s.AreBrowserAcceleratorKeysEnabled = false; // F5 再読み込み・Ctrl+P 等のブラウザ用ショートカットを無効化
        s.IsStatusBarEnabled = false;
        s.IsPasswordAutosaveEnabled = false;         // ブラウザ側にパスワードを覚えさせない
        s.IsGeneralAutofillEnabled = false;
        s.AreHostObjectsAllowed = false;
        s.IsWebMessageEnabled = true;                // 画面⇔PC版機能の連携（送信元を必ず確認する）
        s.IsSwipeNavigationEnabled = false;

        var appDir = Path.Combine(AppContext.BaseDirectory, "app");
        core.SetVirtualHostNameToFolderMapping(Host, appDir, CoreWebView2HostResourceAccessKind.DenyCors);

        // アプリ外への移動はすべて止め、http(s) のリンクだけ既定のブラウザで開く
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase))
            {
                e.Cancel = true;
                OpenExternal(e.Uri);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.DocumentTitleChanged += (_, _) => Text = core.DocumentTitle;
        core.WebMessageReceived += OnWebMessage;
        core.Navigate(StartUrl);

        // 他のアプリの前面切り替えを監視（自動入力の入力先を知るため）
        _winEventProc = OnForegroundChanged;
        _winEventHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _winEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);

        // Windows のロック・スリープ・サインアウトで Kagibako もロックする
        Microsoft.Win32.SystemEvents.SessionSwitch += OnSessionSwitch;
        Microsoft.Win32.SystemEvents.PowerModeChanged += OnPowerModeChanged;
    }

    private void OnSessionSwitch(object? sender, Microsoft.Win32.SessionSwitchEventArgs e)
    {
        if (e.Reason is Microsoft.Win32.SessionSwitchReason.SessionLock or Microsoft.Win32.SessionSwitchReason.ConsoleDisconnect
            or Microsoft.Win32.SessionSwitchReason.RemoteDisconnect or Microsoft.Win32.SessionSwitchReason.SessionLogoff)
            RequestLock();
    }

    private void OnPowerModeChanged(object? sender, Microsoft.Win32.PowerModeChangedEventArgs e)
    {
        if (e.Mode == Microsoft.Win32.PowerModes.Suspend) RequestLock();
    }

    private void RequestLock()
    {
        try { BeginInvoke(() => Emit("systemLock", new { })); } catch { /* 終了中 */ }
    }

    /// <summary>重なり順で一番上にある「他のアプリ」の通常ウィンドウ</summary>
    private IntPtr FindPreviousWindow()
    {
        var found = IntPtr.Zero;
        EnumWindows((h, _) =>
        {
            if (!IsExternalCandidate(h) || IsCloaked(h)) return true;
            if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if (WindowTitle(h).Length == 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private void OnForegroundChanged(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (IsExternalCandidate(hwnd)) _lastExternal = GetAncestor(hwnd, GA_ROOT);
    }

    private bool IsExternalCandidate(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return false;
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == _myPid) return false;
        var cls = ClassName(hwnd);
        return cls is not ("Shell_TrayWnd" or "Shell_SecondaryTrayWnd" or "Progman" or "WorkerW" or "NotifyIconOverflowWindow"
            or "Windows.UI.Core.CoreWindow" or "TopLevelWindowForOverflowXamlIsland" or "XamlExplorerHostIslandWindow");
    }

    private static void OpenExternal(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp))
        {
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        }
    }

    // ================= 画面からのメッセージ =================
    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return; // アプリ以外からは受け付けない
        JsonDocument doc;
        try { doc = JsonDocument.Parse(e.WebMessageAsJson); } catch { return; }
        using (doc)
        {
            var m = doc.RootElement;
            if (!m.TryGetProperty("id", out var idEl) || !m.TryGetProperty("type", out var typeEl)) return;
            var id = idEl.GetInt32();
            try
            {
                object? result = typeEl.GetString() switch
                {
                    "hello" => new { version = Application.ProductVersion, defaultBackupDir = DefaultBackupDir },
                    "config" => Configure(m),
                    "getTarget" => TargetInfo(Str(m, "which") == "hotkey" ? _hotkeyTarget : _lastExternal),
                    "targetUrl" => await TargetUrlAsync(Str(m, "which") == "hotkey" ? _hotkeyTarget : _lastExternal),
                    "probeBrowser" => await BrowserUrl.ProbeAsync(_lastExternal),
                    "autotype" => await AutoTypeAsync(m),
                    // 自動入力のあと最小化している間でも見えるよう、入力先のウィンドウの上に案内を出す（入力位置は奪わない）
                    "notice" => ShowNotice(m),
                    // 自動入力がエラーで止まったときなど、Kagibako の画面を元に戻して前に出す
                    "show" => ShowSelf(),
                    // メニューの「Kagibako を終了」：× はトレイにしまうので、終了はここかトレイの右クリックから
                    "quit" => Quit(),
                    // パスワード欄に入ったとき：日本語入力をオフにする（変換された文字がパスワードに入らないように）
                    "imeOff" => ImeOff(),
                    "backup" => Backup(m),
                    "copy" => Copy(m),
                    "openUrl" => OpenUrl(m),
                    "mailto" => MailTo(m),
                    "openPath" => OpenPath(m),
                    "topMost" => SetTopMost(m),
                    "closeReady" => CloseReady(m),
                    "pickFolder" => PickFolder(Str(m, "initial")),
                    "openFolder" => OpenFolder(Str(m, "dir")),
                    _ => throw new InvalidOperationException("未対応の要求です"),
                };
                Reply(id, true, result, null);
            }
            catch (Exception ex)
            {
                Reply(id, false, null, ex.Message);
            }
        }
    }

    private static string Str(JsonElement m, string name) =>
        m.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static int Int(JsonElement m, string name, int def) =>
        m.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;

    private static bool Bool(JsonElement m, string name) =>
        m.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private void Reply(int id, bool ok, object? result, string? error) =>
        Post(new { replyTo = id, ok, result, error });

    private void Emit(string ev, object data) => Post(new { @event = ev, data });

    private void Post(object o)
    {
        try { _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(o)); } catch { /* 画面がまだ無い */ }
    }

    private static object TargetInfo(IntPtr h) =>
        h != IntPtr.Zero && IsWindow(h) ? new { ok = true, title = WindowTitle(h) } : new { ok = false, title = "" };

    // ---- 設定（ホットキー・トレイ） ----
    private object Configure(JsonElement m)
    {
        _closeToTray = Bool(m, "closeToTray");
        _minimizeToTray = Bool(m, "minimizeToTray");
        _tray.Visible = _closeToTray || _minimizeToTray;
        if (!_tray.Visible && !Visible) BringToFront_(false); // トレイをやめたのに隠れたままにならないように
        if (_hotkeyRegistered) { UnregisterHotKey(Handle, HotkeyId); _hotkeyRegistered = false; }
        var hk = Str(m, "hotkey");
        if (string.IsNullOrWhiteSpace(hk)) return new { hotkey = "" };
        var (mods, vk) = ParseHotkey(hk);
        if (!RegisterHotKey(Handle, HotkeyId, mods | MOD_NOREPEAT, vk))
            throw new InvalidOperationException($"ホットキー {hk} は他のアプリが使っているため登録できませんでした。別のキーを選んでください。");
        _hotkeyRegistered = true;
        return new { hotkey = hk };
    }

    private static (uint mods, uint vk) ParseHotkey(string s)
    {
        uint mods = 0, vk = 0;
        foreach (var raw in s.ToLowerInvariant().Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw)
            {
                case "ctrl": mods |= MOD_CONTROL; break;
                case "alt": mods |= MOD_ALT; break;
                case "shift": mods |= MOD_SHIFT; break;
                case "win": mods |= MOD_WIN; break;
                case "space": vk = 0x20; break;
                default:
                    if (raw.Length == 1 && char.IsLetterOrDigit(raw[0])) vk = char.ToUpperInvariant(raw[0]);
                    else if (raw.StartsWith('f') && int.TryParse(raw[1..], out var n) && n is >= 1 and <= 12) vk = (uint)(0x70 + n - 1);
                    else throw new InvalidOperationException($"ホットキーの指定が正しくありません: {s}");
                    break;
            }
        }
        if (vk == 0 || mods == 0) throw new InvalidOperationException($"ホットキーには Ctrl/Alt/Shift/Win とキーの組み合わせが必要です: {s}");
        return (mods, vk);
    }

    protected override void WndProc(ref Message m)
    {
        // 最小化ボタン：タスクトレイにしまう設定なら、タスクバーへ縮む標準の動きではなく、時計の横へ縮む動きで隠す
        const int WM_SYSCOMMAND = 0x0112, SC_MINIMIZE = 0xF020;
        if (m.Msg == WM_SYSCOMMAND && ((int)m.WParam & 0xFFF0) == SC_MINIMIZE && _minimizeToTray && Visible && !_typing)
        {
            TrayMotion.ShrinkToTray(this, () =>
            {
                _lastShownState = WindowState;
                Hide();
            });
            Emit("minimized", new { });
            ShowTrayNoticeOnce("タスクトレイにしまいました。アイコンをクリックすると戻ります。");
            return;
        }
        if (m.Msg == WM_HOTKEY && (int)m.WParam == HotkeyId)
        {
            var fg = GetForegroundWindow();
            _hotkeyTarget = IsExternalCandidate(fg) ? GetAncestor(fg, GA_ROOT) : _lastExternal;
            BringToFront_();
            Emit("hotkey", TargetInfo(_hotkeyTarget));
            return;
        }
        base.WndProc(ref m);
    }

    private object ShowNotice(JsonElement m)
    {
        var text = Str(m, "text");
        if (text.Length > 300) text = text[..300];
        var target = Str(m, "which") == "hotkey" ? _hotkeyTarget : _lastExternal;
        NoticeForm.ShowNear(target, text, Int(m, "ms", 7000), Bool(m, "warn"));
        return new { };
    }

    private object ImeOff()
    {
        var info = new GUITHREADINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<GUITHREADINFO>() };
        if (!GetGUIThreadInfo(0, ref info) || info.hwndFocus == IntPtr.Zero) return new { ok = false };
        // いま入力位置がある窓が Kagibako の中（WebView2 の表示部分）のときだけ。よそのアプリの日本語入力には触らない
        if (GetAncestor(info.hwndFocus, GA_ROOT) != Handle) return new { ok = false };
        var ime = ImmGetDefaultIMEWnd(info.hwndFocus);
        if (ime == IntPtr.Zero) return new { ok = false };
        var wasOpen = SendMessage(ime, WM_IME_CONTROL, (IntPtr)IMC_GETOPENSTATUS, IntPtr.Zero) != IntPtr.Zero;
        if (wasOpen) SendMessage(ime, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, IntPtr.Zero);
        return new { ok = true, wasOpen };
    }

    private object Quit()
    {
        BeginInvoke(() => { _exitRequested = true; Close(); });
        return new { };
    }

    private object ShowSelf()
    {
        BringToFront_();
        return new { };
    }

    /// <summary>最小化したとき：タスクバーから消してタスクトレイにしまう（× の終了とは別。常駐はしない）</summary>
    private void HideToTray()
    {
        if (WindowState != FormWindowState.Minimized || !_minimizeToTray) return;
        Hide();
        ShowTrayNoticeOnce("タスクトレイにしまいました。アイコンをクリックすると戻ります。");
    }

    private void ShowTrayNoticeOnce(string text)
    {
        if (_trayNoticeShown) return;
        _tray.ShowBalloonTip(3000, "Kagibako", text, ToolTipIcon.Info);
        _trayNoticeShown = true;
    }

    private bool _growing;

    private void BringToFront_(bool animate = true)
    {
        if (!Visible && animate)
        {
            // トレイから戻す：時計の横から広がる動きのあとで窓を出す（動きの途中で何度押されても1回だけ）
            if (_growing) return;
            if (WindowState == FormWindowState.Minimized) WindowState = _lastShownState;
            _growing = true;
            TrayMotion.GrowFromTray(this, () =>
            {
                _growing = false;
                if (IsDisposed || Disposing || _exitRequested) return;
                Show();
                Activate();
                SetForegroundWindow(Handle);
                _web.Focus();
            });
            return;
        }
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = _lastShownState;
        Activate();
        SetForegroundWindow(Handle);
        _web.Focus();
    }

    // ---- 自動入力 ----
    private async Task<object> AutoTypeAsync(JsonElement m)
    {
        var target = Bool(m, "useHotkeyTarget") ? _hotkeyTarget : _lastExternal;
        if (target == IntPtr.Zero || !IsWindow(target))
            throw new InvalidOperationException("入力先のウィンドウがありません。入力したい画面（ブラウザのログイン欄など）を一度クリックしてから、もう一度押してください。");
        if (!m.TryGetProperty("steps", out var stepsEl) || stepsEl.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("入力内容がありません");
        var steps = AutoTyper.ParseSteps(stepsEl);

        // 偽サイト対策：ブラウザなら、入力直前にアドレスバーのドメインを照合する。
        // 入力の途中でページが別のサイトへ移ることもあるので、文字を入力する直前にも毎回照合し直す。
        Func<Task>? verify = null;
        if (m.TryGetProperty("allowedDomains", out var domEl) && domEl.ValueKind == JsonValueKind.Array && domEl.GetArrayLength() > 0)
        {
            var allowed = domEl.EnumerateArray().Select(d => (d.ValueKind == JsonValueKind.String ? d.GetString() ?? "" : "").ToLowerInvariant()).Where(d => d.Length > 0).ToList();
            var allowUnverified = Bool(m, "allowUnverified");
            var requireHttps = Bool(m, "requireHttps");
            verify = async () =>
            {
                var r = await BrowserUrl.ReadAsync(target);
                if (!r.IsBrowser) return;
                var host = HostOf(r.Url);
                if (host is null)
                {
                    if (!allowUnverified || IsFullscreen(target)) throw new InvalidOperationException("URL_UNKNOWN:");
                }
                else if (!DomainAllowed(host, allowed))
                {
                    throw new InvalidOperationException("DOMAIN_MISMATCH:" + host);
                }
                else if (requireHttps && IsPlainHttp(r.Url))
                {
                    // https で登録したアイテムを、暗号化されていない http のページには入力しない（通信の書き換えで盗まれる）
                    throw new InvalidOperationException("INSECURE_HTTP:" + host);
                }
            };
            await verify();
        }

        _typing = true; // 自動入力のための最小化ではロックしない
        try
        {
            if (Bool(m, "minimize")) WindowState = FormWindowState.Minimized;
        }
        finally { BeginInvoke(() => _typing = false); }
        await AutoTyper.TypeAsync(target, steps, Int(m, "startDelay", 400), Int(m, "keyDelay", 5), Bool(m, "viaClipboard"), verify);
        return new { title = WindowTitle(target) };
    }

    private static async Task<object> TargetUrlAsync(IntPtr target)
    {
        if (target == IntPtr.Zero || !IsWindow(target)) return new { ok = false, isBrowser = false, browser = "", url = (string?)null, title = "", fullscreen = false };
        var r = await BrowserUrl.ReadAsync(target);
        return new { ok = true, isBrowser = r.IsBrowser, browser = r.Browser, url = r.Url, title = WindowTitle(target), fullscreen = IsFullscreen(target) };
    }

    /// <summary>
    /// 許可ドメインとの照合。"=example.com" は完全一致のみ（github.io のように、誰でもサブドメインを作れるもの）
    /// </summary>
    internal static bool DomainAllowed(string host, IEnumerable<string> allowed) => allowed.Any(d =>
        d.StartsWith('=') ? host == d[1..] : host == d || host.EndsWith("." + d, StringComparison.Ordinal));

    /// <summary>アドレスバーの文字列が、暗号化されていない http:// のページか（view-source: などの前置きも見る）</summary>
    internal static bool IsPlainHttp(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return false;
        var t = s.Trim();
        foreach (var pre in new[] { "view-source:", "blob:", "filesystem:" })
            while (t.StartsWith(pre, StringComparison.OrdinalIgnoreCase)) t = t[pre.Length..];
        return t.StartsWith("http://", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>アドレスバーの文字列 → ホスト名（小文字・punycode）。URL でなければ null</summary>
    internal static string? HostOf(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        // blob:https://… や view-source:https://… は中の URL で判定する
        foreach (var p in new[] { "view-source:", "blob:", "filesystem:" })
            while (s.StartsWith(p, StringComparison.OrdinalIgnoreCase)) s = s[p.Length..];
        if (s.Contains(' ')) return null; // 検索語などは URL ではない
        if (!s.Contains("://", StringComparison.Ordinal)) s = "https://" + s;
        return Uri.TryCreate(s, UriKind.Absolute, out var u) && u.IdnHost.Contains('.') ? u.IdnHost.TrimEnd('.').ToLowerInvariant() : null;
    }

    // ---- クリップボード ----
    /// <summary>
    /// パスワード等をコピーする。Windows のクリップボード履歴（Win+V）とクラウド同期には残さない印を付け、
    /// 指定秒数後に（まだ同じ内容なら）消す。
    /// </summary>
    private object Copy(JsonElement m)
    {
        var text = Str(m, "text");
        var sec = Math.Clamp(Int(m, "clearAfterSec", 30), 0, 600);
        ClipboardUtil.SetProtected(text);
        var token = ++_clipToken;
        if (sec > 0)
        {
            var t = new System.Windows.Forms.Timer { Interval = sec * 1000 };
            t.Tick += (_, _) =>
            {
                t.Stop();
                t.Dispose();
                if (token == _clipToken) ClipboardUtil.ClearIf(text); // その後に別のものをコピーしていれば消さない
            };
            t.Start();
        }
        return new { };
    }

    // ---- 外部で開く（URL・メール・ファイル） ----
    private object OpenUrl(JsonElement m)
    {
        var url = Str(m, "url");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp))
            throw new InvalidOperationException("http:// または https:// の URL のみ開けます");
        var browser = Str(m, "browser");
        if (!string.IsNullOrWhiteSpace(browser))
        {
            if (!File.Exists(browser) || !browser.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"指定したブラウザが見つかりません: {browser}");
            var psi = new ProcessStartInfo(browser) { UseShellExecute = false };
            psi.ArgumentList.Add(u.AbsoluteUri);
            Process.Start(psi);
        }
        else Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
        return new { };
    }

    private static object MailTo(JsonElement m)
    {
        var addr = Str(m, "address").Trim();
        if (addr.Length == 0 || addr.Any(c => char.IsWhiteSpace(c) || c is '<' or '>' or '"' or '?' or '&')) throw new InvalidOperationException("メールアドレスの形式が正しくありません");
        Process.Start(new ProcessStartInfo("mailto:" + Uri.EscapeDataString(addr).Replace("%40", "@")) { UseShellExecute = true });
        return new { };
    }

    /// <summary>「ファイル」欄のファイル・フォルダを関連付けられたアプリで開く（確認は画面側で済ませる）</summary>
    private static object OpenPath(JsonElement m)
    {
        var path = Environment.ExpandEnvironmentVariables(Str(m, "path").Trim().Trim('"'));
        if (path.Length == 0) throw new InvalidOperationException("ファイルが指定されていません");
        if (Uri.TryCreate(path, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps))
        {
            Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
            return new { };
        }
        if (!File.Exists(path) && !Directory.Exists(path)) throw new InvalidOperationException($"見つかりません: {path}");
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(path) ?? "" });
        return new { };
    }

    private object CloseReady(JsonElement m)
    {
        _closeWait?.TrySetResult(Str(m, "status"));
        return new { };
    }

    private object SetTopMost(JsonElement m)
    {
        TopMost = Bool(m, "on");
        return new { topMost = TopMost };
    }

    // ---- 自動バックアップ ----
    private object Backup(JsonElement m)
    {
        var text = Str(m, "text");
        if (!text.TrimStart().StartsWith('{') || !text.Contains("\"KAGI\"")) throw new InvalidOperationException("バックアップするデータが不正です");
        var dir = Str(m, "dir");
        if (string.IsNullOrWhiteSpace(dir)) dir = DefaultBackupDir;
        Directory.CreateDirectory(dir);
        var name = SafeName(Str(m, "name"));
        var rev = Int(m, "revision", 0);
        var path = Path.Combine(dir, $"{name}_{DateTime.Now:yyyyMMdd-HHmmss}_r{rev}.kagi");
        File.WriteAllText(path, text, new UTF8Encoding(false));
        var keep = Math.Clamp(Int(m, "keep", 30), 1, 1000);
        var old = new DirectoryInfo(dir).GetFiles($"{name}_*_r*.kagi")
            .OrderByDescending(f => f.LastWriteTimeUtc).Skip(keep);
        foreach (var f in old) { try { f.Delete(); } catch { /* 使用中などは次回 */ } }
        return new { path, dir };
    }

    private static string SafeName(string s)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string((s ?? "").Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim(' ', '.');
        if (cleaned.Length == 0) cleaned = "kagibako";
        return cleaned.Length > 60 ? cleaned[..60] : cleaned;
    }

    private object PickFolder(string initial)
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "バックアップを保存するフォルダを選んでください",
            UseDescriptionForTitle = true,
            InitialDirectory = Directory.Exists(initial) ? initial : (Directory.Exists(DefaultBackupDir) ? DefaultBackupDir : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)),
            ShowNewFolderButton = true,
        };
        return new { path = dlg.ShowDialog(this) == DialogResult.OK ? dlg.SelectedPath : "" };
    }

    private static object OpenFolder(string dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) dir = DefaultBackupDir;
        Directory.CreateDirectory(dir);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
        return new { dir };
    }

    // ================= タスクトレイ =================
    private void SetupTray()
    {
        _tray.Icon = Icon;
        _tray.Text = "Kagibako";
        var menu = new ContextMenuStrip();
        menu.Items.Add("開く", null, (_, _) => BringToFront_());
        menu.Items.Add("自動入力…", null, (_, _) =>
        {
            _hotkeyTarget = _lastExternal;
            BringToFront_();
            Emit("hotkey", TargetInfo(_hotkeyTarget));
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("終了", null, (_, _) => { _exitRequested = true; BringToFront_(false); Close(); });
        _tray.ContextMenuStrip = menu;
        _tray.DoubleClick += (_, _) => BringToFront_();
        // 1回のクリックで戻す（右クリックはメニュー）
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) BringToFront_(); };
    }

    // ================= 終了 =================
    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        SaveBounds();
        if (_allowClose || _web.CoreWebView2 is null) return;
        if (e.CloseReason is CloseReason.WindowsShutDown or CloseReason.TaskManagerClosing)
        {
            // シャットダウン時は確認できないので、未保存の変更を暗号化して一時保存（次回のロック解除後に復元を案内）してから終わる
            e.Cancel = true;
            try { await _web.CoreWebView2.ExecuteScriptAsync("window.__kagibakoEmergencyLock && window.__kagibakoEmergencyLock()"); } catch { }
            await Task.Delay(1500);
            _allowClose = true;
            Close();
            return;
        }
        if (_closeToTray && !_exitRequested && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            Emit("minimized", new { }); // 「最小化したらロックする」設定なら、× でしまったときもロックする
            if (!_trayNoticeShown)
            {
                _tray.ShowBalloonTip(3000, "Kagibako", "タスクトレイで動いています。終了はトレイのアイコンを右クリック →「終了」。", ToolTipIcon.Info);
                _trayNoticeShown = true;
            }
            return;
        }
        e.Cancel = true;
        _exitRequested = false;
        var dirty = "false";
        try
        {
            dirty = await _web.CoreWebView2.ExecuteScriptAsync("!!(window.__kagibakoIsDirty && window.__kagibakoIsDirty())");
            if (dirty == "true")
            {
                // 「終了時に自動保存する」設定なら、画面側で保存してもらい結果を待つ
                _closeWait = new TaskCompletionSource<string>();
                var started = await _web.CoreWebView2.ExecuteScriptAsync("!!(window.__kagibakoAutoSaveOnClose && window.__kagibakoAutoSaveOnClose())");
                if (started == "true")
                {
                    var done = await Task.WhenAny(_closeWait.Task, Task.Delay(30000));
                    if (done == _closeWait.Task && _closeWait.Task.Result == "saved") dirty = "false";
                }
                _closeWait = null;
            }
        }
        catch { /* 判定できなければ未変更扱い */ }
        if (dirty == "true" &&
            MessageBox.Show(this, "未保存の変更があります。保存せずに終了しますか？", "Kagibako",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            return;
        }
        _allowClose = true;
        Close();
    }

    private void Cleanup()
    {
        if (_hotkeyRegistered) UnregisterHotKey(Handle, HotkeyId);
        if (_winEventHook != IntPtr.Zero) UnhookWinEvent(_winEventHook);
        Microsoft.Win32.SystemEvents.SessionSwitch -= OnSessionSwitch;
        Microsoft.Win32.SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        _activateWait?.Unregister(null);
        _tray.Visible = false;
        _tray.Dispose();
    }

    // ---- ウィンドウ位置の保存・復元 ----
    private string BoundsFile => Path.Combine(_dataDir, "window.json");

    private sealed record SavedBounds(int X, int Y, int W, int H, bool Maximized);

    private void RestoreBounds_()
    {
        try
        {
            if (!File.Exists(BoundsFile)) return;
            var st = JsonSerializer.Deserialize<SavedBounds>(File.ReadAllText(BoundsFile));
            if (st is null) return;
            var rect = new Rectangle(st.X, st.Y, st.W, st.H);
            // 以前の既定の大きさ（940×640）のままなら、新しい小さめの既定に改める（自分で大きさを変えていた場合はそのまま）
            if (st.W == 940 && st.H == 640) rect.Size = Size;
            if (!Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(rect))) return; // 画面外に出ないように
            StartPosition = FormStartPosition.Manual;
            Bounds = rect;
            if (st.Maximized) WindowState = FormWindowState.Maximized;
        }
        catch { /* 壊れていたら既定値 */ }
    }

    private void SaveBounds()
    {
        try
        {
            Directory.CreateDirectory(_dataDir);
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(
                new SavedBounds(b.X, b.Y, b.Width, b.Height, WindowState == FormWindowState.Maximized)));
        }
        catch { /* 保存できなくても終了は続行 */ }
    }
}
