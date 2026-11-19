using System.Drawing;
using static Kagibako.Native;

namespace Kagibako;

/// <summary>
/// 入力先のウィンドウ（ブラウザ）の上に、短い案内を数秒だけ出す。
/// 自動入力のあと Kagibako は最小化しているので、Kagibako の画面に出した案内は見えない。そのための吹き出し。
/// 入力位置（フォーカス）は奪わない（WS_EX_NOACTIVATE）。クリックすると消える。
/// </summary>
internal sealed class NoticeForm : Form
{
    private static NoticeForm? _current;
    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly string _text;
    private readonly bool _warn;

    private NoticeForm(string text, int ms, bool warn)
    {
        _text = text;
        _warn = warn;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(20, 35, 58);
        ForeColor = Color.White;
        Font = new Font("Yu Gothic UI", 11f, FontStyle.Regular, GraphicsUnit.Point);
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        _timer.Interval = Math.Clamp(ms, 1500, 30000);
        _timer.Tick += (_, _) => Close();
        Click += (_, _) => Close();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000 /* WS_EX_NOACTIVATE */ | 0x00000080 /* WS_EX_TOOLWINDOW */ | 0x00000008 /* WS_EX_TOPMOST */;
            return cp;
        }
    }

    private int Pad => LogicalToDeviceUnits(14);
    private int Bar => LogicalToDeviceUnits(5);

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var accent = _warn ? Color.FromArgb(232, 112, 56) : Color.FromArgb(216, 178, 90);
        using (var b = new SolidBrush(accent)) g.FillRectangle(b, 0, 0, Bar, Height);
        using (var p = new Pen(Color.FromArgb(44, 67, 100))) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        var textRect = new Rectangle(Bar + Pad, Pad, Width - Bar - Pad * 2, Height - Pad * 2);
        TextRenderer.DrawText(g, _text, Font, textRect, ForeColor, TextFormatFlags.WordBreak | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _timer.Stop();
        _timer.Dispose();
        if (_current == this) _current = null;
        base.OnFormClosed(e);
    }

    /// <summary>ウィンドウ target の下のほう中央に案内を出す（target が無ければ画面の下中央）</summary>
    public static void ShowNear(IntPtr target, string text, int ms, bool warn)
    {
        _current?.Close();
        var f = new NoticeForm(text, ms, warn);
        Rectangle area;
        if (target != IntPtr.Zero && IsWindow(target) && !IsIconic(target) && GetWindowRect(target, out var r))
            area = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        else
            area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        var screen = Screen.FromRectangle(area).WorkingArea;
        var visible = Rectangle.Intersect(area, screen);
        if (visible.Width < 200 || visible.Height < 100) visible = screen;

        // 文字に合わせた大きさ（横幅は最大 560px 相当で折り返す）
        var maxText = Math.Min(f.LogicalToDeviceUnits(560), visible.Width - f.LogicalToDeviceUnits(60));
        var size = TextRenderer.MeasureText(text, f.Font, new Size(maxText, int.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix);
        f.Size = new Size(size.Width + f.Bar + f.Pad * 2 + 2, size.Height + f.Pad * 2 + 2);
        f.Location = new Point(
            visible.Left + (visible.Width - f.Width) / 2,
            visible.Bottom - f.Height - f.LogicalToDeviceUnits(56));
        f.Show();
        f._timer.Start();
        _current = f;
    }
}
