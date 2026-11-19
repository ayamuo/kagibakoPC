using System.Runtime.InteropServices;
using System.Text.Json;
using static Kagibako.Native;

namespace Kagibako;

/// <summary>
/// 自動入力。指定ウィンドウを前面にして、文字は Unicode 入力・特殊キーは仮想キーで送る。
/// 安全のため、打鍵の前に毎回「入力先がまだ前面か」を確認し、違えば中止する。
/// </summary>
internal static class AutoTyper
{
    private static readonly Dictionary<string, (ushort vk, bool ext)> Keys = new()
    {
        ["TAB"] = (0x09, false), ["ENTER"] = (0x0D, false), ["SPACE"] = (0x20, false),
        ["UP"] = (0x26, true), ["DOWN"] = (0x28, true), ["LEFT"] = (0x25, true), ["RIGHT"] = (0x27, true),
        ["HOME"] = (0x24, true), ["END"] = (0x23, true), ["BACKSPACE"] = (0x08, false), ["DELETE"] = (0x2E, true),
        ["ESC"] = (0x1B, false),
    };
    private const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_V = 0x56;

    public sealed class Step
    {
        public string t { get; set; } = "";
        public string? v { get; set; }
        public int ms { get; set; }
    }

    /// <param name="viaClipboard">true なら文字はクリップボード経由（Ctrl+V）で貼り付ける（キー入力を受け付けないアプリ用）</param>
    /// <param name="verify">文字を入力する直前・入力欄を探す直前に毎回呼ぶ確認（ページのドメインが変わっていないか等）。例外を投げれば中止</param>
    public static async Task TypeAsync(IntPtr target, IReadOnlyList<Step> steps, int startDelayMs, int keyDelayMs, bool viaClipboard = false, Func<Task>? verify = null)
    {
        if (target == IntPtr.Zero || !IsWindow(target)) throw new InvalidOperationException("入力先のウィンドウが見つかりません。入力したい画面を一度クリックしてからやり直してください。");

        if (IsIconic(target)) ShowWindow(target, SW_RESTORE);
        SetForegroundWindow(target);
        await Task.Delay(Math.Clamp(startDelayMs, 50, 5000));
        await WaitModifiersReleasedAsync();
        EnsureForeground(target);

        // 日本語入力がオンだと文字が変換に巻き込まれるので、入力の間だけオフにする
        var imeWnd = FocusImeWindow(target);
        var imeWasOpen = imeWnd != IntPtr.Zero && SendMessage(imeWnd, WM_IME_CONTROL, (IntPtr)IMC_GETOPENSTATUS, IntPtr.Zero) != IntPtr.Zero;
        if (imeWasOpen) SendMessage(imeWnd, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, IntPtr.Zero);
        // スマート入力で ID 欄を見つけたら、そこへ打った ID が本当に入ったかを、次の手順（パスワード・Enter）の前に確かめる。
        // ID が入っていないままパスワードを入力・送信してしまうのを防ぐ（ページの都合で文字が消えた・入力位置がずれた など）
        System.Windows.Automation.AutomationElement? userField = null;
        var userTyped = false;
        // 2段階のログイン画面：パスワードだけの画面では ID の手順を飛ばす／ID だけの画面では ID を入れたら止まる
        var skipToNextFocus = false;
        var idOnlyPage = false;
        var submittedAfterId = false; // ID の後に Enter などを押した（次の画面へ進めた）か
        try
        {
            foreach (var s in steps)
            {
                if (skipToNextFocus)
                {
                    if (s.t != "focus") continue; // ID の文字や、その後の Enter などは打たない
                    skipToNextFocus = false;
                }
                if (userField is not null && userTyped && s.t is "text" or "focus" or "key")
                {
                    var len = await InputFields.ValueLengthAsync(userField);
                    if (len == 0) { await Task.Delay(200); len = await InputFields.ValueLengthAsync(userField); }
                    if (len == 0) throw new InvalidOperationException("ID_NOT_TYPED:");
                    userField = null; // 確かめたのは1回だけ（読めない欄 = -1 は止めない）
                }
                if (verify is not null && s.t is "text" or "focus") await verify();
                switch (s.t)
                {
                    case "delay":
                        await Task.Delay(Math.Clamp(s.ms, 0, 10000));
                        break;
                    case "key":
                        EnsureForeground(target);
                        var name = s.v ?? "";
                        var shift = name.StartsWith("SHIFT+", StringComparison.Ordinal);
                        if (shift) name = name[6..];
                        if (!Keys.TryGetValue(name, out var k)) throw new InvalidOperationException($"未対応のキー: {s.v}");
                        if (shift) KeyDown(VK_SHIFT);
                        try { SendVk(k.vk, k.ext); } finally { if (shift) KeyUp(VK_SHIFT); }
                        if (idOnlyPage && userTyped) submittedAfterId = true;
                        await Task.Delay(Math.Max(keyDelayMs, 10));
                        break;
                    case "focus":
                    {
                        // スマート入力：ID 欄／パスワード欄を探して入力位置を移す（Tab を使わない）
                        EnsureForeground(target);
                        var kind = s.v == "password" ? "password" : "user";
                        // ID だけの画面では、パスワード欄は（次へを押すまで）出てこないので長くは待たない
                        // Enter で次の画面へ進めたときは、画面が切り替わるまで長めに待つ
                        var pwWait = !idOnlyPage ? 3000 : submittedAfterId ? 6000 : 800;
                        var r = await InputFields.FocusAsync(target, kind, kind == "password" ? pwWait : 0);
                        if (kind == "user" && r == InputFields.Result.PasswordOnly) { skipToNextFocus = true; userField = null; break; }
                        if (kind == "password" && r is InputFields.Result.NotFound or InputFields.Result.Unavailable)
                            throw new InvalidOperationException(idOnlyPage && !submittedAfterId ? "ID_ONLY_PAGE:" : "PASSFIELD_NOT_FOUND:");
                        // ブラウザで ID 欄が見つからないまま ID を打つと、どこにも入らない（またはパスワード欄に入る）ので止める
                        if (kind == "user" && r == InputFields.Result.NotFound && InputFields.IsBrowserWindow(target))
                            throw new InvalidOperationException("USERFIELD_NOT_FOUND:");
                        if (r == InputFields.Result.Moved) await Task.Delay(120);
                        if (kind == "user" && r is InputFields.Result.Moved or InputFields.Result.AlreadyThere)
                        {
                            userField = InputFields.LastField;
                            userTyped = false;
                            idOnlyPage = !InputFields.LastPageHadPassword && InputFields.IsBrowserWindow(target);
                            submittedAfterId = false;
                        }
                        EnsureForeground(target);
                        break;
                    }
                    case "text" when viaClipboard:
                        EnsureForeground(target);
                        ClipboardUtil.SetProtected(s.v ?? "");
                        await Task.Delay(50);
                        EnsureForeground(target);
                        KeyDown(VK_CONTROL);
                        try { SendVk(VK_V, false); } finally { KeyUp(VK_CONTROL); }
                        await Task.Delay(Math.Max(keyDelayMs, 150));
                        ClipboardUtil.ClearIf(s.v ?? "");
                        break;
                    case "text":
                        foreach (var ch in s.v ?? "")
                        {
                            EnsureForeground(target);
                            if (ch == '\r') continue;
                            if (ch == '\n') SendVk(0x0D, false);
                            else if (ch == '\t') SendVk(0x09, false);
                            else SendUnicode(ch);
                            if (keyDelayMs > 0) await Task.Delay(keyDelayMs);
                        }
                        await Task.Delay(Math.Max(keyDelayMs, 10));
                        break;
                    default:
                        throw new InvalidOperationException($"未対応の手順: {s.t}");
                }
                if (s.t == "text" && userField is not null && !string.IsNullOrEmpty(s.v)) userTyped = true;
            }
        }
        finally
        {
            if (imeWasOpen) SendMessage(imeWnd, WM_IME_CONTROL, (IntPtr)IMC_SETOPENSTATUS, (IntPtr)1);
        }
    }

    private static void EnsureForeground(IntPtr target)
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || GetAncestor(fg, GA_ROOT) != GetAncestor(target, GA_ROOT))
            throw new InvalidOperationException("入力先のウィンドウが切り替わったため、自動入力を中止しました。");
    }

    private static async Task WaitModifiersReleasedAsync()
    {
        int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C }; // Shift, Ctrl, Alt, 左右Win
        for (var i = 0; i < 60; i++)
        {
            if (mods.All(m => (GetAsyncKeyState(m) & 0x8000) == 0)) return;
            await Task.Delay(50);
        }
    }

    private static IntPtr FocusImeWindow(IntPtr target)
    {
        var tid = GetWindowThreadProcessId(target, out _);
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf<GUITHREADINFO>() };
        var focus = GetGUIThreadInfo(tid, ref info) && info.hwndFocus != IntPtr.Zero ? info.hwndFocus : target;
        return ImmGetDefaultIMEWnd(focus);
    }

    private static void SendVk(ushort vk, bool extended)
    {
        var scan = (ushort)MapVirtualKey(vk, 0);
        var flags = extended ? KEYEVENTF_EXTENDEDKEY : 0;
        Send(new[] { Key(vk, scan, flags), Key(vk, scan, flags | KEYEVENTF_KEYUP) });
    }

    private static void KeyDown(ushort vk) => Send(new[] { Key(vk, (ushort)MapVirtualKey(vk, 0), 0) });
    private static void KeyUp(ushort vk) => Send(new[] { Key(vk, (ushort)MapVirtualKey(vk, 0), KEYEVENTF_KEYUP) });

    private static void SendUnicode(char ch)
    {
        Send(new[] { Key(0, ch, KEYEVENTF_UNICODE), Key(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) });
    }

    private static INPUT Key(ushort vk, ushort scan, uint flags) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    private static void Send(INPUT[] inputs)
    {
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != inputs.Length)
            throw new InvalidOperationException("キー入力を送れませんでした（管理者権限で動いているアプリには入力できません）。");
    }

    public static List<Step> ParseSteps(JsonElement arr)
    {
        var list = new List<Step>();
        foreach (var e in arr.EnumerateArray())
        {
            list.Add(new Step
            {
                t = e.TryGetProperty("t", out var t) ? t.GetString() ?? "" : "",
                v = e.TryGetProperty("v", out var v) ? v.GetString() : null,
                ms = e.TryGetProperty("ms", out var ms) && ms.ValueKind == JsonValueKind.Number ? ms.GetInt32() : 0,
            });
        }
        return list;
    }
}
