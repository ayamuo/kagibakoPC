using System.Text;
using System.Windows.Automation;
using static Kagibako.Native;

namespace Kagibako;

/// <summary>
/// スマート入力：画面の中の ID 欄・パスワード欄を探して、そこへ入力位置（フォーカス）を移す。
/// Tab で移動しないので、欄の間にチェックボックスやリンクがあっても影響を受けない。
/// Windows の UI オートメーション（画面読み上げ用の仕組み）でブラウザのページ内の入力欄を調べる。
///
/// 注意：Chrome などは、ページの部品一覧を「外から最初に問い合わせたとき」に作り始める。
/// 最初の問い合わせではページの中身が空に見えることがあるので、ブラウザでは中身が見えるまで少し待つ。
/// </summary>
internal static class InputFields
{
    /// <summary>PasswordOnly … パスワード欄だけの画面（2段階ログインの2画面目）。ID 欄は無いので ID は入れない</summary>
    public enum Result { Moved, AlreadyThere, NotFound, Unavailable, PasswordOnly }
    private enum Probe { Moved, AlreadyThere, NotFound, NotReady, PasswordOnly }

    /// <summary>直前に ID 欄を探した画面に、パスワード欄があったか（無ければ「ID だけを先に入れる画面」）</summary>
    public static bool LastPageHadPassword { get; private set; } = true;

    /// <summary>直前に見つけた（入力位置を移した）欄。ID を打った後に、本当に入ったかを確かめるのに使う</summary>
    public static AutomationElement? LastField { get; private set; }

    /// <summary>ページの部品一覧ができるまで待つ最大時間（ブラウザのみ）</summary>
    private const int PageReadyWaitMs = 3000;

    /// <param name="kind">"user"（ID欄）または "password"（パスワード欄）</param>
    /// <param name="waitMs">欄が見つからないとき、現れるまで待つ時間（2段階のログイン画面のパスワード欄用）</param>
    public static Task<Result> FocusAsync(IntPtr window, string kind, int waitMs) => Task.Run(async () =>
    {
        var browser = IsBrowserWindow(window);
        var start = DateTime.UtcNow;
        var readyUntil = start.AddMilliseconds(browser ? Math.Max(waitMs, PageReadyWaitMs) : 0);
        var foundUntil = start.AddMilliseconds(waitMs);
        LastField = null;
        while (true)
        {
            Probe r;
            try { r = FocusOnce(window, kind, browser); }
            catch { return Result.Unavailable; }
            if (r == Probe.Moved) return Result.Moved;
            if (r == Probe.AlreadyThere) return Result.AlreadyThere;
            if (r == Probe.PasswordOnly) return Result.PasswordOnly;
            var now = DateTime.UtcNow;
            if (r == Probe.NotReady && now < readyUntil) { await Task.Delay(250); continue; }
            if (r == Probe.NotFound && now < foundUntil) { await Task.Delay(300); continue; }
            return Result.NotFound;
        }
    });

    /// <summary>ページの中を UI オートメーションで調べられるブラウザ（Chromium 系・Firefox 系）か</summary>
    public static bool IsBrowserWindow(IntPtr window)
    {
        var sb = new StringBuilder(256);
        if (GetClassName(window, sb, sb.Capacity) <= 0) return false;
        var cls = sb.ToString();
        return cls is "Chrome_WidgetWin_1" or "MozillaWindowClass";
    }

    // 文字を入れられる欄：ふつうの入力欄（Edit）に加え、候補一覧付きの欄（ComboBox）・数字の欄（Spinner）で書き込めるもの
    private static readonly Condition FieldTypes = new OrCondition(
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ComboBox),
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Spinner));

    private static bool IsWritable(AutomationElement e)
    {
        try
        {
            // 読み取り専用の欄（2画面目に表示されるだけの ID など）には入力できないので除く
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out var p)) return !((ValuePattern)p).Current.IsReadOnly;
            return e.Current.ControlType == ControlType.Edit;
        }
        catch { return false; }
    }

    private static Probe FocusOnce(IntPtr window, string kind, bool browser)
    {
        var root = AutomationElement.FromHandle(window);
        var focused = SafeFocused();
        var focusedInWindow = focused is not null && IsDescendantOf(focused, root);

        // ブラウザならページの中だけを探す（アドレスバー等のブラウザ自身の欄は対象外）
        var doc = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
        if (browser && doc is null) return Probe.NotReady; // ページの部品一覧がまだできていない
        var scope = doc ?? root;
        var edits = scope.FindAll(TreeScope.Descendants, new AndCondition(
            FieldTypes,
            new PropertyCondition(AutomationElement.IsEnabledProperty, true),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false)))
            .Cast<AutomationElement>().Where(IsWritable).ToList();
        if (browser && edits.Count == 0) return Probe.NotReady; // 入力欄がまだ見えない（読み込み中など）

        bool IsPassword(AutomationElement e) { try { return e.Current.IsPassword; } catch { return false; } }
        var focusedIndex = focusedInWindow ? edits.FindIndex(e => Automation.Compare(e, focused!)) : -1;

        if (kind == "password")
        {
            if (focusedIndex >= 0 && IsPassword(edits[focusedIndex])) { LastField = edits[focusedIndex]; return Probe.AlreadyThere; }
            // いまの入力欄より後ろにある最初のパスワード欄（なければ最初のパスワード欄）
            var target = edits.Skip(focusedIndex + 1).FirstOrDefault(IsPassword) ?? edits.FirstOrDefault(IsPassword);
            if (target is null) return Probe.NotFound;
            target.SetFocus();
            LastField = target;
            return Probe.Moved;
        }
        else
        {
            // 利用者がすでに ID 欄などの入力欄をクリックしていれば、それを尊重する
            if (focusedIndex >= 0 && !IsPassword(edits[focusedIndex])) { LastField = edits[focusedIndex]; LastPageHadPassword = edits.Any(IsPassword); return Probe.AlreadyThere; }
            var pw = edits.FindIndex(IsPassword);
            LastPageHadPassword = pw >= 0;
            if (pw == 0 && browser) return Probe.PasswordOnly; // パスワード欄より前に入力欄が無い＝パスワードだけの画面
            AutomationElement? target;
            if (pw > 0) target = edits.Take(pw).LastOrDefault(e => !IsPassword(e)); // パスワード欄の直前にある入力欄を ID 欄とみなす
            else if (pw < 0 && browser && edits.Count == 1) target = edits[0];      // ID だけを先に入れる画面（入力欄が1つだけ）
            else target = null;
            if (target is null) return Probe.NotFound;
            target.SetFocus();
            LastField = target;
            return Probe.Moved;
        }
    }

    /// <summary>欄に入っている文字の数（読めなければ -1）。パスワード欄は中身を読まない</summary>
    public static Task<int> ValueLengthAsync(AutomationElement field) => Task.Run(() =>
    {
        try
        {
            if (field.Current.IsPassword) return -1;
            return field.TryGetCurrentPattern(ValuePattern.Pattern, out var p) ? (((ValuePattern)p).Current.Value ?? "").Length : -1;
        }
        catch { return -1; }
    });

    private static AutomationElement? SafeFocused()
    {
        try { return AutomationElement.FocusedElement; } catch { return null; }
    }

    private static bool IsDescendantOf(AutomationElement e, AutomationElement root)
    {
        var walker = TreeWalker.ControlViewWalker;
        var cur = e;
        for (var i = 0; i < 200 && cur is not null; i++)
        {
            if (Automation.Compare(cur, root)) return true;
            try { cur = walker.GetParent(cur); } catch { return false; }
        }
        return false;
    }
}
